import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import durable
from supervise import interrupted_process


class DurableTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / 'home'
        self.home.mkdir()
        self.units = self.root / 'units'
        self.queue = self.root / 'queue.py'
        self.queue.write_text("from pathlib import Path\np=Path(__file__).with_name('deliveries')\nwith p.open('a') as f:f.write('queue\\n')\n")
        self.job = self.root / 'job.py'
        self.job.write_text("from pathlib import Path\np=Path(__file__).with_name('runs')\nwith p.open('a') as f:f.write('run\\n')\n")
        self.spec = {'id': 'probe', 'execution_id': 'stable-task-round-operation', 'thread': 'test',
                     'event_dir': str(self.root / 'events'), 'cwd': str(self.root),
                     'argv': [sys.executable, str(self.job)],
                     'queue_argv': [sys.executable, str(self.queue)]}
        self.path = self.root / 'spec.json'

    def register(self):
        self.path.write_text(json.dumps(self.spec))
        return durable.register(self.path, self.home, self.units)

    def run_record(self, path, timeout=5):
        r = durable.read(path)
        return subprocess.run([sys.executable, str(Path(r['runtime']) / 'durable.py'),
                               'run', str(path)], capture_output=True, text=True, timeout=timeout)

    def event(self, name):
        return durable.read(self.root / 'events' / (name + '.json'))

    def test_completed_work_survives_unit_loss_and_restart(self):
        record, r = self.register()
        self.assertEqual(self.run_record(record).returncode, 0)
        (self.units / r['unit']).unlink()
        self.assertEqual(self.register(), (record, r))
        self.assertEqual(self.run_record(record).returncode, 0)
        self.assertEqual((self.root / 'runs').read_text(), 'run\n')
        self.assertEqual((self.root / 'deliveries').read_text(), 'queue\n')

    def test_command_identity_rejects_duplicate_label_and_directory(self):
        self.register()
        self.spec.update(id='after-reboot', event_dir=str(self.root / 'another-events'))
        with self.assertRaisesRegex(ValueError, 'already registered'):
            self.register()
        self.assertEqual(len(list(self.units.glob('*.service'))), 1)

    def test_github_execution_identity_rejects_duplicate_observer(self):
        del self.spec['argv']
        self.spec['github'] = {'repo': 'owner/repo', 'pr': 1, 'run_id': 7, 'run_attempt': 1,
                               'workflow_head': 'a'*40, 'pr_head': 'b'*40,
                               'workflow_path': '.github/workflows/ci.yml'}
        self.register()
        self.spec.update(id='after-reboot', event_dir=str(self.root / 'other'))
        with self.assertRaisesRegex(ValueError, 'already registered'):
            self.register()

    def test_different_execution_cannot_reuse_event_directory(self):
        self.register()
        self.spec['execution_id'] = 'different'
        with self.assertRaisesRegex(ValueError, 'already belongs'):
            self.register()

    def test_changed_and_missing_spec_notify_original_destination_only_once(self):
        record, _ = self.register()
        self.spec['queue_argv'] = ['/nonexistent']
        self.path.write_text(json.dumps(self.spec))
        self.assertEqual(self.run_record(record).returncode, 0)
        self.path.unlink()
        self.assertEqual(self.run_record(record).returncode, 0)
        self.assertFalse((self.root / 'runs').exists())
        self.assertEqual((self.root / 'deliveries').read_text(), 'queue\n')
        self.assertEqual(self.event('registration_invalid')['delivery'], 'queued')

    def test_simultaneous_invalid_spec_notifications_are_serialized(self):
        record, r = self.register()
        self.path.unlink()
        cmd = [sys.executable, str(Path(r['runtime']) / 'durable.py'), 'run', str(record)]
        children = [subprocess.Popen(cmd) for _ in range(4)]
        for child in children:
            self.assertEqual(child.wait(timeout=5), 0)
        self.assertEqual((self.root / 'deliveries').read_text(), 'queue\n')

    def test_runtime_is_independent_of_checkout_and_detects_changed_bytes(self):
        record, r = self.register()
        self.assertNotEqual(Path(r['runtime']), durable.HERE)
        (Path(r['runtime']) / 'watch_github.py').write_text('raise RuntimeError("changed")')
        self.assertEqual(self.run_record(record).returncode, 0)
        self.assertFalse((self.root / 'runs').exists())
        self.assertTrue(self.event('registration_invalid'))

    def test_actual_killed_supervisor_preserves_original_child(self):
        release = self.root / 'allow-finish'
        self.job.write_text(self.job.read_text() +
                           '\nimport time\ndeadline=time.monotonic()+60\n'
                           'while not Path(__file__).with_name("allow-finish").exists():\n'
                           ' if time.monotonic()>deadline:raise RuntimeError("fixture deadline")\n'
                           ' time.sleep(.01)\n')
        record, r = self.register()
        proc = subprocess.Popen([sys.executable, str(Path(r['runtime']) / 'durable.py'), 'run', str(record)])
        try:
            deadline = time.monotonic() + 4
            while not (self.root / 'runs').exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue((self.root / 'runs').exists())
            proc.kill()
            proc.wait(timeout=2)
            cmd = [sys.executable, str(Path(r['runtime']) / 'durable.py'), 'run', str(record)]
            recovery = subprocess.Popen(cmd)
            def cleanup_recovery():
                release.touch()
                try:
                    recovery.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    recovery.kill()
                    recovery.wait()
            self.addCleanup(cleanup_recovery)
            deadline = time.monotonic() + 4
            notification = self.root / 'events/interrupted.json'
            while (not notification.exists() or durable.read(notification)['delivery'] != 'queued') and time.monotonic() < deadline:
                time.sleep(.01)
            event = self.event('interrupted')
            self.assertTrue(event['details']['process_observation']['same_process_alive'])
            with patch('durable.systemctl', return_value='inactive'):
                for action in ('upgrade', 'uninstall'):
                    with self.assertRaises((BlockingIOError, RuntimeError)):
                        durable.lifecycle(action, record, self.units)
            self.assertEqual((self.root / 'runs').read_text(), 'run\n')
            self.assertEqual((self.root / 'deliveries').read_text(), 'queue\n')
            release.touch()
            self.assertEqual(recovery.wait(timeout=5), 0)
            # The detached trusted runner records completion despite supervisor death.
            self.assertEqual(durable.read(self.root / 'events/runner.json')['status'], 'finished')
            self.assertEqual(self.run_record(record).returncode, 0)
            self.assertEqual(self.event('finished')['details']['exit_code'], 0)
            self.assertEqual((self.root / 'runs').read_text(), 'run\n')
            self.assertEqual((self.root / 'deliveries').read_text(), 'queue\nqueue\n')
        finally:
            release.touch()
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    def test_github_observation_result_reaches_durable_event(self):
        del self.spec['argv']
        self.spec['github'] = {'repo': 'owner/repo', 'pr': 1, 'run_id': 7, 'run_attempt': 1,
                               'workflow_head': 'a'*40, 'pr_head': 'b'*40,
                               'workflow_path': '.github/workflows/ci.yml',
                               'maximum_wait_seconds': .000000001}
        record, _ = self.register()
        self.run_record(record)
        receipt = self.event('runner')
        event = self.event('finished')
        self.assertEqual(receipt['outcome'], 'observation_deadline')
        self.assertEqual(event['details']['outcome'], 'observation_deadline')
        self.assertEqual(event['details']['after']['github']['target'], self.spec['github'])
        self.assertEqual(event['details']['after']['github']['result']['outcome'], 'observation_deadline')
        self.assertEqual(self.run_record(record).returncode, 0)
        self.assertEqual((self.root / 'deliveries').read_text(), 'queue\n')

    def test_github_completed_checks_and_stale_target_remain_distinct(self):
        del self.spec['argv']
        self.spec['github'] = {'repo': 'owner/repo', 'pr': 1, 'run_id': 7, 'run_attempt': 1,
                               'workflow_head': 'a'*40, 'pr_head': 'b'*40,
                               'workflow_path': '.github/workflows/ci.yml'}
        gh = self.root / 'gh'
        self.spec['environment'] = {'PATH': str(self.root) + os.pathsep + os.environ.get('PATH', '')}
        for number, (case, expected) in enumerate([
                ('success', 'needs_judger'), ('failure', 'workflow_failed'), ('stale', 'stale_pr')], 1):
            with self.subTest(case=case):
                pr = {'number': number, 'state': 'open', 'head': {'sha': ('c' if case == 'stale' else 'b')*40}}
                run = {'id': 7, 'run_attempt': 1, 'head_sha': 'a'*40,
                       'path': '.github/workflows/ci.yml@main', 'status': 'completed',
                       'conclusion': case, 'html_url': 'https://example.invalid/run/7'}
                self.spec.update(id=case, event_dir=str(self.root / case))
                # Separate immutable targets for separate observations.
                self.spec['github']['pr'] = number
                gh.write_text('#!' + sys.executable + '\nimport sys\nprint(' +
                              repr(json.dumps(pr)) + ' if "/pulls/" in sys.argv[-1] else ' +
                              repr(json.dumps(run)) + ')\n')
                gh.chmod(0o700)
                record, _ = self.register()
                self.run_record(record)
                event_root = self.root / case
                event = durable.read(event_root / 'finished.json')
                self.assertEqual(event['details']['outcome'], expected)
                self.assertEqual(event['details']['after']['github']['result']['conclusion'], case)
                self.assertEqual(self.run_record(record).returncode, 0)
        self.assertEqual((self.root / 'deliveries').read_text(), 'queue\n'*3)

    def test_concurrent_supervisors_only_execute_once(self):
        self.job.write_text(self.job.read_text() + '\nimport time;time.sleep(.2)\n')
        record, r = self.register()
        cmd = [sys.executable, str(Path(r['runtime']) / 'durable.py'), 'run', str(record)]
        children = [subprocess.Popen(cmd) for _ in range(4)]
        for child in children:
            self.assertEqual(child.wait(timeout=5), 0)
        self.assertEqual((self.root / 'runs').read_text(), 'run\n')
        self.assertEqual((self.root / 'deliveries').read_text(), 'queue\n')

    def test_different_boot_or_unknown_identity_is_not_original_process(self):
        with patch('supervise.process_identity', return_value='new-boot:42'):
            self.assertFalse(interrupted_process({'pid': 10, 'child_identity': 'old-boot:42'})['same_process_alive'])
            self.assertTrue(interrupted_process({'pid': 10})['identity_unknown'])

    def test_invalid_spec_rejected_before_registration(self):
        for updates in ({'argv': 'shell string'}, {'attention_after_seconds': -1},
                        {'attention_after_seconds': float('inf')}, {'event_dir': 'relative'},
                        {'thread': 'line\nbreak'}, {'environment': {'TOKEN': 1}}):
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                durable.validate_spec(dict(self.spec, **updates))
        self.assertFalse(self.units.exists())

    def test_unit_argument_escaping(self):
        with self.assertRaises(ValueError):
            durable.quote_systemd('/tmp/line\nExecStart=evil')
        self.assertEqual(durable.quote_systemd('a b%"$'), '"a b%%\\"$$"')

    def test_uninstall_preserves_evidence_and_reinstall_does_not_rerun(self):
        record, r = self.register()
        self.run_record(record)
        with patch('durable.systemctl', return_value='inactive'):
            durable.lifecycle('uninstall', record, self.units)
            durable.lifecycle('uninstall', record, self.units)
        self.assertFalse((self.units / r['unit']).exists())
        self.assertTrue(record.exists())
        self.assertTrue((Path(r['runtime']) / 'supervise.py').exists())
        self.assertEqual(self.run_record(record).returncode, 0)
        self.register()
        self.run_record(record)
        self.assertEqual((self.root / 'runs').read_text(), 'run\n')
        self.assertEqual((self.root / 'deliveries').read_text(), 'queue\n')

    def test_upgrade_and_rollback_preserve_execution_identity_and_results(self):
        record, original = self.register()
        self.run_record(record)
        source = self.root / 'new-version'
        source.mkdir()
        for name in durable.MODULES:
            (source / name).write_bytes((durable.HERE / name).read_bytes() + b'\n# next version\n')
        with patch('durable.systemctl', return_value='inactive'):
            updated = durable.lifecycle('upgrade', record, self.units, source)
            self.assertNotEqual(updated['runtime'], original['runtime'])
            self.assertEqual(updated['key'], original['key'])
            self.assertEqual(self.run_record(record).returncode, 0)
            rolled = durable.lifecycle('upgrade', record, self.units, Path(original['runtime']))
        self.assertEqual(rolled['runtime'], original['runtime'])
        self.assertEqual((self.root / 'runs').read_text(), 'run\n')
        self.assertEqual((self.root / 'deliveries').read_text(), 'queue\n')

    def test_lifecycle_refuses_active_service_and_external_unit(self):
        record, r = self.register()
        with patch('durable.systemctl', return_value='active'):
            with self.assertRaisesRegex(RuntimeError, 'active'):
                durable.lifecycle('uninstall', record, self.units)
        (self.units / r['unit']).write_text('external unit')
        with patch('durable.systemctl', return_value='inactive'):
            with self.assertRaisesRegex(ValueError, 'externally modified'):
                durable.lifecycle('upgrade', record, self.units)

    def test_upgrade_recovers_crash_between_record_and_unit_write(self):
        record, original = self.register()
        self.run_record(record)
        source = self.root / 'next'
        source.mkdir()
        for name in durable.MODULES:
            (source / name).write_bytes((durable.HERE / name).read_bytes() + b'\n# upgrade\n')
        with patch('durable.systemctl', return_value='inactive'):
            with patch('durable.write_unit', side_effect=OSError('injected crash')):
                with self.assertRaises(OSError):
                    durable.lifecycle('upgrade', record, self.units, source)
            updated = durable.lifecycle('upgrade', record, self.units, source)
        self.assertNotEqual(updated['runtime'], original['runtime'])
        self.assertEqual((self.units / updated['unit']).read_text(), durable.unit_text(record, updated))
        self.assertEqual(self.run_record(record).returncode, 0)
        self.assertEqual((self.root / 'runs').read_text(), 'run\n')

    def test_preflight_failure_is_terminal_and_not_repeated(self):
        self.spec['preflight_argv'] = [[sys.executable, str(self.queue)], ['/nonexistent']]
        record, _ = self.register()
        self.assertEqual(self.run_record(record).returncode, 1)
        self.assertEqual(self.run_record(record).returncode, 0)
        self.assertFalse((self.root / 'runs').exists())
        self.assertEqual((self.root / 'deliveries').read_text(), 'queue\nqueue\n')
        self.assertFalse((self.root / 'events/finished.json').exists())

    def test_legacy_event_directory_cannot_be_adopted_implicitly(self):
        events = self.root / 'events'
        events.mkdir()
        (events / 'lock').touch()
        with self.assertRaisesRegex(ValueError, 'legacy'):
            self.register()

    def test_reconcile_only_never_starts_an_unstarted_job(self):
        record, r = self.register()
        result = subprocess.run([sys.executable, str(Path(r['runtime']) / 'durable.py'),
                                 'run', str(record), '--reconcile-only'], capture_output=True)
        self.assertEqual(result.returncode, 75)
        self.assertFalse((self.root / 'runs').exists())
        self.assertFalse((self.root / 'deliveries').exists())
        self.assertFalse((self.root / 'events/evidence_invalid.json').exists())

    def test_lost_supervisor_result_reuses_runner_receipt(self):
        record, _ = self.register()
        self.run_record(record)
        execution = self.root / 'events/execution.json'
        old = durable.read(execution)
        old['status'] = 'running'
        execution.write_text(json.dumps(old))
        self.assertEqual(self.run_record(record).returncode, 0)
        self.assertEqual(durable.read(execution)['status'], 'finished')
        self.assertEqual((self.root / 'runs').read_text(), 'run\n')
        self.assertEqual((self.root / 'deliveries').read_text(), 'queue\n')

    def test_changed_log_is_not_promoted_as_trusted_result(self):
        record, _ = self.register()
        self.run_record(record)
        execution = self.root / 'events/execution.json'
        old = durable.read(execution)
        old['status'] = 'running'
        execution.write_text(json.dumps(old))
        (self.root / 'events/execution.log').write_text('changed log')
        self.assertEqual(self.run_record(record).returncode, 0)
        self.assertEqual(self.event('evidence_invalid')['delivery'], 'queued')
        self.assertEqual(durable.read(execution)['status'], 'running')
        self.assertEqual((self.root / 'runs').read_text(), 'run\n')
        r = durable.read(record)
        reconcile = subprocess.run([sys.executable, str(Path(r['runtime']) / 'durable.py'),
                                    'reconcile', str(record)], capture_output=True)
        self.assertEqual(reconcile.returncode, 1)
        self.assertEqual((self.root / 'deliveries').read_text(), 'queue\nqueue\n')

    def test_completed_evidence_is_revalidated_without_reexecution(self):
        for corruption in ('log', 'receipt', 'summary', 'missing_receipt'):
            with self.subTest(corruption=corruption):
                self.spec.update(execution_id=corruption, event_dir=str(self.root / corruption))
                record, r = self.register()
                self.assertEqual(self.run_record(record).returncode, 0)
                events = Path(self.spec['event_dir'])
                completion = (events / 'finished.json').read_bytes()
                if corruption == 'log':
                    (events / 'execution.log').write_text('modified after completion')
                elif corruption == 'missing_receipt':
                    (events / 'runner.json').unlink()
                else:
                    path = events / ('runner.json' if corruption == 'receipt' else 'execution.json')
                    value = durable.read(path)
                    value['exit_code'] = 7
                    durable.save(path, value)
                for _ in range(2):
                    result = subprocess.run([sys.executable, str(Path(r['runtime']) / 'durable.py'),
                                             'reconcile', str(record)], capture_output=True)
                    self.assertEqual(result.returncode, 1)
                self.assertEqual(durable.read(events / 'evidence_invalid.json')['delivery'], 'queued')
                self.assertEqual((events / 'finished.json').read_bytes(), completion)
        self.assertEqual((self.root / 'runs').read_text(), 'run\n' * 4)
        self.assertEqual((self.root / 'deliveries').read_text(), 'queue\n' * 8)

    def test_completed_receipt_remains_reusable_after_checkout_advances(self):
        repo = self.root / 'repo'
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        commit = ['git', '-C', str(repo), '-c', 'user.name=Test',
                  '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm']
        subprocess.run(commit + ['tested'], check=True)
        head = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
        self.spec.update(repo_dir=str(repo), head=head)
        record, r = self.register()
        self.assertEqual(self.run_record(record).returncode, 0)
        completion = (self.root / 'events/finished.json').read_bytes()
        subprocess.run(commit + ['next candidate'], check=True)
        result = subprocess.run([sys.executable, str(Path(r['runtime']) / 'durable.py'),
                                 'reconcile', str(record)], capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual((self.root / 'events/finished.json').read_bytes(), completion)
        self.assertEqual((self.root / 'runs').read_text(), 'run\n')
        self.assertEqual((self.root / 'deliveries').read_text(), 'queue\n')

    def test_changed_head_refuses_command_before_execution(self):
        repo = self.root / 'repo'
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                        'commit', '--allow-empty', '-qm', 'base'], check=True)
        self.spec.update(repo_dir=str(repo), head='0' * 40)
        record, _ = self.register()
        self.assertEqual(self.run_record(record).returncode, 1)
        self.assertFalse((self.root / 'runs').exists())
        self.assertTrue(self.event('preflight_failed'))

    def test_spec_read_race_cannot_execute_an_unregistered_command(self):
        from supervise import main
        record, r = self.register()
        self.spec['argv'] = [sys.executable, str(self.queue)]
        self.path.write_text(json.dumps(self.spec))
        with self.assertRaisesRegex(ValueError, 'registration validation'):
            main(self.path, expected_digest=r['spec_digest'])
        self.assertFalse((self.root / 'events').exists())
        self.assertFalse((self.root / 'deliveries').exists())


if __name__ == '__main__':
    unittest.main()
