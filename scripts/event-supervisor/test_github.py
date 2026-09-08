import unittest
from watch_github import check, watch


class GithubWatchTests(unittest.TestCase):
    def setUp(self):
        self.spec = dict(repo='owner/repo', pr=3, pr_head='candidate', run_id=42,
                         run_attempt=1, workflow_head='default-branch', workflow_path='review.yml')
        self.pr = dict(number=3, state='open', head=dict(sha='candidate'))
        self.run = dict(id=42, run_attempt=1, head_sha='default-branch', path='review.yml',
                        status='in_progress', conclusion=None, html_url='https://example.invalid/run/42')

    def test_workflow_and_reviewed_heads_are_separate(self):
        self.assertIsNone(check(self.spec, self.pr, self.run))
        self.run.update(status='completed', conclusion='success')
        self.assertEqual(check(self.spec, self.pr, self.run), 'success')

    def test_stale_head_rerun_and_wrong_workflow_are_rejected(self):
        for key, value in [('run_attempt', 2), ('head_sha', 'wrong'), ('path', 'ci.yml'), ('id', 43)]:
            with self.subTest(key=key):
                self.assertEqual(check(self.spec, self.pr, dict(self.run, **{key: value})), 'wrong_execution')
        self.pr['head']['sha'] = 'newer'
        self.assertEqual(check(self.spec, self.pr, self.run), 'stale_pr')

    def test_terminal_cancellation_is_not_success(self):
        for outcome in ['cancelled', 'failure', 'timed_out', 'skipped', None]:
            self.run.update(status='completed', conclusion=outcome)
            self.assertEqual(check(self.spec, self.pr, self.run), 'workflow_failed')

    def test_unchanged_observations_do_not_return_until_terminal(self):
        sleeps = []
        def read(endpoint):
            if '/pulls/' in endpoint:
                return self.pr
            if len(sleeps) == 3:
                return dict(self.run, status='completed', conclusion='success')
            return self.run
        result = watch(self.spec, read=read, sleep=sleeps.append, now=lambda: 0)
        self.assertEqual(result['outcome'], 'success')
        self.assertEqual(sleeps, [30, 30, 30])

    def test_observation_failures_do_not_claim_workflow_failure(self):
        def read(endpoint):
            raise RuntimeError('temporary API error')
        sleeps = []
        result = watch(self.spec, read=read, sleep=sleeps.append, now=lambda: 0)
        self.assertEqual(result['outcome'], 'observation_unavailable')
        self.assertEqual(sleeps, [15, 30])


if __name__ == '__main__':
    unittest.main()
