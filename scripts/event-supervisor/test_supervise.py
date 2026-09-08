import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('supervise.py')


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.queue = self.root / 'queue.py'
        self.queue.write_text("import pathlib,sys\np=pathlib.Path(__file__).with_name('deliveries')\nwith p.open('a') as f:f.write('delivery\\n')\nprint('queued-test-receipt')\n")
        self.job = self.root / 'job.py'
        self.job.write_text("import pathlib\np=pathlib.Path(__file__).with_name('runs')\nwith p.open('a') as f:f.write('run\\n')\n")
        self.spec = {'id': 'test', 'thread': 'fake', 'queue_argv': [sys.executable, str(self.queue)],
                     'event_dir': str(self.root / 'events'), 'cwd': str(self.root),
                     'argv': [sys.executable, str(self.job)], 'attention_after_seconds': 5}
        self.path = self.root / 'spec.json'

    def run_job(self):
        self.path.write_text(json.dumps(self.spec))
        return subprocess.run([sys.executable, str(SCRIPT), str(self.path)], capture_output=True, timeout=10)

    def event(self, name='finished'):
        return json.loads((self.root / 'events' / (name + '.json')).read_text())

    def test_completion_and_restart_do_not_rerun_or_resend(self):
        self.assertEqual(self.run_job().returncode, 0)
        self.assertEqual(self.run_job().returncode, 0)
        self.assertEqual((self.root / 'runs').read_text(), 'run\n')
        self.assertEqual((self.root / 'deliveries').read_text(), 'delivery\n')
        self.assertEqual(self.event()['delivery'], 'queued')

    def test_nonzero_exit_is_failure(self):
        self.job.write_text('raise SystemExit(7)')
        self.assertEqual(self.run_job().returncode, 1)
        self.assertEqual(self.event()['details']['outcome'], 'execution_failed')
        self.assertEqual(self.event()['details']['exit_code'], 7)

    def test_ambiguous_delivery_is_not_resent(self):
        self.queue.write_text(self.queue.read_text() + '\nraise SystemExit(1)')
        self.run_job()
        self.run_job()
        self.assertEqual(self.event()['delivery'], 'unknown')
        self.assertEqual((self.root / 'deliveries').read_text(), 'delivery\n')

    def test_timeout_notifies_once_then_completion(self):
        self.job.write_text(self.job.read_text() + '\nimport time;time.sleep(0.4)')
        self.spec['attention_after_seconds'] = 0.1
        self.assertEqual(self.run_job().returncode, 0)
        self.assertEqual(self.event('timeout')['delivery'], 'queued')
        self.assertEqual((self.root / 'deliveries').read_text(), 'delivery\ndelivery\n')
        self.run_job()
        self.assertEqual((self.root / 'runs').read_text(), 'run\n')

    def test_interrupted_supervisor_requires_reconciliation(self):
        self.run_job()
        path = self.root / 'events' / 'execution.json'
        record = json.loads(path.read_text())
        record['status'] = 'running'
        path.write_text(json.dumps(record))
        (path.parent / 'runner.json').unlink()  # Simulate a crash before the independent receipt.
        self.run_job()
        self.run_job()
        self.assertEqual((self.root / 'runs').read_text(), 'run\n')
        self.assertEqual(self.event('interrupted')['delivery'], 'queued')

    def test_stale_plan_does_not_start_command(self):
        (self.root / 'state.json').write_text(json.dumps({'phase': 'model', 'rounds': [
            {'index': 2, 'plan_digest': 'current'}]}))
        self.spec.update(task_root=str(self.root), round=1, plan_digest='old', expected_phases=['judging'])
        self.assertEqual(self.run_job().returncode, 1)
        self.assertFalse((self.root / 'runs').exists())
        self.assertEqual(self.event('preflight_failed')['delivery'], 'queued')

    def test_missing_runtime_stops_before_job_and_can_notify(self):
        self.spec.update(environment={'PATH': '/nonexistent'}, preflight_argv=[['node', '--version']])
        self.assertEqual(self.run_job().returncode, 1)
        self.assertFalse((self.root / 'runs').exists())
        self.assertEqual(self.event('preflight_failed')['delivery'], 'queued')

    def test_pinned_runtime_path_reaches_child(self):
        runtime = self.root / 'bin'
        runtime.mkdir()
        (runtime / 'runtime-python').symlink_to(sys.executable)
        self.spec.update(environment={'PATH': str(runtime)}, preflight_argv=[['runtime-python', '--version']],
                         argv=['runtime-python', str(self.job)])
        self.assertEqual(self.run_job().returncode, 0)
        self.assertEqual((self.root / 'runs').read_text(), 'run\n')


if __name__ == '__main__':
    unittest.main()
