# Auto Fix Issue #92 Retrospective

Date: 2026-07-23

Incident window: 2026-07-22 16:06 UTC through 2026-07-23 09:41 UTC
Issue: [#92](https://github.com/xiaotianfotos/homerail/issues/92)

## Executive summary

Four Auto Fix attempts consumed 6 hours, 24 minutes, and 11 seconds without
publishing a Draft PR. The failure was not simply a slow model or a bad patch.
The workflow treated each Action as an all-or-nothing transaction: useful
candidate patches were published only after every model and finalizer
completed, validation feedback was not persisted for the next attempt, timeout
did not stop the durable DAG, and revision ran even after all initial reviewers
approved.

The fourth run actually produced a strong candidate. Its pre- and post-revision
patches have the same SHA-256 digest, all three initial reviewers approved, and
focused independent validation passes. The candidate is therefore retained as
the starting checkpoint rather than regenerated.

## Timeline and evidence

| Action run | Duration | Last useful stage | Result |
| --- | ---: | --- | --- |
| [29936533889](https://github.com/xiaotianfotos/homerail/actions/runs/29936533889) | 1:21:45 | 19 nodes completed; arbitration approved | `finalize_publication` rejected an obvious test credential placeholder as secret-like text. This false positive was fixed independently by #108. |
| [29978048589](https://github.com/xiaotianfotos/homerail/actions/runs/29978048589) | 1:38:24 | DAG completed and emitted all publication artifacts | Trusted CI rejected the 3,432-line candidate because the browser-facing protocol barrel exported Node-only `node:crypto`, `node:fs`, and `node:path` modules. |
| [29982395146](https://github.com/xiaotianfotos/homerail/actions/runs/29982395146) | 2:00:34 | Durable run remained active | The runner timed out while the DAG stayed active. Because candidates were success-only artifacts, the Action retained only input and stderr, not the work already performed. |
| [29990777449](https://github.com/xiaotianfotos/homerail/actions/runs/29990777449) | 1:23:28 | 13 nodes completed; final reviews in progress | The initial candidate already addressed the browser-barrel regression and all three reviewers approved. The workflow nevertheless ran revision and a second complete review pass. The run was stopped before publication. |

The second candidate was 3,432 lines / 137,932 bytes with digest
`efcaa2f311730e762452b2408cb7dbaf02e93fbf2547db3880953ffdb81b8cfc`.
Trusted validation, rather than a model review, found its browser build defect.

The recovered fourth candidate is 2,570 lines / 108,920 bytes across 21 files.
Both collection stages produced digest
`7602d1df28f75577b260321702c8b74d3b6a673cc28ccec1a3d4248ebd089074`.
Identical bytes prove that the unconditional revision consumed a full Agent
turn without changing the candidate.

## What the fourth run did

The run retained 13 completed handoffs:

1. deterministic checkout;
2. investigation and investigation gate;
3. implementation and implementation gate;
4. candidate v1 collection;
5. three independent initial reviews;
6. revision and revision gate;
7. candidate v2 collection;
8. one completed final review before cancellation.

All initial reviewers voted `approve`. Correctness recorded two non-blocking low
observations: a rare Docker executable failure can be described as CLI missing,
and a Manager-side synchronous Docker probe can block the event loop for up to
its timeout. Neither invalidated the Issue acceptance criteria. The second
candidate was byte-identical to the first.

The chat snapshot recorded 3,104 model messages, 523 tool calls, and 167 tool
errors across the executed Agent nodes. The implementer alone used 139 tools;
the initial adversarial reviewer reached 80 tools. Many reviewer errors were
failed or redundant file probes rather than evidence-bearing work. This
explains a substantial portion of latency and motivated exact changed-path
guidance plus a 24-call read-only review budget.

## Root causes

### 1. Approval did not control revision

The graph sent the candidate and all three review votes directly to `revise`.
There was no condition between review and revision. Approval changed only the
text seen by the reviser, not the control flow, so a correct patch still paid
for revision and three more reviewers.

### 2. Candidate durability was coupled to publication success

Only `auto-fix.json`, `auto-fix.patch`, and `auto-fix.md` existed, and all used
`publish: success`. A reviewer failure, runner cancellation, timeout, or
finalizer rejection made the candidate inaccessible through the normal
artifact API even though the handoff remained in the Manager database.

### 3. The Action adapter discarded failure context

When `hr dag run-template --wait` failed, the runner removed its temporary
stdout and exited. It did not download optional candidates, retain compact DAG
evidence, or stop a run that outlived the Action timeout.

### 4. Trusted validation was a dead end

The isolated `npm run ci` correctly caught the browser-barrel defect, but its
log was uploaded only as an Action artifact. The next run received the Issue
discussion, not a structured trusted checkpoint, and had to rediscover both the
candidate and validation failure.

### 5. Reviewer work was insufficiently bounded

Read-only reviewers knew the repository root but were not told to start from
the exact changed-file list or stop after sufficient evidence. Repeated probes,
root-path mistakes, and unavailable tools produced high error counts and long
tails. More model calls did not improve the already approved patch.

### 6. Validation environments can create false negatives

An independent local check initially reused another worktree's stale
`node_modules`, so CLI and Manager resolved an older protocol build and reported
`detectDagResourcePlatform is not a function`. Rebuilding package-local
dependencies against the recovered protocol removed the error. Validation must
bind dependencies to the candidate worktree; a clean container remains the
authoritative full-CI environment.

## Corrective design

The Auto Fix workflow now uses a durable bounded state machine:

1. implementation creates `candidate-v1.json/.patch` with `publish: always`;
2. three independent reviewers run in parallel;
3. unanimous approval skips revision and proceeds to arbitration;
4. any concrete rejection permits one revision, creates
   `candidate-v2.json/.patch`, and reuses the same reviewer roles once;
5. a second rejection stops publication while retaining the latest candidate;
6. the stable runner records the newest candidate in Manager state keyed by
   repository and Issue;
7. a retry at the same immutable revision applies that candidate before Agents
   run and supplies at most 30 KB of trusted validation feedback;
8. the large checkpoint patch is removed from the Issue envelope before model
   dispatch, avoiding repeated prompt cost;
9. timeout or command failure stops the durable run and retains quick status,
   chats, handoffs, candidate artifacts, and checkpoint metadata;
10. successful Draft PR publication marks the checkpoint complete and removes
    the patch from current state.

Runtime profile selection now permits all roles to share one model for a
controlled single-model validation, while preserving mixed-model bindings for
normal operation. Review and arbitration prompts start with the collector's
changed paths and cap read-only inspection at 24 tool calls.

## Recovered candidate verification

The fourth candidate was applied to an isolated worktree at its exact base
revision. The following checks pass:

- Protocol: 7 focused tests and typecheck;
- Manager: 12 focused readiness/recheck tests;
- CLI: 9 focused Docker-readiness tests;
- Agent UI: 4 focused copy tests, production typecheck, and Vite production
  build;
- `git apply --check` against the exact base revision.

The production UI build no longer imports Node builtins through the public
protocol barrel, directly closing the second attempt's trusted-CI failure.

## Exit criteria

The redesign is considered stable only after a Qwen3.6-only runtime profile
demonstrates both paths on the stable Manager:

- an already-correct candidate receives three approvals and never dispatches
  `revise`;
- a rejected candidate performs exactly one revision and one re-review;
- a stopped run exposes a ready candidate artifact and a subsequent run reports
  `checkout.mode=resumed`;
- trusted validation feedback is visible to investigation without exposing the
  full checkpoint patch to every Agent;
- full repository CI passes before any Draft PR is published.

No result from these attempts was merged automatically. Draft PR publication
and every merge remain human decisions.
