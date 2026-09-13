"""Opt-in Linux integration proof; no production endpoints or model execution.

python3 check_integration.py --evidence /absolute/private/directory
Optionally --thread CURRENT_TASK --codex /absolute/path/to/codex sends ONE real
notification to that task. Receipt ACK must then be performed by the consumer.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

import dag_subscription as d


def eventually(check, timeout=35):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value: return value
        time.sleep(.2)  # Fixture driver only; no model invocations.
    raise AssertionError('integration condition timed out')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--thread')
    parser.add_argument('--codex')
    args = parser.parse_args()
    if bool(args.thread) != bool(args.codex): parser.error('--thread and --codex must be paired')
    root = d.private(Path(args.evidence))
    fixture = d.private(root / 'manager')
    if (fixture / 'ready.json').exists(): raise ValueError('use a fresh evidence directory')
    log = (root / 'manager.log').open('w')
    # No production credentials or HomeRail environment are passed to the fixture.
    env = {key: os.environ[key] for key in ('HOME', 'PATH', 'LANG') if key in os.environ}
    manager = subprocess.Popen([shutil.which('node'), str(d.HERE / 'manager_fixture.mjs'), str(fixture)],
                               env=env, stdout=log, stderr=log, start_new_session=True)
    registration = None
    try:
        def manager_ready():
            if manager.poll() is not None: raise AssertionError('fixture exited; inspect manager.log')
            return d.read(fixture / 'ready.json') if (fixture / 'ready.json').exists() else None
        ready = eventually(manager_ready)
        spec = {'version': 1, 'manager_url': ready['manager_url'], 'run_id': ready['run_id'],
                'thread': args.thread or 'integration-test',
                'notify_argv': [args.codex, 'queue'] if args.codex else ['/bin/true'],
                'quiet_seconds': 60, 'timeout_seconds': 110, 'request_seconds': 2,
                'environment': {'PATH': os.environ['PATH']}}
        store = root / 'observer'
        cli = [sys.executable, str(d.HERE / 'dag_subscription.py'), '--home', str(store)]
        # This registering process exits; systemd owns the continuing observer.
        registration = json.loads(subprocess.check_output(cli + ['install'], input=json.dumps(spec).encode()))
        job = Path(registration['directory']); record = d.load_record(job)
        def observer():
            value = d.load_state(job, record).get('observer', {})
            return value if value.get('process_identity') == d.process_identity(value.get('pid')) and value.get('pid') else None
        first = eventually(observer)
        eventually(lambda: d.load_state(job, record)['last_snapshot'])
        assert not d.load_state(job, record)['events'], 'ordinary running state must stay quiet'
        os.kill(first['pid'], signal.SIGKILL)
        second = eventually(lambda: value if (value := observer()) and value != first else None)
        assert d.systemctl('is-enabled', record['service']) == 'enabled'
        workspace = fixture / 'workspace' / ready['run_id']
        eventually(lambda: (workspace / 'count').exists())
        (workspace / 'release').touch()
        def delivered():
            entries = d.load_state(job, record)['events']
            return entries if entries and all(e['delivery'] not in ('pending', 'attempting') for e in entries.values()) else None
        entries = eventually(delivered)
        assert len(entries) == 1, entries
        entry = next(iter(entries.values()))
        assert entry['event']['kind'] == 'terminal' and entry['event']['details']['status'] == 'completed'
        assert entry['delivery'] == 'accepted', entry['delivery']
        assert (workspace / 'count').read_text() == 'x', 'DAG command must execute once'
        assert d.fetch_snapshot(spec)['status'] == 'completed'
        proof = {'passed': True, 'real_manager_routes_and_executor': True, 'model_calls_by_fixture': 0,
                 'controller_exited': True, 'service_restarted_after_sigkill': True,
                 'observer_before': first, 'observer_after': second, 'ordinary_progress_notifications': 0,
                 'terminal_notifications': 1, 'dag_command_executions': 1,
                 'real_codex_transport': bool(args.codex), 'consumer_ack_verified': False,
                 'host_reboot_tested': False, 'registration': registration,
                 'event_id': entry['event']['event_id'], 'event_digest': entry['event_digest']}
        if not args.codex:
            d.acknowledge(job, proof['event_id'], proof['event_digest'])
            proof['consumer_ack_verified'] = True
        d.save(root / 'proof.json', proof)
        print(json.dumps(proof))
    finally:
        # Release any detached deterministic command even after a failed check.
        workspace = fixture / 'workspace' / 'skill-listener-proof'
        if workspace.is_dir(): (workspace / 'release').touch()
        if registration:
            d.unsubscribe(Path(registration['directory']))
        try: os.killpg(manager.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: manager.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(manager.pid, signal.SIGKILL); manager.wait()
        log.close()


if __name__ == '__main__': main()
