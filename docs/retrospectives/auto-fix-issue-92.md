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

The recovered fourth candidate is 2,570 lines / 108,919 bytes across 21 files.
Both collection handoffs contain exactly the same patch bytes with digest
`14f2c7e5c8d05d57a4926a0e2d918acade2a7aec318283f7322d2a063bc24ca7`.
The temporary exported `.patch` files are one byte longer because the extraction
command appended a second final newline; their file digest is `7602d1df...` and
is not the canonical candidate digest. Identical handoff patch bytes prove that
the unconditional revision consumed a full Agent turn without changing the
candidate.

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

| Agent node | Messages | Tool calls | Tool errors | Completed handoff |
| --- | ---: | ---: | ---: | ---: |
| implement | 887 | 139 | 2 | 1 |
| review_adversarial_initial | 437 | 80 | 54 | 1 |
| investigate | 399 | 73 | 1 | 1 |
| review_regression_initial | 347 | 60 | 20 | 1 |
| review_correctness_initial | 324 | 59 | 18 | 1 |
| review_correctness_final | 202 | 38 | 27 | 0 |
| revise | 237 | 29 | 2 | 1 |
| review_adversarial_final | 153 | 24 | 23 | 0 |
| review_regression_final | 118 | 21 | 20 | 1 |

The three initial reviewers spent 199 tool calls and encountered 92 errors
(46%). The incomplete duplicated final review spent another 83 calls with 70
errors (84%). Review depth was therefore not proportional to useful evidence.

## What worked

- Manager handoffs remained durable after the Action ended, which made exact
  patch recovery possible even though the original public artifacts were not
  available.
- Independent review correctly found no blocker in the fourth candidate; the
  three-role separation still provided useful correctness, regression, and
  adversarial perspectives.
- The isolated trusted CI boundary caught the second candidate's browser-only
  build failure that model review missed.
- Exact revision checkout and deterministic patch collection allowed the
  recovered bytes to be reapplied and validated without trusting Agent prose.
- The stable 112 Manager preserved model configuration and DAG evidence across
  release deployments, so recovery did not require copying the production
  database into a transient test server.

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

### 7. Compile-only template tests did not prove runtime graph validity

The first Qwen3.6 acceptance attempt hydrated the recovered checkpoint, then
failed before model dispatch while `dag sync` projected the canonical workflow
into the runtime DAGGraph. The two bounded feedback sources did not declare the
`while` gateway as an execution dependency, so the legacy runtime graph
validator could not identify those edges as bounded feedback and reported
ordinary cycles. The original asset test stopped at canonical compilation and
therefore missed this second representation boundary. Both feedback sources now
declare `depends_on: [review_cycle]`, and the scenario test must successfully
run `projectCanonicalWorkflowToParsedDAG` as well as compile the source.

### 8. An untaken feedback source could prevent a successful run from ending

The first complete Qwen3.6 checkpoint-resume reached unanimous review,
arbitration approval, publication, and deterministic finalization in 12 minutes
27 seconds. The business result was complete, but the run remained `active`
with 19 completed nodes, 3 skipped nodes, and one pending node. The pending node
was `prepare_next_review`, the feedback source used only after revision.

The runtime correctly kept that source pending while the `while` gateway was
active, because a later iteration could still select the revision branch. It
did not revisit the source after the loop exited. One predecessor was skipped,
so it would never emit the after-dependency event needed for ordinary promotion
or branch skipping. The engine now reconciles a pending node when every one of
its dependencies is settled: it promotes the node if its required inputs were
routed, otherwise it marks the unreachable branch skipped. A runtime regression
test covers two feedback sources where the loop completes through only one.
Cold recovery performs the same reconciliation, so deploying the fix also
heals a run that was persisted in this stranded state before the upgrade.

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
11. asset tests project the canonical workflow into a validated runtime
    DAGGraph, preventing compile-valid but unsyncable feedback topologies.
12. after each transition, the runtime settles unreachable pending branches
    whose dependencies are all terminal, so dormant feedback cannot block run
    completion.

## Corrective-action matrix

| Priority | Action | Verification |
| --- | --- | --- |
| P0 | Publish v1/v2 candidates with `publish: always` | failure/cancellation leaves a ready candidate artifact |
| P0 | Record revision-bound Manager checkpoint | retry reports `checkout.mode=resumed` only at the exact same revision |
| P0 | Make reviewer votes control revision | unanimous review never dispatches `revise`; rejection permits exactly one pass |
| P0 | Stop a run that outlives its runner | timeout leaves no orphan active DAG and retains bounded diagnostics |
| P0 | Validate runtime DAGGraph projection | scenario test fails on an unsyncable feedback cycle before deployment |
| P0 | Settle dormant feedback after loop exit | success path terminalizes with the unused revision source marked skipped |
| P1 | Feed trusted validation failure into retry | investigation receives at most the final 30 KB without duplicating patch bytes |
| P1 | Bound reviewer exploration | each review starts from changed paths and uses at most 24 read-only calls |
| P1 | Bound positive-checkpoint verification | resumed investigation/implementation use at most 16 tools and do not repeat passing suites |
| P1 | Keep model binding private and replaceable | public template contains no provider/model URL/key; one or several settings are valid |

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

## First Qwen3.6 checkpoint-resume acceptance

Run `auto-fix-qwen36-issue92-resume-2` used Qwen3.6 for investigation,
implementation, all three concurrent reviewers, arbitration, and publication
on the stable 112 Manager. It proved the following before exposing root cause
8:

- checkout reported `mode=resumed` at the exact base revision and applied the
  recovered patch;
- the model-facing sanitized Issue omitted the large checkpoint patch;
- the three reviewers all approved, `revise` and `collect_revised_patch` were
  skipped, and arbitration approved;
- deterministic finalization produced the publication handoff;
- total time from run creation to finalization was 12:27, versus 1:23:28 for
  the cancelled fourth legacy attempt.

The remaining time was not chiefly slow token output. Investigation used 51
tool records and implementation used 37, and the implementer repeated focused
package tests and a production build even though trusted validation already
said those checks passed. The three reviewers then ran concurrently; their
individual tool records were 28, 44, and 47. The resumed prompts now distinguish
a concrete validation failure from a positive checkpoint, cap the positive
path at 16 built-in calls, and leave repeated suite execution to the trusted
runner.

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
