#!/usr/bin/env python3
"""Host-side execution/notification harness. No model calls while waiting.

One immutable job spec, one execution, durable events. Codex queue has no
idempotency key: an ambiguous delivery is retained for reconciliation, never
automatically sent again. It is NOT an exactly-once delivery guarantee.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def process_identity(pid):
    """Boot + kernel start ticks; PID alone is not an execution identity."""
    try:
        if type(pid) is not int or pid <= 0:
            return None
        stat = Path(f'/proc/{pid}/stat').read_text()
        fields = stat[stat.rfind(') ') + 2:].split()
        if fields[0] == 'Z':
            return None
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        return boot + ':' + fields[19]
    except (OSError, IndexError):
        return None


def interrupted_process(record):
    observed = process_identity(record.get('pid'))
    recorded = record.get('child_identity')
    return {'pid': record.get('pid'), 'recorded_identity': recorded,
            'observed_identity': observed,
            'same_process_alive': bool(recorded and observed == recorded),
            'identity_unknown': recorded is None}


def environment(spec):
    return dict(os.environ, **spec.get('environment', {}))


def save(path, value):
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf8') as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def notify(root, spec, kind, details):
    path = root / (kind + '.json')
    if path.exists():
        return json.loads(path.read_text())  # Including unknown delivery: do not resend.
    identity = hashlib.sha256(json.dumps([str(root.resolve()), spec['id'], kind]).encode()).hexdigest()
    event = {'event_id': identity, 'job': spec['id'], 'kind': kind,
             'details': details, 'created_at': time.time(), 'delivery': 'pending'}
    save(path, event)
    log_path = spec.get('execution_log', str(root / 'execution.log'))
    message = (f'[autofix-event {identity}] {spec["id"]}: {kind}. '
               f'可信执行证据：{path}；完整日志：{log_path}。'
               '请先核对本地事件、当前 round/plan/head，再执行 Judger 判断；'
               '复用已有结果，不因通知重复而重跑，不跟踪无变化状态。')
    # Persist before the external side effect. Crash here is deliberately ambiguous.
    event['delivery'] = 'attempting'
    save(path, event)
    try:
        result = subprocess.run(spec['queue_argv'] + ['--thread', spec['thread'],
                                '--message', message], capture_output=True,
                                text=True, timeout=20, env=environment(spec))
        event['delivery'] = 'queued' if result.returncode == 0 else 'unknown'
        event['queue_exit_code'] = result.returncode
        # Queue output can include local paths; keep it in the private event file only.
        event['queue_receipt'] = (result.stdout + result.stderr)[-2000:]
    except (OSError, subprocess.TimeoutExpired) as exc:
        event['delivery'] = 'unknown'
        event['delivery_error'] = type(exc).__name__
    save(path, event)
    return event


def observe(spec):
    snapshot = {}
    if spec.get('task_root'):
        state = json.loads((Path(spec['task_root']) / 'state.json').read_text())
        r = state['rounds'][-1]
        snapshot.update(phase=state['phase'], round=r['index'],
                        plan_digest=r['plan_digest'], candidate_commit=r.get('candidate_commit'))
    if spec.get('head'):
        snapshot['head'] = subprocess.check_output(['git', '-C', spec['repo_dir'], 'rev-parse', 'HEAD'],
                                                  text=True, timeout=15, env=environment(spec)).strip()
    return snapshot


def validate(spec, snapshot):
    if spec.get('task_root'):
        if any(snapshot[k] != spec[k] for k in ('round', 'plan_digest')):
            raise ValueError('stale job: current round/plan differs from immutable spec')
    if spec.get('head') and snapshot['head'] != spec['head']:
        raise ValueError('stale job: current repository head differs from immutable spec')


def promote_receipt(root, spec, record):
    """Caller holds the execution lock. Preserve original interruption evidence."""
    path = root / 'runner.json'
    if not path.exists():
        return None
    receipt = json.loads(path.read_text())
    if receipt.get('status') != 'finished':
        return None
    if receipt['spec_digest'] != record['spec_digest']:
        raise ValueError('runner receipt belongs to another spec')
    if hashlib.sha256((root / 'execution.log').read_bytes()).hexdigest() != receipt['log_digest']:
        raise ValueError('runner log differs from completed receipt')
    validate(spec, observe(spec))
    record.update(status='finished', exit_code=receipt['exit_code'], after=receipt['after'],
                  outcome=receipt['outcome'], finished_at=receipt['finished_at'],
                  runner_receipt_digest=hashlib.sha256(path.read_bytes()).hexdigest())
    save(root / 'execution.json', record)
    notify(root, spec, 'finished', record)
    return record


def rejoin_runner(root, spec, record):
    """Observe only the exact surviving host runner; never launch a replacement."""
    started = time.monotonic()
    while interrupted_process(record)['same_process_alive']:
        result = promote_receipt(root, spec, record)
        if result:
            return result
        if time.monotonic() - started >= spec.get('attention_after_seconds', 1800):
            notify(root, spec, 'timeout', {'pid': record['pid'],
                   'reason': 'Rejoined runner still alive; observation continues without rerun.'})
        time.sleep(.2)  # Ordinary process wait, no model calls or DAG dispatch.
    return promote_receipt(root, spec, record)


def main(spec_path, reconcile_only=False, expected_digest=None):
    spec_path = Path(spec_path).resolve()
    raw = spec_path.read_bytes()
    if expected_digest is not None and hashlib.sha256(raw).hexdigest() != expected_digest:
        raise ValueError('spec changed after registration validation; no command executed')
    spec = json.loads(raw)
    root = Path(spec['event_dir']).resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    digest = hashlib.sha256(raw).hexdigest()
    with open(root / 'lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        state_path = root / 'execution.json'
        if state_path.exists():
            old = json.loads(state_path.read_text())
            if old['spec_digest'] != digest:
                raise ValueError('job spec changed; do not reuse an execution directory')
            if old['status'] != 'finished':
                if not promote_receipt(root, spec, old):
                    notify(root, spec, 'interrupted', {'previous_execution': old,
                           'process_observation': interrupted_process(old),
                           'reason': 'Supervisor restarted; reconcile existing process/task before resuming. No command rerun.'})
                    recovered = rejoin_runner(root, spec, old)
                    if reconcile_only and not recovered:
                        return 75
            else:
                notify(root, spec, old.get('event_kind', 'finished'), old)
            return 0
        if reconcile_only:
            raise ValueError('no execution exists; reconcile cannot start a command')
        try:
            before = observe(spec)
            validate(spec, before)
            for argv in spec.get('preflight_argv', []):
                result = subprocess.run(argv, env=environment(spec), capture_output=True,
                                        text=True, timeout=20)
                if result.returncode:
                    raise RuntimeError('runtime preflight failed: ' + argv[0])
        except Exception as exc:
            record = {'spec_digest': digest, 'status': 'finished', 'event_kind': 'preflight_failed',
                      'outcome': 'preflight_failed', 'error_type': type(exc).__name__,
                      'finished_at': time.time()}
            save(state_path, record)
            notify(root, spec, 'preflight_failed', record)
            return 1
        record = {'spec_digest': digest, 'status': 'starting', 'started_at': time.time(),
                  'before': before, 'supervisor_identity': process_identity(os.getpid())}
        save(state_path, record)
        try:
            with open(root / 'execution.log', 'a') as log:
                os.chmod(root / 'execution.log', 0o600)
                command = [sys.executable, str(Path(__file__).with_name('execute.py')), str(spec_path)]
                child = subprocess.Popen(command, cwd=spec['cwd'], stdout=log,
                                         stderr=subprocess.STDOUT, start_new_session=True,
                                         env=environment(spec))
                record.update(status='running', pid=child.pid, child_identity=process_identity(child.pid))
                save(state_path, record)
                try:
                    code = child.wait(timeout=spec.get('attention_after_seconds', 1800))
                except subprocess.TimeoutExpired:
                    notify(root, spec, 'timeout', {'pid': child.pid,
                           'reason': 'Exceeded attention deadline. Process remains alive; do not start duplicate work.'})
                    code = child.wait()  # OS wait, no inference or API polling.
            result = promote_receipt(root, spec, record)
            if not result:
                raise RuntimeError('runner exited without a completed receipt; outcome unknown')
            return 0 if result['outcome'] == 'needs_judger' else 1
        except Exception as exc:
            record.update(status='interrupted', error=str(exc)[:1000])
            save(state_path, record)
            notify(root, spec, 'interrupted', record)
            return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], '--reconcile-only' in sys.argv[2:]))
