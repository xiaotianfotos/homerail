# PR Closeout Scenario

`assets/orchestrations/pr-closeout.yaml.template` closes the evidence gap
between "tested locally" and "ready for the repository owner to merge". It is
separate from `pr-review`: review finds code issues, while closeout verifies
that every required result still belongs to the current immutable PR head.

## Outcomes

- `ready_for_review`: a Draft PR has fresh validation evidence and can enter
  normal GitHub review and CI.
- `stale_evidence`: validation exists, but none of it matches the current head.
- `blocked`: one or more deterministic gates failed.
- `ready_for_human_merge_candidate`: merge gates passed and the run is paused
  at an owner-only durable approval node.

The workflow never calls a model and never invokes a GitHub merge API. Approval
only records that `human:owner` accepted the exact closeout snapshot. The
repository owner still performs the merge outside HomeRail.

## Draft Phase

Attach local validation to the exact commit:

```bash
hr dag run-template pr-closeout --wait \
  --input '{
    "repo":"xiaotianfotos/homerail",
    "pr":26,
    "phase":"draft",
    "local_evidence":[{
      "name":"macOS full CI",
      "head":"<current-head-sha>",
      "status":"passed",
      "platform":"macos",
      "command":"npm run ci"
    }]
  }' \
  --output-dir artifacts/pr-closeout
```

Operator-attested local evidence can only establish `ready_for_review`. It is
not sufficient for merge readiness.

## Merge Phase

After the PR leaves Draft and GitHub checks finish, provide one or more durable
HomeRail run ids:

```bash
hr dag run-template pr-closeout \
  --input '{
    "repo":"xiaotianfotos/homerail",
    "pr":26,
    "phase":"merge",
    "validation_runs":["<pr-review-run-id>"]
  }'
```

The resolver checks the current PR snapshot, GitHub check runs and commit
statuses, latest review decisions, mergeability, stacked dependencies, and the
persisted HomeRail handoffs. Merge candidacy requires a completed, current-head
PR Review with a conclusive `pass` report and zero actionable findings.

When all gates pass, inspect the pending approval and decide it explicitly:

```bash
hr dag approvals
hr dag decide <run-id> merge_approval \
  --decision approved \
  --actor human:owner \
  --proposal-hash <hash>
hr dag closeout-report <run-id>
```

Approval is hash-bound, survives Manager restart, expires after seven days,
and cannot be issued by `system:pr-closeout`.

## Stacked Pull Requests

An open PR whose head branch is the current PR's base is recorded as a
dependency. It does not block Draft closeout, because stacked review is useful,
but it blocks merge closeout until the parent PR is merged and the child is
retargeted or refreshed.

## Evidence Boundary

Local evidence is an operator assertion with an immutable SHA. HomeRail run
evidence is loaded from Manager and checked against the current SHA. GitHub
state is fetched when closeout starts. If the PR changes afterward, start a new
closeout run; an older approval applies only to its stored proposal hash.
