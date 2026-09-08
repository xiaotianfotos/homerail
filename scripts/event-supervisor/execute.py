#!/usr/bin/env python3
"""Write the command result even if the observing supervisor exits.

This host process is not a model node. Its private directory must not be writable
by DAG workers. A machine crash may still leave an unknown outcome; never retry.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from supervise import environment, observe, process_identity, save, validate


def github_observation(root, target, code):
    """Preserve the adapter result in the hashed receipt, including read outages."""
    raw = (root / 'github-result.json').read_bytes()
    result = json.loads(raw)
    outcomes = {'success', 'workflow_failed', 'observation_unavailable',
                'observation_deadline', 'invalid_observation', 'stale_pr',
                'wrong_execution', 'unknown_status'}
    if not isinstance(result, dict) or result.get('outcome') not in outcomes:
        raise ValueError('invalid GitHub adapter result')
    if code != (0 if result['outcome'] == 'success' else 1):
        raise ValueError('GitHub adapter result differs from exit code')
    return {'target': target, 'result': result,
            'sha256': hashlib.sha256(raw).hexdigest()}


def execute(spec_path):
    raw = Path(spec_path).read_bytes()
    spec = json.loads(raw)
    root = Path(spec['event_dir'])
    expected = json.loads((root / 'execution.json').read_text())
    if expected['spec_digest'] != hashlib.sha256(raw).hexdigest():
        raise ValueError('spec changed after supervisor reservation; no command executed')
    with (root / 'runner.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        receipt_path = root / 'runner.json'
        if receipt_path.exists():
            raise RuntimeError('runner already has evidence; refuse second command execution')
        record = {'spec_digest': hashlib.sha256(raw).hexdigest(), 'status': 'starting',
                  'runner_pid': os.getpid(), 'runner_identity': process_identity(os.getpid()),
                  'started_at': time.time()}
        save(receipt_path, record)
        try:
            before = observe(spec)
            validate(spec, before)
            command = ([sys.executable, str(Path(__file__).with_name('watch_github.py')), str(spec_path)]
                       if 'github' in spec else spec['argv'])
            if 'github' in spec and (root / 'github-result.json').exists():
                raise ValueError('GitHub adapter result predates this execution')
            # stdout/stderr already point at the supervisor's private log file.
            child = subprocess.Popen(command, cwd=spec['cwd'], env=environment(spec))
            record.update(status='running', pid=child.pid, child_identity=process_identity(child.pid), before=before)
            save(receipt_path, record)
            code = child.wait()
            after = observe(spec)
            validate(spec, after)
            success = code == 0 and (not spec.get('task_root') or after['phase'] in spec['expected_phases'])
            outcome = 'needs_judger' if success else 'execution_failed'
            if 'github' in spec:
                after['github'] = github_observation(root, spec['github'], code)
                if code != 0:
                    outcome = after['github']['result']['outcome']
            record.update(status='finished', exit_code=code, after=after,
                          outcome=outcome, finished_at=time.time(),
                          log_digest=hashlib.sha256((root / 'execution.log').read_bytes()).hexdigest())
            save(receipt_path, record)
            return 0
        except Exception as exc:
            record.update(status='interrupted', error_type=type(exc).__name__)
            save(receipt_path, record)
            return 1


if __name__ == '__main__':
    sys.exit(execute(sys.argv[1]))
