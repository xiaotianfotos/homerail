# PR Review Scenario

`assets/orchestrations/pr-review.yaml.template` is HomeRail's provider-neutral,
read-only pull request review scenario. It is a concrete composition of the
Budget Gate, Orchestrator-Workers, and Quorum patterns rather than a new
abstract pattern.

## Inputs

Callers provide one logical PR input object:

```json
{
  "repo": "xiaotianfotos/homerail",
  "pr": 25,
  "base": "<base commit SHA>",
  "head": "<head commit SHA>",
  "expected_usage": 8,
  "budget_key": "pr-review:xiaotianfotos/homerail:2026-07-12"
}
```

The CLI and Manager Skill resolve base/head metadata when the caller supplies
only `repo` and `pr`, then wrap the resolved object in the same internal trigger
envelope used by Manager event triggers. The workflow itself requires immutable
commit identities so a review cannot silently drift while it is running.
The clone URL is derived from the validated `owner/repository` value and cannot
be supplied by an event payload.

## Execution

1. Manager atomically reserves the declared usage budget.
2. A preparer clones and checks out the exact head commit in a shared isolated
   workspace.
3. Runtime, security, tests, and frontend reviewers inspect the same exact diff
   independently and in parallel. Their Docker workspace mount is read-only;
   only the preparer receives a writable workspace.
4. A synthesizer preserves all reviewer results and deduplicates findings.
5. Evidence, false-positive, and coverage voters independently validate the
   draft report. Evidence and false-positive voters produce a machine-readable
   verdict for every retained finding.
6. A deterministic two-of-three join decides whether verification reached
   quorum.
7. A branch-merge join normalizes either quorum outcome into one path. A
   refiner removes findings specifically rejected by an evidence or
   false-positive verdict and recomputes the report.
8. A publisher persists the final handoff and the CLI materializes Markdown and
   JSON evidence. Failed quorum produces an `inconclusive` report instead of a
   false clean result.

## Outputs

- `artifacts/pr-review/report.json`
- `artifacts/pr-review/report.md`
- four independent reviewer handoffs
- three independent verification votes
- per-finding evidence and false-positive verdicts
- deterministic quorum payload
- Manager audit summary and per-node metrics
- HomeRail run id and replayable event history

The first version is advisory. It does not modify the reviewed repository,
submit a GitHub review, approve a PR, or merge code.

## CI Adapter

`.github/workflows/pr-review.yml` is intentionally thin. It converts GitHub
event fields into the public CLI input, calls `hr dag run-template ... --wait`,
uploads the generated evidence, and copies `report.md` into the GitHub Check
summary. The CLI refuses to export a report when immutable PR identity drifts,
a verifier omits a final finding, or a rejected finding remains in the final
report. It also requires the final finding set to equal the draft minus rejected
findings and verifies the published quorum against the three persisted votes.
The review step uses `continue-on-error`, so findings or an inconclusive run do
not block merging.

Automatic self-hosted execution is restricted to non-draft, same-repository PRs
created by the trusted maintainer. This avoids running untrusted fork content on
the `.112` runner. Maintainers can use `workflow_dispatch` for an explicit
review after evaluating that boundary.

Required repository configuration:

- `HOMERAIL_PR_REVIEW_MANAGER_URL`: the isolated Manager URL reachable from the
  self-hosted runner;
- `HOMERAIL_DAG_MUTATION_TOKEN`: the Manager mutation token;
- `HOMERAIL_PR_REVIEW_PROFILE`: optional DB runtime profile id.
