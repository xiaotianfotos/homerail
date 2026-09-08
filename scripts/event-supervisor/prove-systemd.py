#!/usr/bin/env python3
"""Opt-in real user-systemd proof; requires a NEW private output directory.

Runs one harmless fixture, kills only its supervisor, retains all evidence, then
uninstalls its own unit. Notification transport is a local fixture, not Codex.
No Manager, model, PR, production service, or whole-host reboot is involved.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import durable
from supervise import save


def wait_for(check, timeout=35):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = check()
        if result:
            return result
        time.sleep(.1)
    raise TimeoutError('proof condition did not become true')


def proof(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    home = root / 'home'
    prefix = [sys.executable, str(durable.HERE / 'durable.py'), '--home', str(home)]

    def cli(*args):
        result = subprocess.run(prefix + list(map(str, args)), capture_output=True, text=True, timeout=40)
        with (root / 'commands.log').open('a') as log:
            log.write(json.dumps({'command': args, 'exit_code': result.returncode,
                                  'stdout': result.stdout, 'stderr': result.stderr}, default=str) + '\n')
        if result.returncode:
            raise RuntimeError('lifecycle command failed: ' + result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else None

    job = root / 'fixture.py'
    job.write_text("""from pathlib import Path
import time
root = Path(__file__).parent
with (root / 'executions').open('a') as f: f.write('run\\n')
deadline = time.monotonic() + 100
while not (root / 'allow-finish').exists():
    if time.monotonic() > deadline: raise RuntimeError('fixture deadline')
    time.sleep(.05)
""")
    queue = root / 'queue.py'
    queue.write_text("""from pathlib import Path
import sys,json
with Path(__file__).with_name('notifications.jsonl').open('a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
""")
    spec = {'id': 'durable-systemd-proof', 'execution_id': str(root), 'thread': 'local-fixture',
            'event_dir': str(root / 'events'), 'cwd': str(root),
            'argv': [sys.executable, str(job)], 'queue_argv': [sys.executable, str(queue)],
            'attention_after_seconds': 90}
    spec_path = root / 'spec.json'
    save(spec_path, spec)
    registration = None
    try:
        installed = cli('install', spec_path)
        registration = Path(installed['registration'])
        unit = installed['unit']
        wait_for(lambda: (root / 'executions').exists())
        initial = durable.read(root / 'events/execution.json')
        assert initial['status'] == 'running'
        enabled = durable.systemctl('is-enabled', unit)
        durable.systemctl('kill', '--kill-whom=main', '--signal=SIGKILL', unit)

        def interrupted():
            path = root / 'events/interrupted.json'
            return path.exists() and durable.read(path)['delivery'] == 'queued'

        wait_for(interrupted)
        event = durable.read(root / 'events/interrupted.json')
        assert event['details']['process_observation']['same_process_alive']
        (root / 'allow-finish').touch()

        def completed():
            path = root / 'events/finished.json'
            return path.exists() and durable.read(path)['delivery'] == 'queued'

        wait_for(completed)
        wait_for(lambda: durable.systemctl('show', unit, '--property=ActiveState', '--value') == 'inactive')
        assert durable.read(root / 'events/execution.json')['exit_code'] == 0
        cli('upgrade', registration)
        cli('uninstall', registration)
        cli('install', spec_path)
        wait_for(lambda: durable.systemctl('show', unit, '--property=ActiveState', '--value') == 'inactive')
        cli('uninstall', registration)
        assert (root / 'executions').read_text() == 'run\n'
        assert len((root / 'notifications.jsonl').read_text().splitlines()) == 2
        assert durable.read(registration)['lifecycle'] == 'uninstalled'
        result = {'verdict': 'pass', 'enabled_before_kill': enabled,
                  'executions': 1, 'interruption_events': 1, 'completion_events': 1,
                  'supervisor_killed': True, 'same_runner_rejoined': True,
                  'upgrade_uninstall_reinstall_passed': True, 'model_calls': 0,
                  'notification_transport': 'local fixture; no actual task delivery claimed',
                  'whole_host_reboot': False, 'registration': str(registration),
                  'source_hashes': {name: hashlib.sha256((durable.HERE / name).read_bytes()).hexdigest()
                                    for name in durable.MODULES}}
        save(root / 'result.json', result)
        print(json.dumps(result))
    finally:
        # Let only our fixture finish on an assertion failure. Keep evidence and
        # any unverified unit for diagnosis instead of killing unknown work.
        (root / 'allow-finish').touch()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=lambda value: Path(value).resolve())
    args = parser.parse_args()
    proof(args.directory)
