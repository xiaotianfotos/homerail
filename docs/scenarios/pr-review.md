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
8. The refiner persists the final structured report and quorum as JSON. A small
   publisher renders only Markdown plus the exact runtime id, avoiding a second
   model-generated copy of the full report. Manager materializes both declared
   artifacts. Failed quorum produces an `inconclusive` report instead of a
   false clean result.

## Outputs

- `pr-review.json`
- `pr-review.md`
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
event fields into the public CLI input, then uses the shared isolated live-runner
bootstrap to build and start the checked-out Manager and Worker revision. The
runner registers its Qwen3.6 setting, calls `hr dag run-template ... --wait`,
downloads the two declared artifacts through the generic run-artifact commands,
uploads them as CI evidence, and copies `pr-review.md` into the GitHub Check
summary. Running the checked-out revision keeps the template, compiler, runtime,
and Worker protocol at the same commit instead of sending a new template to a
stale long-lived Manager. Workflow contracts, per-finding verification, and the
deterministic quorum remain authoritative; the adapter does not reconstruct a
report from raw handoffs.
The adapter verifies that the run reached the terminal state implied by quorum,
both artifacts are structured and non-empty, the quorum is 2-of-3, and Markdown
contains the exact HomeRail run id and report identity. A valid rejected quorum
is retained as `cancelled` plus `inconclusive`; infrastructure or
artifact-integrity failures fail the check instead of being hidden behind an
advisory success. Whether that check blocks merging is a repository
branch-protection decision; findings and a valid inconclusive result are still
complete diagnostic outputs.

Automatic self-hosted execution is restricted to non-draft, same-repository PRs
created by the trusted maintainer. This avoids running untrusted fork content on
the `.112` runner. Maintainers can use `workflow_dispatch` for an explicit
review after evaluating that boundary.

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
