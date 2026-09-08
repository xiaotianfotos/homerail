#!/usr/bin/env python3
"""Read-only, ordinary-program wait for ONE pinned GitHub workflow execution."""
import json
from pathlib import Path
import subprocess
import sys
import time
from supervise import save


def gh_get(endpoint):
    p = subprocess.run(['gh', 'api', endpoint], capture_output=True, text=True, timeout=30)
    if p.returncode:
        raise RuntimeError('GitHub read failed; exit code ' + str(p.returncode))
    return json.loads(p.stdout)


def check(spec, pr, run):
    # workflow_dispatch can run a default-branch workflow that reviews another
    # branch: bind workflow_head and pr_head independently, never conflate them.
    if pr['number'] != spec['pr'] or pr['state'] != 'open' or pr['head']['sha'] != spec['pr_head']:
        return 'stale_pr'
    if (run['id'] != spec['run_id'] or run['run_attempt'] != spec['run_attempt'] or
            run['head_sha'] != spec['workflow_head'] or run['path'] != spec['workflow_path']):
        return 'wrong_execution'
    if run['status'] == 'completed':
        return 'success' if run['conclusion'] == 'success' else 'workflow_failed'
    if run['status'] not in ('queued', 'in_progress', 'waiting', 'pending', 'requested'):
        return 'unknown_status'
    return None


def watch(spec, read=gh_get, sleep=time.sleep, now=time.monotonic):
    started = now()
    errors = 0
    while True:
        if now() - started > spec.get('maximum_wait_seconds', 7200):
            return {'outcome': 'observation_deadline', 'reason': 'No cancellation or restart performed.'}
        try:
            pr = read(f'repos/{spec["repo"]}/pulls/{spec["pr"]}')
            run = read(f'repos/{spec["repo"]}/actions/runs/{spec["run_id"]}')
        except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
            errors += 1
            if errors >= 3:
                return {'outcome': 'observation_unavailable', 'error_type': type(exc).__name__,
                        'reason': 'Three read failures. Workflow may still be running; do not restart.'}
            sleep(15 * errors)
            continue
        errors = 0
        try:
            outcome = check(spec, pr, run)
        except (KeyError, TypeError):
            return {'outcome': 'invalid_observation'}
        if outcome:
            return {'outcome': outcome, 'pr_head': pr['head']['sha'],
                    'run_id': run['id'], 'run_attempt': run['run_attempt'],
                    'workflow_head': run['head_sha'], 'status': run['status'],
                    'conclusion': run['conclusion'], 'url': run['html_url']}
        sleep(spec.get('poll_seconds', 30))


if __name__ == '__main__':
    spec = json.loads(Path(sys.argv[1]).read_text())
    result = watch(spec['github'])
    save(Path(spec['event_dir']) / 'github-result.json', result)
    print(json.dumps(result))
    sys.exit(0 if result['outcome'] == 'success' else 1)
