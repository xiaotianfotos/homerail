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
  "pr": 25
}
```

The CLI and Manager Skill resolve immutable base/head SHAs plus credential-free
HTTPS clone URLs from trusted GitHub PR metadata, then wrap the resolved object
in the same internal trigger envelope used by Manager event triggers. Optional
caller-supplied SHAs remain pinned, but clone URLs are always taken from the API
response and cannot be overridden by logical input. The workflow carries
separate base/head clone URLs so an explicitly reviewed fork can fetch each
commit from the repository that owns it. URL validation rejects credentials,
query strings, fragments, repository mismatches, and cross-origin base/head
metadata.

## Execution

1. Manager atomically reserves the declared usage budget.
2. A deterministic Manager command validates the credential-free GitHub API
   HTTPS clone URLs (`https://host/owner/repository.git`, including GitHub
   Enterprise hosts), clones both exact revisions into the isolated run
   workspace, verifies
   `HEAD`, and computes the changed-file list, short diff summary, and a bounded
   high-context patch. Git runs with credential helpers, prompts, hooks, and
   local/ext protocols disabled; no model tool call is involved in checkout or
   evidence collection. The serialized review context is capped below the
   Manager command-output limit and records `diff_truncated` explicitly.
   Bounded author/committer metadata is captured from the exact commit range for
   the independent privacy advisory, then deterministically stripped from the
   context supplied to every main reviewer, synthesizer, and voter.
3. Runtime, security, tests, frontend, and privacy reviewers inspect the same
   exact evidence independently and in parallel. The first four feed the main
   review. The privacy reviewer looks only for accidental local/private data and
   can never feed synthesis, verification, or quorum. All reviewers receive no
   built-in tools and only the `handoff` DAG tool. Patch content is untrusted
   evidence, never an instruction. If evidence had to be truncated, the main
   reviewers fail closed and the privacy advisory requests human inspection.
4. A deterministic normalizer preserves every valid reviewer result. If a
   reviewer exhausts contract correction without a handoff, the normalizer
   emits a `status: failed` ReviewerResult with grounded runtime evidence so the
   DAG produces an honest inconclusive artifact instead of stalling.
5. A synthesizer preserves all reviewer results and deduplicates findings.
6. Evidence, false-positive, and coverage voters independently validate the
   draft report. Evidence and false-positive voters produce a machine-readable
   verdict for every retained finding against the same patch. Rejecting a false
   finding is a successful correction and does not reject the whole report;
   missing reviewer coverage, truncated evidence, an identity mismatch, or an
   unresolvable finding does.
7. A deterministic two-of-three join decides whether verification reached
   quorum.
8. A branch-merge join normalizes either quorum outcome into one path. A
   refiner removes findings specifically rejected by an evidence or
   false-positive verdict and recomputes the report.
9. The refiner persists the final structured report and quorum as JSON. The
   privacy result is normalized separately; a failed privacy model call becomes
   a redacted `human_review` result rather than blocking or silently passing.
   A small
   publisher renders only Markdown plus the exact runtime id, avoiding a second
   model-generated copy of the full report. Manager materializes both declared
   artifacts. Failed quorum produces an `inconclusive` report instead of a
   false clean result.

## Outputs

- `pr-review.json`
- `pr-review.md`
- `pr-privacy-review.json` (redacted advisory; excluded from the main report)
- four normalized independent reviewer results
- three independent verification votes
- per-finding evidence and false-positive verdicts
- deterministic quorum payload
- Manager audit summary and per-node metrics
- HomeRail run id and replayable event history

The first version is advisory. It does not modify the reviewed repository,
submit a GitHub review, approve a PR, or merge code.

## CI Adapter

`.github/workflows/pr-review.yml` is intentionally thin. It converts GitHub
event fields into the public CLI input, then uses the shared isolated live-runner
bootstrap to build and start the checked-out Manager and Worker revision. The
runner registers its Qwen3.6 setting, calls `hr dag run-template ... --wait`,
downloads the three declared artifacts through the generic run-artifact commands,
uploads them as CI evidence, and copies `pr-review.md` into the GitHub Check
summary. Running the checked-out revision keeps the template, compiler, runtime,
and Worker protocol at the same commit instead of sending a new template to a
stale long-lived Manager. Workflow contracts, per-finding verification, and the
deterministic quorum remain authoritative; the adapter does not reconstruct a
report from raw handoffs.
The isolated Manager command allowlist includes `node` and `git`; checkout and
diff capture use only the tracked fixed command and never accept an executable
or argument vector from pull request content.
The adapter verifies that the run reached the terminal state implied by quorum,
all artifacts are structured and non-empty, the quorum is 2-of-3, and Markdown
contains the exact HomeRail run id and report identity. A valid rejected quorum
is retained as `cancelled` plus `inconclusive`; infrastructure or
artifact-integrity failures fail the check instead of being hidden behind an
advisory success. Whether that check blocks merging is a repository
branch-protection decision; findings and a valid inconclusive result are still
complete diagnostic outputs.

The privacy artifact contains categories, repository-relative locations, and
redacted reasons only. A separate `continue-on-error` step emits GitHub error
annotations when its status is `human_review`. That step is visibly red for a
maintainer to inspect, while the job conclusion and the main PR review remain
unchanged. Invalid or unredacted artifact output is an infrastructure failure
and is not hidden by the advisory step.
Commit author and committer identities are checked independently. Any
non-noreply email address is always a high-confidence `human_review` finding,
including an address owned by the repository maintainer or published elsewhere.

Automatic self-hosted execution is restricted to non-draft, same-repository PRs
created by the trusted maintainer. This avoids running untrusted fork content on
the `.112` runner. Maintainers can use `workflow_dispatch` for an explicit
review after evaluating that boundary.

PR Review jobs require a dedicated self-hosted runner with the
`homerail-pr-review` label. Live catalog validation continues to use the
`homerail-live` label. When both runners share one host, the bootstrap derives a
separate state, artifact, and cleanup slot from `runner.name`; Manager port
selection is serialized only until each isolated Manager is healthy. Do not put
both custom labels on one runner, because that would allow the two jobs to queue
on the same worker instead of running concurrently.

Runner repository configuration:

- `HOMERAIL_PATTERN_MODEL_BASE_URL`: the Qwen3.6 Anthropic-compatible endpoint;
- `HOMERAIL_LIVE_RUNNER_BASE`: optional persistent root for locks and diagnostic
  logs;
- `HOMERAIL_LIVE_MANAGER_PORT`: optional preferred isolated Manager port. The
  bootstrap selects another free port if it is occupied;
- `HOMERAIL_DAG_MUTATION_TOKEN`: optional Manager mutation token. A random token
  is generated inside the isolated run when this secret is absent.

The GitHub Actions adapter supplies `github.api_url` as
`HOMERAIL_GITHUB_API_BASE_URL`, so credential-free-accessible GitHub Enterprise
repositories use the correct metadata and checkout host instead of deriving a
`github.com` URL.
