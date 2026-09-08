#!/usr/bin/env python3
"""Install and manage immutable, Linux user-systemd event supervisors.

No shell interpretation, model polling, automatic job retry, or credential setup.
Runtime versions, registration history and execution evidence survive uninstall.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

from supervise import save, interrupted_process

HERE = Path(__file__).resolve().parent
MODULES = ('durable.py', 'supervise.py', 'watch_github.py', 'execute.py')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


@contextmanager
def locked(path, nonblocking=False):
    with Path(path).open('a') as handle:
        os.chmod(path, 0o600)
        fcntl.flock(handle, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
        yield


def absolute(value):
    if not isinstance(value, str) or not value or not Path(value).is_absolute():
        raise ValueError('paths must be nonempty absolute strings')
    if any(c in value for c in '\n\r\x00'):
        raise ValueError('line breaks/NUL forbidden in paths')
    return Path(value).resolve()


def argv(value):
    if (not isinstance(value, list) or not value or
            any(not isinstance(v, str) or not v or '\x00' in v for v in value)):
        raise ValueError('argv must be a nonempty array of nonempty strings')


def validate_spec(spec):
    if not isinstance(spec, dict):
        raise ValueError('spec must be an object')
    for field in ('id', 'thread'):
        if (not isinstance(spec.get(field), str) or not spec[field].strip() or
                len(spec[field]) > 200 or any(c in spec[field] for c in '\n\r\x00')):
            raise ValueError('invalid ' + field)
    for field in ('event_dir', 'cwd'):
        absolute(spec.get(field))
    argv(spec.get('queue_argv'))
    if 'github' in spec:
        g = spec['github']
        if not isinstance(g, dict) or not re.fullmatch(r'[\w.-]+/[\w.-]+', g.get('repo', '')):
            raise ValueError('invalid GitHub repository')
        for field in ('pr', 'run_id', 'run_attempt'):
            if type(g.get(field)) is not int or g[field] <= 0:
                raise ValueError('invalid GitHub ' + field)
        for field in ('pr_head', 'workflow_head'):
            if not re.fullmatch('[0-9a-f]{40}', g.get(field, '')):
                raise ValueError('GitHub heads must be full lowercase commit SHAs')
        if not isinstance(g.get('workflow_path'), str) or not g['workflow_path'].startswith('.github/workflows/'):
            raise ValueError('invalid GitHub workflow path')
        if 'argv' in spec:
            raise ValueError('GitHub observation uses the installed read-only adapter, omit argv')
    else:
        argv(spec.get('argv'))
        if not isinstance(spec.get('execution_id'), str) or not spec['execution_id'].strip():
            raise ValueError('command jobs require a stable execution_id independent of label/destination')
    env = spec.get('environment', {})
    if not isinstance(env, dict) or any(not isinstance(k, str) or not isinstance(v, str) or
                                       '=' in k or '\x00' in k + v for k, v in env.items()):
        raise ValueError('environment must contain string names and values')
    for command in spec.get('preflight_argv', []):
        argv(command)
    for values, names in [(spec, ('attention_after_seconds',)),
                          (spec.get('github', {}), ('poll_seconds', 'maximum_wait_seconds'))]:
        for name in names:
            if name in values and (type(values[name]) not in (int, float) or
                                   not math.isfinite(values[name]) or values[name] <= 0):
                raise ValueError(name + ' must be finite and positive')
    if 'task_root' in spec:
        absolute(spec['task_root'])
        if type(spec.get('round')) is not int or spec['round'] <= 0 or not spec.get('plan_digest'):
            raise ValueError('task observation requires round and plan_digest')
        phases = spec.get('expected_phases')
        if not isinstance(phases, list) or not phases or any(not isinstance(x, str) for x in phases):
            raise ValueError('task observation requires expected_phases')
    if 'head' in spec:
        absolute(spec.get('repo_dir'))
        if not re.fullmatch('[0-9a-f]{40}', spec['head']):
            raise ValueError('head must be a full lowercase SHA')


def execution_key(spec):
    if 'github' in spec:
        g = spec['github']
        identity = ['github', g['repo'].lower(), g['pr'], g['run_id'], g['run_attempt'],
                    g['workflow_head'], g['pr_head'], g['workflow_path']]
    else:
        identity = ['command', spec['execution_id']]
    return digest(json.dumps(identity, separators=(',', ':')).encode())


def freeze_runtime(home, source=HERE):
    blobs = {name: (Path(source) / name).read_bytes() for name in MODULES}
    manifest = {name: digest(blob) for name, blob in blobs.items()}
    version = digest(json.dumps(manifest, sort_keys=True).encode())
    versions = home / 'runtimes'
    versions.mkdir(mode=0o700, exist_ok=True)
    target = versions / version
    if not target.exists():
        stage = Path(tempfile.mkdtemp(prefix='.install-', dir=versions))
        try:
            for name, blob in blobs.items():
                with (stage / name).open('wb') as output:
                    output.write(blob)
                    output.flush()
                    os.fsync(output.fileno())
            save(stage / 'manifest.json', manifest)
            os.rename(stage, target)
            fd = os.open(versions, os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    verify_runtime(target)
    return target


def verify_runtime(runtime):
    manifest = read(runtime / 'manifest.json')
    if set(manifest) != set(MODULES) or digest(json.dumps(manifest, sort_keys=True).encode()) != runtime.name:
        raise ValueError('invalid runtime manifest')
    for name, expected in manifest.items():
        if digest((runtime / name).read_bytes()) != expected:
            raise ValueError('installed runtime changed: ' + name)


def quote_systemd(value):
    if any(c in value for c in '\n\r\x00'):
        raise ValueError('line breaks/NUL forbidden in service arguments')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'


def unit_text(record_path, record):
    return ('[Unit]\nDescription=HomeRail durable event supervisor\n[Service]\nType=exec\n'
            f'ExecStart={quote_systemd(record["python"])} '
            f'{quote_systemd(str(Path(record["runtime"]) / "durable.py"))} run '
            f'{quote_systemd(str(record_path))}\n'
            'UMask=0077\nRestart=on-failure\nRestartSec=10s\nKillMode=process\n'
            'TimeoutStopSec=10s\n[Install]\nWantedBy=default.target\n')


def write_unit(path, content):
    fd, tmp = tempfile.mkstemp(prefix='.homerail-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def systemctl(*args):
    return subprocess.run(['systemctl', '--user', *args], check=True,
                          capture_output=True, text=True, timeout=30).stdout.strip()


def prerequisites():
    if sys.platform != 'linux':
        raise RuntimeError('event supervision currently requires Linux user systemd')
    linger = subprocess.check_output(['loginctl', 'show-user', str(os.getuid()),
                                     '--property=Linger', '--value'], text=True, timeout=15).strip()
    if linger != 'yes':
        raise RuntimeError('user linger must be enabled before installation')
    systemctl('show-environment')  # Verify user-manager access; never print its contents.


def event_root(record):
    root = absolute(record['spec']['event_dir'])
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return root


def assert_idle(record):
    state = systemctl('show', record['unit'], '--property=ActiveState', '--value')
    if state not in ('inactive', 'failed'):
        raise RuntimeError('service is active or unknown; preserve it and reconcile before lifecycle changes')
    root = event_root(record)
    if (root / 'execution.json').exists():
        execution = read(root / 'execution.json')
        if execution['status'] != 'finished' or interrupted_process(execution)['same_process_alive']:
            raise RuntimeError('execution is unfinished; reconcile before lifecycle changes')


def register(spec_path, home, unit_dir):
    """Caller owns the registry lock through systemd enable/start."""
    spec_path = absolute(str(spec_path))
    raw = spec_path.read_bytes()
    spec = json.loads(raw)
    validate_spec(spec)
    key = execution_key(spec)
    registry = home / 'registrations'
    registry.mkdir(mode=0o700, exist_ok=True)
    unit_dir.mkdir(parents=True, exist_ok=True)
    record_path = registry / (key + '.json')
    root = absolute(spec['event_dir'])
    for other in registry.glob('*.json'):
        previous = read(other)
        if absolute(previous['spec']['event_dir']) == root and previous['key'] != key:
            raise ValueError('event directory already belongs to another execution')
    if record_path.exists():
        record = read(record_path)
        if record['spec_digest'] != digest(raw) or record['spec_path'] != str(spec_path):
            raise ValueError('execution already registered with a different immutable spec')
    else:
        if root.exists() and any(root.iterdir()):
            raise ValueError('legacy/nonempty event directory requires explicit reconciliation; use a new directory')
        runtime = freeze_runtime(home)
        record = {'version': 1, 'key': key, 'unit': 'homerail-event-' + key + '.service',
                  'spec': spec, 'spec_path': str(spec_path), 'spec_digest': digest(raw),
                  'runtime': str(runtime), 'python': str(Path(sys.executable).resolve()),
                  'lifecycle': 'installed', 'history': [], 'created_at': time.time()}
        save(record_path, record)
    target = unit_dir / record['unit']
    content = unit_text(record_path, record)
    if target.exists() and target.read_text() != content:
        raise ValueError('existing unit differs; use upgrade after reconciliation')
    # A tombstone must be restored explicitly by the same spec, not by a boot.
    if record['lifecycle'] == 'uninstalled':
        record['history'].append({'action': 'reinstall', 'at': time.time()})
        record['lifecycle'] = 'installed'
        save(record_path, record)
    if not target.exists():
        write_unit(target, content)
    return record_path, record


def lifecycle(action, record_path, unit_dir, source=HERE):
    record = read(record_path)
    root = event_root(record)
    with locked(root / 'lock', nonblocking=True):
        assert_idle(record)
        target = unit_dir / record['unit']
        expected = unit_text(record_path, record)
        if target.exists() and target.read_text() not in (expected, record.get('previous_unit_text')):
            raise ValueError('unit was externally modified; refusing lifecycle mutation')
        if action == 'uninstall':
            # Persist the tombstone first: an old unit racing a reboot cannot run.
            record['lifecycle'] = 'uninstalled'
            record['history'].append({'action': action, 'at': time.time()})
            save(record_path, record)
            if target.exists():
                systemctl('disable', record['unit'])
            target.unlink(missing_ok=True)
        else:
            if record['lifecycle'] != 'installed':
                raise ValueError('reinstall the original spec before upgrading')
            runtime = freeze_runtime(record_path.parent.parent, source)
            record['history'].append({'action': action, 'at': time.time(),
                                      'previous_runtime': record['runtime']})
            record['previous_unit_text'] = target.read_text() if target.exists() else expected
            record['runtime'] = str(runtime)
            # Record first, then unit. An interrupted update is repaired by
            # repeating upgrade; run refuses mismatching runtime generations.
            save(record_path, record)
            write_unit(target, unit_text(record_path, record))
            record.pop('previous_unit_text', None)
            save(record_path, record)
        systemctl('daemon-reload')
    return record


def run(record_path, reconcile_only=False):
    record = read(record_path)
    if record['lifecycle'] != 'installed':
        return 0
    root = event_root(record)
    try:
        verify_runtime(Path(record['runtime']))
        if HERE != Path(record['runtime']):
            raise ValueError('service runtime generation differs from registration')
        raw = Path(record['spec_path']).read_bytes()
        if digest(raw) != record['spec_digest'] or execution_key(json.loads(raw)) != record['key']:
            raise ValueError('registered spec changed')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        from supervise import notify
        with locked(root / 'lock'):
            notify(root, record['spec'], 'registration_invalid',
                   {'reason': 'Registered spec/runtime missing or changed; no command executed.',
                    'error_type': type(exc).__name__})
        return 1 if reconcile_only else 0
    from supervise import main
    try:
        return main(Path(record['spec_path']), reconcile_only=reconcile_only)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        from supervise import notify
        with locked(root / 'lock'):
            notify(root, record['spec'], 'evidence_invalid',
                   {'reason': 'Existing evidence cannot be reconciled; no command retry.',
                    'error_type': type(exc).__name__})
        return 1 if reconcile_only else 0


def status(record_path):
    record = read(record_path)
    root = Path(record['spec']['event_dir'])
    execution = read(root / 'execution.json') if (root / 'execution.json').exists() else None
    return {'key': record['key'], 'unit': record['unit'], 'lifecycle': record['lifecycle'],
            'runtime': record['runtime'], 'event_dir': str(root),
            'execution': execution, 'process': interrupted_process(execution) if execution else None,
            'events': [{k: event.get(k) for k in ('event_id', 'kind', 'delivery')}
                       for p in sorted(root.glob('*.json'))
                       if (event := read(p)).get('event_id')]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    default_home = Path(os.environ.get('HOMERAIL_HOME', str(Path.home() / '.homerail'))) / 'event-supervision'
    parser.add_argument('--home', type=Path, default=default_home)
    parser.add_argument('--unit-dir', type=Path, default=Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'systemd/user')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('install').add_argument('spec')
    for name in ('status', 'upgrade', 'uninstall', 'run', 'reconcile'):
        command = sub.add_parser(name)
        command.add_argument('registration')
        if name == 'run':
            command.add_argument('--reconcile-only', action='store_true')
        if name == 'upgrade':
            command.add_argument('--source', type=Path, default=HERE,
                                 help='Reviewed runtime directory; retained runtime allowed for rollback')
    args = parser.parse_args()
    if args.command == 'run':
        return run(Path(args.registration).resolve(), args.reconcile_only)
    if args.command == 'status':
        print(json.dumps(status(Path(args.registration).resolve())))
        return 0
    if args.command == 'reconcile':
        # Use the pinned version; only inspect/promote existing trusted evidence.
        record = read(args.registration)
        verify_runtime(Path(record['runtime']))
        return subprocess.run([record['python'], str(Path(record['runtime']) / 'durable.py'), 'run',
                               str(Path(args.registration).resolve()), '--reconcile-only'], check=False).returncode
    prerequisites()
    home = args.home.resolve()
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    with locked(home / 'registry.lock'):
        if args.command == 'install':
            path, record = register(args.spec, home, args.unit_dir.resolve())
            systemctl('daemon-reload')
            systemctl('enable', '--now', record['unit'])
        else:
            path = Path(args.registration).resolve()
            if path.parent != home / 'registrations':
                raise ValueError('registration is outside --home')
            record = lifecycle(args.command, path, args.unit_dir.resolve(), getattr(args, 'source', HERE))
        print(json.dumps({'registration': str(path), 'unit': record['unit'],
                          'lifecycle': record['lifecycle'], 'runtime': record['runtime']}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(type(exc).__name__ + ': ' + str(exc), file=sys.stderr)
        sys.exit(1)
