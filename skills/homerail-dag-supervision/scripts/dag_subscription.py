#!/usr/bin/env python3
"""Read-only DAG subscriptions. No model calls, DAG mutations, or shell commands.

SSE reconciles current state, not a lossless event journal. Queue acceptance and
consumer acknowledgment are separate. Unknown external deliveries never retry
automatically. Installed runtimes and receipts live outside candidate checkouts.
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
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from storage import save, save_text, process_identity

HERE = Path(__file__).resolve().parent
FILES = ('dag_subscription.py', 'storage.py')
TERMINAL = {'completed', 'failed', 'cancelled', 'expired'}
ACTIVE = {'active', 'pending', 'running', 'waiting', 'paused'}
MAX_RESPONSE = 262144
MAX_EVENTS = 2048


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def private(path):
    path = Path(path).expanduser()
    if path.is_symlink():
        raise ValueError('private storage must not be a symlink')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError('private storage must be owned by this user with mode 0700')
    return path.resolve()


@contextmanager
def lock(path, nonblocking=False):
    with Path(path).open('a') as handle:
        os.chmod(path, 0o600)
        fcntl.flock(handle, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
        yield


def clean_url(value):
    url = urllib.parse.urlsplit(value)
    if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in ('', '/')):
        raise ValueError('Manager URL must be an HTTP(S) origin without credentials/query/path')
    return value.rstrip('/')


def validate_spec(spec):
    allowed = {'version', 'manager_url', 'run_id', 'thread', 'notify_argv', 'admin_token_file',
               'timeout_seconds', 'quiet_seconds', 'unavailable_seconds', 'request_seconds', 'environment'}
    if not isinstance(spec, dict) or set(spec) - allowed or spec.get('version') != 1:
        raise ValueError('invalid subscription spec')
    spec = dict(spec)
    spec['manager_url'] = clean_url(spec['manager_url'])
    for name in ('run_id', 'thread'):
        if not isinstance(spec.get(name), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', spec[name]):
            raise ValueError('invalid ' + name)
    command = spec.get('notify_argv')
    if (not isinstance(command, list) or not command or len(command) > 32 or
            any(not isinstance(x, str) or not x or any(c in x for c in '\x00\n\r') for x in command)
            or not Path(command[0]).is_absolute()):
        raise ValueError('notify_argv requires an absolute executable and argument array')
    for name, default, minimum, maximum in [('timeout_seconds', 86400, 1, 604800),
                                           ('quiet_seconds', 1800, 1, 604800),
                                           ('unavailable_seconds', 180, 1, 3600),
                                           ('request_seconds', 30, 1, 120)]:
        value = spec.setdefault(name, default)
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError('invalid ' + name)
    token_file = spec.get('admin_token_file')
    if token_file is not None and (not isinstance(token_file, str) or not Path(token_file).is_absolute()):
        raise ValueError('admin_token_file must be an absolute private credential reference')
    env = spec.setdefault('environment', {})
    # Only search paths and Codex's configuration location may be persisted.
    if (not isinstance(env, dict) or set(env) - {'PATH', 'CODEX_HOME'} or
            any(not isinstance(v, str) or '\x00' in v or '\n' in v for v in env.values())):
        raise ValueError('only PATH and CODEX_HOME environment references are supported')
    return spec


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Manager redirect refused')


def request(spec, api_path):
    headers = {'Accept': 'text/event-stream' if api_path.endswith('/events') else 'application/json'}
    if spec.get('admin_token_file'):
        path = Path(spec['admin_token_file'])
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('admin credential reference must be an owned regular 0600 file')
        token = path.read_text().strip()
        if not token or any(c.isspace() for c in token):
            raise ValueError('invalid admin credential')
        headers['Authorization'] = 'Bearer ' + token
    url = spec['manager_url'] + api_path
    return urllib.request.build_opener(NoRedirect()).open(urllib.request.Request(url, headers=headers),
                                                       timeout=spec['request_seconds'])


def snapshot(value, run_id):
    if not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1:
        raise ValueError('unsupported observation protocol')
    identity = value.get('identity')
    keys = {'run_id', 'created_at', 'workflow_id', 'workflow_revision', 'canonical_hash', 'creation_request_digest'}
    if (not isinstance(identity, dict) or set(identity) != keys or identity['run_id'] != run_id
            or not isinstance(identity['created_at'], str) or not identity['created_at']):
        raise ValueError('invalid run identity')
    for field in ('workflow_id', 'canonical_hash', 'creation_request_digest'):
        if identity[field] is not None and (not isinstance(identity[field], str) or len(identity[field]) > 256):
            raise ValueError('invalid identity field')
    if identity['workflow_revision'] is not None and type(identity['workflow_revision']) is not int:
        raise ValueError('invalid workflow revision')
    status = value.get('status')
    if status not in TERMINAL | ACTIVE or type(value.get('terminal')) is not bool or value['terminal'] != (status in TERMINAL):
        raise ValueError('invalid terminal status')
    if type(value.get('waiting_for_command')) is not bool or value['waiting_for_command'] != (status == 'waiting'):
        raise ValueError('invalid waiting status')
    if value.get('round_id') is not None and (not isinstance(value['round_id'], str) or len(value['round_id']) > 200):
        raise ValueError('invalid round')
    for name in ('progress_digest', 'snapshot_digest'):
        if not isinstance(value.get(name), str) or not re.fullmatch('[0-9a-f]{64}', value[name]):
            raise ValueError('invalid observation digest')
    approvals = value.get('approvals')
    if not isinstance(approvals, list) or len(approvals) > 1000:
        raise ValueError('invalid approvals')
    for approval in approvals:
        if (not isinstance(approval, dict) or set(approval) != {'node_id', 'approval_id', 'proposal_hash'} or
                any(not isinstance(x, str) or not x or len(x) > 256 for x in approval.values())):
            raise ValueError('invalid approval identity')
    if value['terminal'] and approvals:
        raise ValueError('terminal run with pending approvals')
    # Return only declared fields: never persist arbitrary server text.
    return {k: value[k] for k in ('version', 'identity', 'status', 'terminal', 'round_id',
                                'waiting_for_command', 'approvals', 'progress_digest', 'snapshot_digest')}


def get_json(spec, api_path):
    with request(spec, api_path) as response:
        raw = response.read(MAX_RESPONSE + 1)
    if len(raw) > MAX_RESPONSE:
        raise ValueError('observation response too large')
    body = json.loads(raw)
    if not isinstance(body, dict) or body.get('success') is not True:
        raise ValueError('observation request failed')
    return body.get('data')


def fetch_snapshot(spec):
    # Existing HomeRail APIs only. Never store raw metadata/approval proposals.
    metadata = get_json(spec, '/api/runs/' + spec['run_id'])
    if (not isinstance(metadata, dict) or metadata.get('runId') != spec['run_id'] or
            type(metadata.get('createdAt')) not in (int, float) or not math.isfinite(metadata['createdAt']) or
            not isinstance(metadata.get('nodeStates'), dict)):
        raise ValueError('invalid Manager run metadata')
    status = metadata.get('status')
    if not isinstance(status, str) or status not in TERMINAL | ACTIVE:
        raise ValueError('invalid Manager run status')
    terminal = status in TERMINAL
    approval_body = {'approvals': []} if terminal else get_json(spec, '/api/dag/approvals')
    pending = approval_body.get('approvals') if isinstance(approval_body, dict) else None
    if not isinstance(pending, list) or any(not isinstance(a, dict) for a in pending):
        raise ValueError('invalid Manager approvals')
    approvals = [{k: a.get(k) for k in ('node_id', 'approval_id', 'proposal_hash')}
                 for a in pending if a.get('run_id') == spec['run_id'] and a.get('status') == 'waiting']
    current_round = metadata.get('currentRound') or {}
    if not isinstance(current_round, dict): raise ValueError('invalid Manager round')
    value = {'version': 1, 'identity': {'run_id': metadata['runId'], 'created_at': str(metadata['createdAt']),
             'workflow_id': metadata.get('workflowId'), 'workflow_revision': metadata.get('workflowRevision'),
             'canonical_hash': metadata.get('canonicalHash'), 'creation_request_digest': metadata.get('creationRequestDigest')},
             'status': status, 'terminal': terminal, 'round_id': current_round.get('round_id'),
             'waiting_for_command': status == 'waiting', 'approvals': approvals,
             'progress_digest': sha([metadata['nodeStates'], current_round, metadata.get('handoffedNodes')])}
    value['snapshot_digest'] = sha(value)
    return snapshot(value, spec['run_id'])


def quote(value):
    if any(c in value for c in '\r\n\x00'):
        raise ValueError('invalid service argument')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'


def systemctl(*args):
    return subprocess.run(['systemctl', '--user', *args], check=True, capture_output=True, text=True, timeout=30).stdout.strip()


def runtime(home):
    blobs = {name: (HERE / name).read_bytes() for name in FILES}
    hashes = {k: hashlib.sha256(v).hexdigest() for k, v in blobs.items()}
    root = private(home / 'runtimes')
    target = root / sha(hashes)
    if not target.exists():
        stage = Path(tempfile.mkdtemp(dir=root))
        try:
            for name, blob in blobs.items():
                with (stage / name).open('wb') as output:
                    output.write(blob); output.flush(); os.fsync(output.fileno())
            save(stage / 'manifest.json', hashes)
            os.rename(stage, target)
        finally:
            if stage.exists(): shutil.rmtree(stage)
    verify_runtime(target)
    return str(target)


def verify_runtime(path):
    path = Path(path)
    manifest = read(path / 'manifest.json')
    if set(manifest) != set(FILES) or sha(manifest) != path.name:
        raise ValueError('invalid frozen runtime')
    if any(hashlib.sha256((path / k).read_bytes()).hexdigest() != v for k, v in manifest.items()):
        raise ValueError('frozen runtime changed')


def unit_text(root, record):
    return ('[Unit]\nDescription=HomeRail DAG event subscription\nAfter=network-online.target\n'
            'StartLimitIntervalSec=0\n[Service]\nType=exec\nUMask=0077\n'
            f'ExecStart={quote(record["python"])} {quote(record["runtime"] + "/dag_subscription.py")} '
            f'run {quote(str(root))}\nRestart=on-failure\nRestartSec=10\n'
            'KillMode=control-group\nTimeoutStopSec=10\n[Install]\nWantedBy=default.target\n')


def load_record(root):
    record = read(root / 'registration.json')
    if sha(record['spec']) != record['spec_digest'] or record['id'] != root.name:
        raise ValueError('subscription registration changed')
    verify_runtime(record['runtime'])
    return record


def load_state(root, record):
    state = read(root / 'state.json')
    if state.get('spec_digest') != record['spec_digest']:
        raise ValueError('subscription state identity changed')
    return state


def install(home, spec, *, unit_dir=None, manage_service=True):
    spec = validate_spec(spec)
    home = private(home)
    if manage_service:
        linger = subprocess.check_output(['loginctl', 'show-user', str(os.getuid()), '-p', 'Linger', '--value'], text=True, timeout=10).strip()
        if linger != 'yes': raise ValueError('user lingering must already be enabled')
        systemctl('show-environment')
    jobs = private(home / 'subscriptions')
    key = sha([spec['manager_url'], spec['run_id'], spec['thread']])
    root = jobs / key
    with lock(home / 'registry.lock'):
        if root.exists():
            record = load_record(root)
            if record['spec'] != spec:
                raise ValueError('subscription already exists with another immutable spec')
        else:
            initial = fetch_snapshot(spec)  # Missing/old Manager: no partial registration or unit.
            stage = Path(tempfile.mkdtemp(prefix='.subscribe-', dir=jobs))
            try:
                record = {'id': key, 'spec': spec, 'spec_digest': sha(spec), 'identity': initial['identity'],
                          'runtime': runtime(home), 'python': str(Path(sys.executable).resolve()),
                          'service': 'homerail-dag-subscription-' + key + '.service',
                          'unit_dir': str(unit_dir or Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'systemd/user')}
                save(stage / 'registration.json', record)
                now = time.time()
                save(stage / 'state.json', {'spec_digest': record['spec_digest'], 'status': 'watching',
                     'created_at': now, 'deadline': now + spec['timeout_seconds'], 'last_progress_at': now,
                     'last_snapshot': None, 'conditions': {}, 'generations': {}, 'events': {}, 'unavailable_since': None})
                os.rename(stage, root)
            finally:
                if stage.exists(): shutil.rmtree(stage)
        # Preserve a stopped subscription and its evidence on repeated registration.
        state = load_state(root, record)
        unit = Path(record['unit_dir']) / record['service']
        unit.parent.mkdir(parents=True, exist_ok=True)
        content = unit_text(root, record)
        if unit.exists() and unit.read_text() != content:
            raise ValueError('refusing to replace an unowned service')
        if not unit.exists():
            save_text(unit, content)
        if manage_service and state['status'] == 'watching':
            systemctl('daemon-reload'); systemctl('enable', '--now', record['service'])
    return {'subscription_id': key, 'directory': str(root), 'service': record['service'],
            'status': state['status'], 'registered': True, 'model_may_end_turn': True}


def append_event(state, record, kind, occurrence, details):
    event_id = sha([record['id'], record['identity'], kind, occurrence])
    if event_id not in state['events']:
        event = {'event_id': event_id, 'subscription_id': record['id'], 'kind': kind,
                 'run_id': record['spec']['run_id'], 'identity': record['identity'], 'details': details}
        state['events'][event_id] = {'event': event, 'event_digest': sha(event), 'created_at': time.time(),
                                    'delivery': 'pending', 'attempts': [], 'ack': None}
    return event_id


def reconcile_snapshot(root, record, value, now=None):
    now = time.time() if now is None else now
    value = snapshot(value, record['spec']['run_id'])
    with lock(root / 'state.lock'):
        state = load_state(root, record)
        if state['status'] != 'watching': return state
        if value['identity'] != record['identity']:
            append_event(state, record, 'identity_mismatch', 'identity', {'run_outcome': 'unknown'})
            state['status'] = 'identity_mismatch'
        else:
            previous = state['last_snapshot']
            if previous is None or value['progress_digest'] != previous['progress_digest'] or value['status'] != previous['status']:
                state['last_progress_at'] = now
            state['last_snapshot'] = value
            state['unavailable_since'] = None
            conditions = {}
            if value['terminal']:
                conditions['terminal'] = ('terminal', value['status'], {'status': value['status'], 'round_id': value['round_id']})
                state['status'] = 'terminal'
            else:
                for approval in value['approvals']:
                    key = 'approval:' + sha(approval)
                    conditions[key] = ('approval_required', key, approval)
                if value['waiting_for_command'] and not value['approvals']:
                    key = 'command:' + sha([value['round_id'], value['progress_digest']])
                    conditions[key] = ('command_required', key, {'round_id': value['round_id']})
            active = {}
            for key, (kind, semantic, details) in conditions.items():
                generation = state['conditions'].get(key)
                if generation is None:
                    generation = state['generations'].get(key, 0) + 1
                    state['generations'][key] = generation
                active[key] = generation
                append_event(state, record, kind, [semantic, generation], details)
            state['conditions'] = active
        save(root / 'state.json', state)
        return state


def tick(root, record, *, error=False, now=None):
    now = time.time() if now is None else now
    with lock(root / 'state.lock'):
        state = load_state(root, record)
        if state['status'] != 'watching': return state
        if error and state['unavailable_since'] is None: state['unavailable_since'] = now
        if state['unavailable_since'] is not None:
            if now - state['unavailable_since'] >= record['spec']['unavailable_seconds']:
                append_event(state, record, 'observation_unavailable', state['unavailable_since'], {'run_outcome': 'unknown'})
        elif (not state['conditions'] and now - state['last_progress_at'] >= record['spec']['quiet_seconds']):
            append_event(state, record, 'quiet_timeout', state['last_progress_at'], {'run_outcome': 'unknown'})
        if now >= state['deadline']:
            append_event(state, record, 'observation_deadline', 'deadline', {'run_outcome': 'unknown'})
            state['status'] = 'observation_deadline'
        if len(state['events']) >= MAX_EVENTS:
            append_event(state, record, 'event_limit', 'limit', {'run_outcome': 'unknown'})
            state['status'] = 'event_limit'
        save(root / 'state.json', state)
        return state


def deliver(root, record, event_id, *, redeliver=False):
    with lock(root / 'state.lock'):
        state = load_state(root, record)
        entry = state['events'][event_id]
        if entry['event_digest'] != sha(entry['event']): raise ValueError('event changed')
        if entry['ack'] or state['status'] == 'unsubscribed': return
        if entry['delivery'] != 'pending' and not redeliver: return
        if entry['delivery'] == 'attempting':
            owner = entry['attempts'][-1]
            if process_identity(owner['pid']) == owner['process_identity']:
                raise ValueError('original notification sender still alive')
        if len(entry['attempts']) >= 3: raise ValueError('notification delivery budget exhausted')
        entry['delivery'] = 'attempting'
        attempt = {'pid': os.getpid(), 'process_identity': process_identity(os.getpid()), 'started_at': time.time()}
        entry['attempts'].append(attempt)
        save(root / 'state.json', state)
        # No server/model text is interpolated into a wake message.
        command = [record['python'], record['runtime'] + '/dag_subscription.py', '--home', str(root.parent.parent)]
        message = (f'[homerail-dag-event {event_id}] {entry["event"]["kind"]}. '
                   'Use $homerail-dag-supervision event consumption instructions. '
                   f'Subscription {record["id"]}; run {record["spec"]["run_id"]}. '
                   f'Read event with {shlex.join(command + ["event", record["id"], event_id])}. '
                   f'Verify event_digest {entry["event_digest"]} and current DAG identity, '
                   f'then acknowledge with {shlex.join(command + ["ack", record["id"], event_id, entry["event_digest"]])}. '
                   'Do not rerun the DAG or poll unchanged progress. Notification is not proof of task success.')
    try:
        result = subprocess.run(record['spec']['notify_argv'] + ['--thread', record['spec']['thread'], '--message', message],
                                env=dict(os.environ, **record['spec']['environment']),
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        outcome = 'accepted' if result.returncode == 0 else 'unknown'
        code = result.returncode
    except OSError:
        outcome, code = 'not_started', None
    except subprocess.TimeoutExpired:
        outcome, code = 'unknown', None
    with lock(root / 'state.lock'):
        state = load_state(root, record)
        entry = state['events'][event_id]
        entry['delivery'] = outcome
        entry['attempts'][-1].update(outcome=outcome, exit_code=code, finished_at=time.time())
        save(root / 'state.json', state)


def flush(root, record):
    for event_id, entry in load_state(root, record)['events'].items():
        if entry['delivery'] == 'pending' and not entry['ack']: deliver(root, record, event_id)


def acknowledge(root, event_id, event_digest):
    record = load_record(root)
    with lock(root / 'state.lock'):
        state = load_state(root, record)
        entry = state['events'][event_id]
        if sha(entry['event']) != event_digest or entry['event_digest'] != event_digest:
            raise ValueError('event digest does not match')
        if entry['ack'] is None:
            entry['ack'] = {'consumer': record['spec']['thread'], 'event_digest': event_digest, 'at': time.time()}
            save(root / 'state.json', state)
        return entry['ack']


def stream(spec):
    with request(spec, '/api/dag-status/' + spec['run_id'] + '/events') as response:
        if response.headers.get_content_type() != 'text/event-stream': raise ValueError('expected SSE')
        event, size = '', 0
        while True:
            raw = response.readline(MAX_RESPONSE + 1)
            if not raw: return
            size += len(raw)
            if size > MAX_RESPONSE: raise ValueError('SSE frame too large')
            line = raw.decode('utf8').rstrip('\r\n')
            if not line:
                # The event is just a hint. Replayed/stale payloads never become
                # decisions without reading the current authoritative state.
                if event == 'error': raise ValueError('Manager stream error')
                yield event
                event, size = '', 0
            elif line.startswith('event:'): event = line[6:].strip()
            elif line.startswith('data:'): pass  # Discard raw model/approval text.
            elif line.startswith(':'): pass
            elif line.startswith(('retry:', 'id:')): pass
            else: raise ValueError('unsupported SSE field')


def run(root):
    root = private(root)
    record = load_record(root)
    with lock(root / 'observer.lock', nonblocking=True):
        with lock(root / 'state.lock'):
            state = load_state(root, record)
            state['observer'] = {'pid': os.getpid(), 'process_identity': process_identity(os.getpid())}
            for entry in state['events'].values():
                if entry['delivery'] == 'attempting':
                    owner = entry['attempts'][-1]
                    if process_identity(owner['pid']) != owner['process_identity']:
                        entry['delivery'] = 'unknown'
            save(root / 'state.json', state)
        flush(root, record)
        backoff = 1
        while load_state(root, record)['status'] == 'watching':
            tick(root, record)
            flush(root, record)
            if load_state(root, record)['status'] != 'watching': break
            try:
                reconcile_snapshot(root, record, fetch_snapshot(record['spec']))
                flush(root, record)
                if load_state(root, record)['status'] != 'watching': break
                next_read = 0
                for event in stream(record['spec']):
                    if event and (time.monotonic() >= next_read or event in (
                            'dag:run_completed', 'dag:run_failed', 'dag:run_cancelled', 'dag:run_expired',
                            'dag:run_waiting', 'dag:approval_requested')):
                        reconcile_snapshot(root, record, fetch_snapshot(record['spec']))
                        next_read = time.monotonic() + 5
                    tick(root, record); flush(root, record)
                    if load_state(root, record)['status'] != 'watching': break
                else:
                    # End of stream is a reconnect, never proof the DAG ended.
                    pass
                backoff = min(backoff * 2, 15)
            except (OSError, ValueError, KeyError, urllib.error.URLError):
                tick(root, record, error=True); flush(root, record)
                backoff = min(backoff * 2, 15)
            if load_state(root, record)['status'] == 'watching': time.sleep(backoff)


def unsubscribe(root, *, manage_service=True):
    record = load_record(root)
    unit = Path(record['unit_dir']) / record['service']
    if unit.exists() and unit.read_text() != unit_text(root, record):
        raise ValueError('refusing to stop an unowned service')
    with lock(root / 'state.lock'):
        state = load_state(root, record)
        state['status'] = 'unsubscribed'
        save(root / 'state.json', state)
    if manage_service:
        systemctl('disable', '--now', record['service'])
    return {'subscription_id': record['id'], 'status': 'unsubscribed', 'dag_mutated': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', default=str(Path(os.environ.get('HOMERAIL_HOME', str(Path.home() / '.homerail'))) / 'dag-subscriptions'))
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('install')  # Spec arrives on stdin, not credential-bearing argv.
    for command in ('status', 'events', 'event', 'unsubscribe', 'run', 'ack', 'redeliver'):
        p = sub.add_parser(command); p.add_argument('subscription')
        if command in ('event', 'ack', 'redeliver'): p.add_argument('event_id')
        if command in ('ack', 'redeliver'): p.add_argument('event_digest')
    args = parser.parse_args()
    if args.command == 'install': result = install(Path(args.home), json.load(sys.stdin))
    elif args.command == 'run': run(Path(args.subscription)); return
    else:
        if not re.fullmatch('[0-9a-f]{64}', args.subscription): raise ValueError('invalid subscription ID')
        root = Path(args.home).expanduser().resolve() / 'subscriptions' / args.subscription
        record = load_record(root)
        if args.command == 'unsubscribe': result = unsubscribe(root)
        elif args.command == 'ack': result = acknowledge(root, args.event_id, args.event_digest)
        elif args.command == 'redeliver':
            state = load_state(root, record); entry = state['events'][args.event_id]
            if sha(entry['event']) != args.event_digest: raise ValueError('event digest does not match')
            deliver(root, record, args.event_id, redeliver=True)
            result = load_state(root, record)['events'][args.event_id]
        else:
            state = load_state(root, record)
            result = state['events'][args.event_id] if args.command == 'event' else state['events']
            if args.command == 'status':
                result = {k: state[k] for k in ('status', 'created_at', 'deadline', 'last_progress_at', 'unavailable_since')}
                result['unacknowledged_events'] = [key for key, entry in state['events'].items() if not entry['ack']]
                observer = state.get('observer', {})
                result['observer_alive'] = bool(observer.get('process_identity') and
                    process_identity(observer.get('pid')) == observer['process_identity'])
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        # HTTP/notification errors can contain credentials or provider text.
        print(json.dumps({'error': type(error).__name__, 'message': 'Subscription operation failed; inspect private state and configuration.'}), file=sys.stderr)
        sys.exit(1)
