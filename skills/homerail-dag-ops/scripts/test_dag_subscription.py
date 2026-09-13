"""Run: python3 -m unittest discover -s <skill>/scripts -p 'test_*.py' -v."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import dag_subscription as d


def observation(status='active', approvals=None):
    value = {'version': 1, 'identity': {'run_id': 'run-test', 'created_at': '1000',
             'workflow_id': 'test', 'workflow_revision': 1, 'canonical_hash': 'a' * 64,
             'creation_request_digest': None}, 'status': status, 'terminal': status in d.TERMINAL,
             'round_id': None, 'waiting_for_command': status == 'waiting', 'approvals': approvals or [],
             'progress_digest': d.sha('progress'), 'snapshot_digest': d.sha(status)}
    return value


class SubscriptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / 'store'
        self.unit_dir = Path(self.temp.name) / 'units'
        self.spec = {'version': 1, 'manager_url': 'http://127.0.0.1:9999', 'run_id': 'run-test',
                     'thread': 'task-test', 'notify_argv': ['/bin/true'], 'quiet_seconds': 20,
                     'unavailable_seconds': 5, 'timeout_seconds': 100}
        with patch.object(d, 'fetch_snapshot', return_value=observation()):
            self.receipt = d.install(self.home, self.spec, unit_dir=self.unit_dir, manage_service=False)
        self.root = Path(self.receipt['directory'])
        self.record = d.load_record(self.root)

    def state(self): return d.load_state(self.root, self.record)

    def terminal(self):
        state = d.reconcile_snapshot(self.root, self.record, observation('completed'))
        return next(iter(state['events']))

    def test_registration_is_idempotent_and_freezes_runtime(self):
        with patch.object(d, 'fetch_snapshot', side_effect=AssertionError('must not reregister')):
            again = d.install(self.home, self.spec, unit_dir=self.unit_dir, manage_service=False)
            self.assertEqual(again, self.receipt)
            with self.assertRaises(ValueError):
                d.install(self.home, dict(self.spec, quiet_seconds=21), manage_service=False)
        self.assertFalse(Path(self.record['runtime']).is_relative_to(d.HERE))
        self.assertEqual(os.stat(self.root / 'state.json').st_mode & 0o777, 0o600)
        runtime_file = Path(self.record['runtime']) / 'storage.py'
        runtime_file.write_text('tampered')
        with self.assertRaises(ValueError): d.load_record(self.root)

    def test_progress_is_quiet_and_duplicate_terminal_is_once(self):
        for i in range(50):
            value = observation(); value['progress_digest'] = d.sha(i)
            d.reconcile_snapshot(self.root, self.record, value)
        self.assertFalse(self.state()['events'])
        event_id = self.terminal()
        d.reconcile_snapshot(self.root, self.record, observation('completed'))
        with patch.object(d.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as send:
            d.flush(self.root, self.record); d.flush(self.root, self.record)
            self.assertEqual(send.call_count, 1)
        entry = self.state()['events'][event_id]
        self.assertIsNone(entry['ack'])
        with self.assertRaises(ValueError): d.acknowledge(self.root, event_id, 'bad')
        first = d.acknowledge(self.root, event_id, entry['event_digest'])
        self.assertEqual(first, d.acknowledge(self.root, event_id, entry['event_digest']))

    def test_waiting_approval_ack_does_not_stop_completion(self):
        approval = {'node_id': 'approve', 'approval_id': 'decision1', 'proposal_hash': 'b' * 64}
        value = observation('waiting', [approval])
        d.reconcile_snapshot(self.root, self.record, value, now=100)
        d.reconcile_snapshot(self.root, self.record, value, now=101)
        entry = next(iter(self.state()['events'].values()))
        self.assertEqual(entry['event']['kind'], 'approval_required')
        d.acknowledge(self.root, entry['event']['event_id'], entry['event_digest'])
        self.assertEqual(self.state()['status'], 'watching')
        d.tick(self.root, self.record, now=150)
        self.assertEqual(len(self.state()['events']), 1)
        self.terminal()
        self.assertEqual(len(self.state()['events']), 2)

    def test_observed_reentry_is_a_new_occurrence(self):
        for status in ('waiting', 'waiting', 'running', 'waiting'):
            d.reconcile_snapshot(self.root, self.record, observation(status))
        self.assertEqual(len(self.state()['events']), 2)

    def test_outage_quiet_and_deadline_are_not_dag_failure(self):
        d.reconcile_snapshot(self.root, self.record, observation(), now=100)
        d.tick(self.root, self.record, now=121); d.tick(self.root, self.record, now=122)
        d.tick(self.root, self.record, now=123, error=True)
        d.tick(self.root, self.record, now=129, error=True)
        d.tick(self.root, self.record, now=130, error=True)
        kinds = [e['event']['kind'] for e in self.state()['events'].values()]
        self.assertEqual(kinds, ['quiet_timeout', 'observation_unavailable'])
        state = d.tick(self.root, self.record, now=self.state()['deadline'] + 1)
        self.assertEqual(state['status'], 'observation_deadline')
        self.assertEqual(state['last_snapshot']['status'], 'active')

    def test_identity_replacement_stops_observer(self):
        value = observation(); value['identity']['created_at'] = '2000'
        d.reconcile_snapshot(self.root, self.record, value)
        self.assertEqual(self.state()['status'], 'identity_mismatch')
        self.assertEqual(len(self.state()['events']), 1)

    def test_unknown_delivery_is_not_automatically_retried(self):
        event_id = self.terminal()
        with patch.object(d.subprocess, 'run', side_effect=subprocess.TimeoutExpired('notify', 20)) as send:
            d.flush(self.root, self.record); d.flush(self.root, self.record)
            self.assertEqual(send.call_count, 1)
        self.assertEqual(self.state()['events'][event_id]['delivery'], 'unknown')
        with patch.object(d.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
            d.deliver(self.root, self.record, event_id, redeliver=True)
        self.assertEqual(len(self.state()['events']), 1)
        self.assertEqual(len(self.state()['events'][event_id]['attempts']), 2)

    def test_crash_pending_recovers_but_attempted_does_not_resend(self):
        event_id = self.terminal()
        # A new interpreter uses the frozen copy after the registering caller exited.
        proc = subprocess.run([sys.executable, self.record['runtime'] + '/dag_subscription.py', 'run', str(self.root)], capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.state()['events'][event_id]['delivery'], 'accepted')
        state = self.state(); entry = state['events'][event_id]
        entry['delivery'] = 'attempting'
        entry['attempts'][-1].update(pid=99999999, process_identity='old-boot')
        d.save(self.root / 'state.json', state)
        proc = subprocess.run([sys.executable, self.record['runtime'] + '/dag_subscription.py', 'run', str(self.root)], capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.state()['events'][event_id]['delivery'], 'unknown')
        self.assertEqual(len(self.state()['events'][event_id]['attempts']), 1)

    def test_concurrent_deliveries_are_serialized(self):
        event_id = self.terminal()
        def slow_send(*args, **kwargs):
            time.sleep(.05)
            return subprocess.CompletedProcess([], 0)
        with patch.object(d.subprocess, 'run', side_effect=slow_send) as send:
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda _: d.deliver(self.root, self.record, event_id), range(8)))
            self.assertEqual(send.call_count, 1)

    def test_unsubscribe_preserves_events_without_dag_mutation(self):
        self.terminal()
        d.unsubscribe(self.root, manage_service=False)
        with patch.object(d.subprocess, 'run') as send:
            d.flush(self.root, self.record)
            send.assert_not_called()
        self.assertEqual(len(self.state()['events']), 1)

    def test_cli_compact_status_and_single_event(self):
        event_id = self.terminal()
        base = [sys.executable, str(d.HERE / 'dag_subscription.py'), '--home', str(self.home)]
        status = json.loads(subprocess.check_output(base + ['status', self.record['id']]))
        self.assertNotIn('events', status)
        entry = json.loads(subprocess.check_output(base + ['event', self.record['id'], event_id]))
        self.assertEqual(entry['event']['event_id'], event_id)

    def test_malformed_metadata_is_rejected(self):
        for value in ([], {}, {'runId': 'run-test', 'createdAt': float('nan'), 'nodeStates': {}}):
            with self.subTest(value=value), patch.object(d, 'get_json', return_value=value):
                with self.assertRaises(ValueError): d.fetch_snapshot(self.spec)


class HttpTests(unittest.TestCase):
    @contextmanager
    def server(self, mode):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                requests.append((self.command, self.path))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream' if self.path.endswith('/events') else 'application/json')
                self.end_headers()
                if mode == 'oversize': self.wfile.write(b'x' * (d.MAX_RESPONSE + 1)); return
                if self.path.endswith('/events'):
                    self.wfile.write(b'retry: 10000\n\nevent: dag:chat_delta\ndata: {"secret":"RAW-MODEL-TEXT"}\n\n')
                    return
                data = {'runId': 'run-test', 'createdAt': 1000, 'nodeStates': {}, 'status': 'active'}
                if self.path.endswith('/approvals'):
                    data = {'approvals': [{'run_id': 'run-test', 'status': 'waiting', 'node_id': 'n',
                            'approval_id': 'a', 'proposal_hash': 'h', 'proposal': 'SECRET-PROPOSAL'}]}
                self.wfile.write(json.dumps({'success': True, 'data': data}).encode())
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try: yield {'manager_url': f'http://127.0.0.1:{server.server_port}', 'run_id': 'run-test', 'request_seconds': 1}, requests
        finally: server.shutdown(); server.server_close(); thread.join()

    def test_existing_api_projection_and_sse_discard_raw_text(self):
        with self.server('normal') as (spec, requests):
            value = d.fetch_snapshot(spec)
            self.assertNotIn('SECRET', json.dumps(value))
            self.assertEqual(list(d.stream(spec)), ['', 'dag:chat_delta'])
            self.assertTrue(all(method == 'GET' for method, _ in requests))

    def test_oversize_response_and_stream_are_bounded(self):
        with self.server('oversize') as (spec, _):
            with self.assertRaises(ValueError): d.fetch_snapshot(spec)
            with self.assertRaises(ValueError): list(d.stream(spec))

    def test_credential_reference_permissions_and_redirect_rejection(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'token'; path.write_text('secret'); path.chmod(0o644)
            with self.assertRaises(ValueError): d.request({'admin_token_file': str(path)}, '/api/runs/run-test')
        with self.assertRaises(ValueError): d.NoRedirect().redirect_request(None)


if __name__ == '__main__': unittest.main()
