---
name: homerail-pr-closeout
description: |
  Determine whether a GitHub pull request can leave Draft or is ready for its
  owner to merge, using immutable validation, review, CI, dependency, and
  approval evidence. Never merge a pull request.
---

# HomeRail PR Closeout

Use the concrete `pr-closeout` orchestration after implementation and local
validation are complete. Do not substitute a conversational checklist.

## Safety Boundary

- Never call a GitHub merge API or `gh pr merge`.
- Never represent HomeRail approval as a GitHub approval or merge.
- Never accept validation evidence whose head differs from the current PR head.
- Never let a model override deterministic blockers.

## Draft Closeout

For a Draft PR, use one of these paths:

- Call `run_pr_closeout` with `repo`, integer `pr`, `phase: draft`, and durable
  `validation_runs`. Do not invent run ids.
- Run `hr dag run-template pr-closeout` with explicit operator-attested local
  evidence bound to a commit SHA.

A successful result means only `ready_for_review`; the PR must still run normal
GitHub CI and PR Review after leaving Draft.

## Merge Closeout

For a non-Draft PR, call `run_pr_closeout` with durable `validation_runs`,
especially the matching HomeRail PR Review run. Do not use generic
`create_and_run`, shell, `gh`, or `curl` to reconstruct the snapshot. The
workflow may pause at `merge_approval`. Return the real run id and the exact
blocker list or pending approval hash. Only `human:owner` may decide that
approval, and the user still merges manually.

Read `docs/scenarios/pr-closeout.md` for the full evidence contract.
