---
name: homerail-pr-review
description: |
  Run HomeRail's built-in read-only pull request review DAG. Use when the user
  asks to review a GitHub PR, requests an evidence-backed PR audit, or wants a
  reusable runtime/security/tests/frontend review with independent quorum.
---

# HomeRail PR Review

Use the concrete `pr-review` orchestration. Do not generate a replacement DAG
and do not substitute a single-agent review.

## Manager Agent Path

When the user says `审查 PR #25`, `review PR 25`, or equivalent:

1. Resolve the repository from the current project or ask only when no
   repository is available.
2. Call `run_pr_review` with only `repo` in `owner/name` form and integer `pr`.
   This tool resolves immutable `.base.sha` and `.head.sha` plus trusted base and
   head clone URLs in code. Never copy, infer, reverse, or manually substitute
   those fields. Do not use `gh`, `curl`, `instantiate_dag_pattern`, or generic
   `create_and_run` when this tool exists.
3. Return the real run id immediately and use `get_run_status` for progress.
4. On completion, report the final published handoff and artifact paths. Never
   claim findings that are not present in the DAG evidence.

The workflow is read-only. It must never create a commit, approve a GitHub PR,
submit a GitHub review, or merge anything. Its internal Quorum is evidence
validation, not GitHub approval.

## CLI Path

```bash
hr dag run-template pr-review \
  --input '{"repo":"xiaotianfotos/homerail","pr":25}'
```

The CLI resolves trusted GitHub metadata, preserves explicitly pinned SHAs,
validates the final input contract, syncs the tracked Asset, and starts the run.
Clone URLs always come from GitHub metadata, never logical input. Add `--wait`
for CI or unattended operation, then retrieve fixed outputs with:

```bash
hr dag artifacts <run-id>
hr dag artifact <run-id> pr-review.json --output pr-review.json
hr dag artifact <run-id> pr-review.md --output pr-review.md
```

## Evidence Contract

A useful run contains:

- four `ReviewerResult` handoffs for runtime, security, tests, and frontend;
- a deduplicated `DraftReviewReport`;
- three independent `VerificationVote` handoffs;
- one machine-readable verdict per final finding from both the evidence and
  false-positive verifiers;
- a deterministic two-of-three quorum payload;
- declared `pr-review.json` and `pr-review.md` artifacts;
- Manager audit and metrics records for the run.

Treat a cancelled run with a published report as `inconclusive`, not as a clean
review. Infrastructure, contract, or artifact failures are errors and must not
be rendered as zero findings. Do not reconstruct a report by scraping raw
handoffs; consume only the Manager-validated declared artifacts.
