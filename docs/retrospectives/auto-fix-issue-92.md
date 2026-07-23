# Auto Fix Issue #92 Retrospective

Date: 2026-07-23

Legacy incident window: 2026-07-22 16:06 UTC through 2026-07-23 09:41 UTC

Recovery and verification window: through 2026-07-23 13:50 UTC
Issue: [#92](https://github.com/xiaotianfotos/homerail/issues/92)

## Executive summary

Four legacy Auto Fix attempts consumed 6 hours, 24 minutes, and 11 seconds
without publishing a Draft PR. The failure was not simply a slow model or a bad
patch. The workflow treated an entire Action as an all-or-nothing transaction:
useful candidates became artifacts only after every model and finalizer
completed, trusted validation feedback was not persisted for the next attempt,
timeout did not stop the durable DAG, and revision ran even after all initial
reviewers approved.

The fourth legacy attempt had already produced a strong candidate. Its pre- and
post-revision patch bytes were identical, all three initial reviewers approved,
and focused independent validation passed. We recovered that exact candidate
as a revision-bound Manager checkpoint instead of asking another model to
regenerate it.

Five controlled checkpoint-resume runs then separated workflow defects from
model behavior. They exposed an unsyncable feedback topology, a dormant branch
that prevented terminalization, an outer runner that did not tolerate a stable
Manager restart, undiscoverable workspace roots, a declared but unenforced
tool budget, dependency/lockfile pollution on a positive checkpoint, and two
false negatives in the offline validation container.

The fifth controlled run is the acceptance result. Qwen3.6 investigated,
implemented, arbitrated, and prepared publication artifacts; three Qwen3.8 Max
reviewers independently checked correctness, regression risk, and adversarial
boundaries in parallel.
It completed in about 11 minutes 10 seconds, unanimously approved without
revision, and reproduced the recovered 21-file patch byte-for-byte. The exact
base revision then passed the complete fixed offline CI command, including a
real Chromium isolation test. No Draft PR was published automatically from the
manual acceptance run and no result was merged.

## Legacy timeline and recovered evidence

| Action run | Duration | Last useful stage | Result |
| --- | ---: | --- | --- |
| [29936533889](https://github.com/xiaotianfotos/homerail/actions/runs/29936533889) | 1:21:45 | 19 nodes completed; arbitration approved | `finalize_publication` rejected an obvious test credential placeholder as secret-like text. This false positive was fixed independently by #108. |
| [29978048589](https://github.com/xiaotianfotos/homerail/actions/runs/29978048589) | 1:38:24 | DAG completed and emitted publication artifacts | Trusted CI rejected the 3,432-line candidate because the browser-facing protocol barrel exported Node-only `node:crypto`, `node:fs`, and `node:path` modules. |
| [29982395146](https://github.com/xiaotianfotos/homerail/actions/runs/29982395146) | 2:00:34 | Durable run remained active | The runner timed out while the DAG stayed active. Success-only artifacts retained neither candidate nor useful validation context. |
| [29990777449](https://github.com/xiaotianfotos/homerail/actions/runs/29990777449) | 1:23:28 | 13 nodes completed; duplicate final reviews in progress | The initial candidate addressed the browser-barrel regression and all three reviewers approved. The workflow nevertheless ran revision and a second complete review pass. The run was stopped before publication. |

The second candidate was 3,432 lines / 137,932 bytes with digest
`efcaa2f311730e762452b2408cb7dbaf02e93fbf2547db3880953ffdb81b8cfc`.
Trusted validation, rather than a model review, found its browser build defect.

The recovered fourth candidate is 2,570 lines / 108,919 bytes across 21 files.
Both collection handoffs contain exactly the same patch bytes with digest
`14f2c7e5c8d05d57a4926a0e2d918acade2a7aec318283f7322d2a063bc24ca7`.
Temporary exported files were one byte longer because the extraction command
appended a second final newline; those file digests are not the canonical
candidate digest. Identical handoff bytes prove that unconditional revision
consumed a complete Agent turn without changing the candidate.

The legacy fourth run retained 13 completed handoffs: deterministic checkout,
investigation and gate, implementation and gate, candidate-v1 collection,
three initial reviews, revision and gate, candidate-v2 collection, and one
final review before cancellation. All initial reviewers voted `approve`.
Correctness recorded two non-blocking observations: a rare Docker executable
failure can be described as CLI missing, and a synchronous Manager-side Docker
probe can block the event loop for up to its timeout. Neither invalidated the
Issue acceptance criteria.

Its chat snapshot recorded 3,104 model messages, 523 tool calls, and 167 tool
errors. The implementer alone used 139 tools. The three initial reviewers used
199 calls with 92 errors; the incomplete duplicate final review used another
83 calls with 70 errors. Review depth was not proportional to useful evidence.

| Legacy Agent node | Messages | Tool calls | Tool errors | Completed handoff |
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

## Controlled checkpoint-resume runs

All controlled runs used the same immutable Issue revision and the recovered
candidate checkpoint. Runs 3 through 5 bound implementation roles to Qwen3.6
and the three independent review roles to Qwen3.8 Max. They were diagnostic
acceptance runs on the stable Manager, not GitHub publication runs.

| Run | Profile | Outcome | Primary evidence |
| --- | --- | --- | --- |
| 1 | Qwen3.6 | Rejected before model dispatch | Canonical compilation passed, but runtime DAGGraph projection found ordinary cycles because the bounded feedback sources did not declare their `while` gateway dependency. |
| 2 | Qwen3.6 for every role | Durable DAG completed after cold recovery; outer runner failed | Unanimous approval skipped revision. A stable Manager deployment healed the stranded pending branch, but the waiting CLI exited on transient `fetch failed`. The recovered candidate contained 22 files, including an unwanted root lockfile. |
| 3 | Qwen3.6 implementation; Qwen3.8 Max review | Intentionally cancelled | Reviewers repeatedly probed invalid workspace roots. Normal Manager `inject` acknowledged delivery but did not reach the active turn because Worker handles that transport only in interrupt mode. |
| 4 | Qwen3.6 implementation; Qwen3.8 Max review | Intentionally cancelled | Root discovery was fixed, exposing that the declared 80-call workflow budget was not enforced. The implementer reinstalled/rebuilt/retested a positive checkpoint and polluted five package lockfiles. |
| 5 | Qwen3.6 implementation/arbitration; Qwen3.8 Max review | Accepted in about 11:10 | Three parallel reviewers unanimously approved, revision was skipped, hard budgets forced convergence while leaving DAG handoff available, and final artifacts exactly matched the recovered candidate. |

### Run 2: successful business result, failed outer wait

Run `auto-fix-qwen36-issue92-resume-2` used Qwen3.6 for every Agent role. It
completed with 19 completed and 4 skipped nodes after cold recovery. The outer
runner had already exited on `fetch failed` during a stable Manager deployment,
so its standard artifact collection did not run. Durable Manager evidence made
manual recovery possible.

| Agent node | Messages | Tool records | Tool errors |
| --- | ---: | ---: | ---: |
| investigate | 297 | 51 | 0 |
| implement | 255 | 37 | 3 |
| correctness | 147 | 28 | 0 |
| regression | 241 | 44 | 0 |
| adversarial | 249 | 47 | 0 |
| arbitrate | 153 | 26 | 0 |
| publish | 13 | 1 | 0 |

The recovered result had 22 files / 109,363 patch bytes with digest
`7dbdccd9ffac5730e72a76e814368503bfde719c1631b6b142251ed72ef9d3c9`.
It added an unwanted root `package-lock.json`, so it was evidence of workflow
progress, not the accepted candidate.

### Run 3: valid root existed but was not discoverable

Run `auto-fix-qwen36-qwen38-issue92-resume-3` ended with 9 completed, 4
cancelled, and 10 skipped nodes. The Claude SDK started at `/workspace` while
the repository ACL exposed only `source`. Generic tool denial told reviewers
what was forbidden but not what was valid, causing root-guessing loops.

| Agent node | Messages | Tool records | Tool errors | Handoff |
| --- | ---: | ---: | ---: | ---: |
| investigate | 239 | 43 | 3 | 1 |
| implement | 192 | 27 | 0 | 1 |
| correctness | 341 | 68 | 68 | 0 |
| regression | 375 | 62 | 15 | 0 |
| adversarial | 161 | 32 | 31 | 0 |

An operator attempted a normal Manager `inject`. The API reported delivery,
but Worker consumes ordinary queued input through `dag_inbox` and applies the
inject transport to an active turn only when `mode=interrupt`. This made the
operator signal look successful without correcting the active reviewers. Root
discoverability was fixed in the execution harness; inject semantics remain a
separate P2 follow-up.

### Run 4: root fixed, dead budget exposed

Run `auto-fix-qwen36-qwen38-issue92-resume-4` proved the safe root guidance
worked: correctness dropped from 68 errors in 68 records to 0 in 83, and
adversarial dropped from 31 in 32 to 0 in 35. It also proved that
`max_tool_calls_per_node: 80` was parsed and persisted but never applied by
Manager or Worker.

| Agent node | Messages | Tool records | Tool errors | Handoff |
| --- | ---: | ---: | ---: | ---: |
| investigate | 203 | 35 | 2 | 1 |
| implement | 327 | 50 | 1 | 1 |
| correctness | 445 | 83 | 0 | 0 |
| regression | 463 | 81 | 3 | 0 |
| adversarial | 195 | 35 | 0 | 1 |

The implementer also ignored positive-checkpoint guidance, repeated dependency
installation, builds, and tests, and modified lockfiles in Agent UI, CLI,
Manager, Plugin SDK, and Protocol. The 26-file / 130,093-byte result was rejected
and the canonical checkpoint restored.

### Run 5: mixed-model acceptance

Run `auto-fix-qwen36-qwen38-issue92-resume-5` completed with 19 completed and 4
skipped nodes and 274 durable events. Revision and revised-candidate collection
never ran. All three Qwen3.8 Max reviewers ran concurrently, all approved, and
Qwen3.6 arbitration approved.

| Agent node / model | Messages | Tool records | Handoffs | Tool errors |
| --- | ---: | ---: | ---: | ---: |
| investigate / Qwen3.6 | 159 | 27 | 1 | 0 |
| implement / Qwen3.6 | 109 | 18 | 1 | 0 |
| correctness / Qwen3.8 Max | 297 | 43 | 1 | 4 |
| regression / Qwen3.8 Max | 261 | 44 | 1 | 3 |
| adversarial / Qwen3.8 Max | 245 | 44 | 1 | 2 |
| arbitrate / Qwen3.6 | 139 | 23 | 1 | 0 |
| publish / Qwen3.6 | 13 | 1 | 1 | 0 |

The per-reviewer built-in limit was 40. The 41st built-in call was visibly
denied, but HomeRail DAG handoff remained available; tool records can therefore
exceed 40 through the denied attempt and DAG-tool activity. Regression first
submitted an invalid reviewer name and correctness first included an extra
`confidence` field. Contract correction produced valid handoffs without
rebuilding the run, demonstrating bounded schema recovery as well as budget
recovery.

The implementer did not install dependencies, run broad builds, or change a
lockfile. Final artifacts were:

- `auto-fix.json`: 120,983 bytes;
- `auto-fix.md`: 3,743 bytes;
- `auto-fix.patch`: 108,919 bytes;
- 21 changed files, zero lockfiles;
- patch digest
  `14f2c7e5c8d05d57a4926a0e2d918acade2a7aec318283f7322d2a063bc24ca7`.

The final patch is byte-for-byte identical to the canonical recovered
checkpoint.

## What worked

- Durable Manager handoffs preserved exact patch bytes after Actions and
  runners ended.
- Revision-bound checkpointing allowed a retry to continue from evidence
  without placing the large patch in every model prompt.
- Three independent review roles provided distinct correctness, regression,
  and adversarial perspectives; using Qwen3.8 Max for review separated review
  behavior from Qwen3.6 implementation behavior.
- Isolated trusted CI caught the browser-only defect that model review missed.
- Exact revision checkout and deterministic collection made model prose
  non-authoritative: the bytes, graph state, and tests remained the evidence.
- Stable Manager deployment preserved model configuration and durable DAG
  state across release changes.
- Contract correction repaired bounded malformed handoffs without recreating a
  run.

## Root causes

### 1. Approval did not control revision

The graph sent the candidate and all three review votes directly to `revise`.
There was no condition between review and revision. Approval changed only the
text seen by the reviser, not control flow.

### 2. Candidate durability was coupled to publication success

Only final publication artifacts existed and all used `publish: success`.
Review failure, cancellation, timeout, or finalizer rejection made a useful
candidate inaccessible through the normal artifact API.

### 3. The Action adapter discarded failure context

When `hr dag run-template --wait` failed, the runner removed temporary stdout.
It did not retrieve optional candidates, retain compact DAG evidence, or stop a
run that outlived the Action timeout.

### 4. Trusted validation was a dead end

The isolated `npm run ci` found a real browser-barrel defect, but the next run
received no structured checkpoint or bounded trusted validation feedback.

### 5. Reviewer work was insufficiently bounded

Reviewers were not directed to exact changed paths or stopped after sufficient
evidence. Repeated probes and unavailable paths produced long error-heavy tails.

### 6. Validation dependencies could be stale

An early independent check reused another worktree's stale `node_modules` and
reported `detectDagResourcePlatform is not a function`. Rebuilding dependencies
against the candidate removed the error. Clean candidate-bound environments are
authoritative.

### 7. Compile-only asset tests missed an invalid runtime graph

The two feedback sources did not declare their bounded `while` gateway as an
execution dependency. Canonical compilation passed, but runtime DAGGraph
projection treated the feedback as ordinary cycles. Asset tests now require
successful runtime projection too.

### 8. An untaken feedback source prevented successful terminalization

After unanimous approval, the revision-only feedback source remained pending.
One predecessor had been skipped and could never emit the event required for
ordinary promotion. Runtime reconciliation now promotes a settled reachable
node or marks an unreachable branch skipped; cold recovery applies the same
repair to already-persisted runs.

### 9. Stable Manager restart was treated as permanent runner failure

The durable run survived deployment, but the waiting CLI failed on the first
transient status `fetch failed`. Run and artifact polling now tolerate up to
180 seconds of continuous Manager outage, reset the outage window after a
successful poll, and retain the final poll error in a real timeout.

### 10. Workspace policy denied invalid paths without revealing valid roots

The checkout ACL was correct, but error text and prompts did not make `source`
discoverable from the SDK working directory. The harness now supplies safe
relative root guidance while retaining path containment.

### 11. Normal inject acknowledgement did not mean active-turn delivery

Worker only applies the inject transport to an active turn in interrupt mode;
ordinary queued actor input uses `dag_inbox`. The diagnostic API therefore
acknowledged a message that did not redirect the active review. This is an
operator-intervention semantics gap and remains a P2 follow-up.

### 12. Tool-budget configuration was inert

`max_tool_calls_per_node` existed in the workflow, but Manager did not derive a
Worker limit from it and Worker did not enforce a built-in call budget. The
runtime now propagates an optional per-node budget and enforces the smaller of
the node and workflow limits. HomeRail DAG tools remain available so an Agent
can always hand off after inspection is exhausted.

### 13. Positive-checkpoint prompts did not prevent destructive busywork

Soft instructions did not stop dependency installation, broad validation, or
lockfile edits. Positive checkpoints now explicitly forbid those operations,
use a soft 16-call verification target, and run under hard per-node ceilings.
Trusted validation, not the implementer, owns full CI.

### 14. The offline validator had two environment-induced false negatives

The fixed command first failed because the container mounted `/tmp` with
`noexec`; a fake Git fixture could not execute, so process lookup fell through
to real Git and attempted an offline network call. Candidate validation now
uses an executable but still `tmpfs`, `nosuid`, `nodev` temporary mount.

It then failed because the generic Node image had no Playwright browser. The
validator now defaults to a digest-pinned Playwright image with Node 24 and a
known Chromium installation. Network remains disabled, capabilities are
dropped, `no-new-privileges` remains set, and credentials and host sockets are
not mounted.

## Corrective design

The workflow is now a durable bounded state machine:

1. implementation creates `candidate-v1.json/.patch` with `publish: always`;
2. three independent reviewers run in parallel;
3. unanimous approval skips revision and proceeds to arbitration;
4. a concrete rejection permits exactly one revision and one re-review;
5. a second rejection stops publication while retaining the latest candidate;
6. the stable runner records the newest candidate in Manager state keyed by
   repository and Issue;
7. retry at the same immutable revision applies that candidate and provides at
   most 30 KB of trusted validation feedback;
8. the checkpoint patch is removed from the model-facing Issue envelope;
9. timeout or command failure stops the durable run and retains quick status,
   chats, handoffs, candidate artifacts, and checkpoint metadata;
10. successful Draft PR publication marks the checkpoint complete and removes
    its current patch;
11. asset tests compile and project the canonical workflow into a validated
    runtime DAGGraph;
12. runtime reconciliation settles unreachable pending branches after every
    transition and during cold recovery;
13. safe root hints expose only allowed relative roots;
14. hard built-in tool budgets enforce the smaller node/workflow limit while
    preserving DAG handoff;
15. positive-checkpoint roles do not install dependencies, modify lockfiles, or
    repeat broad suites;
16. stable run/artifact polling tolerates a bounded Manager restart;
17. trusted validation uses an exact revision, executable isolated fixtures,
    and a digest-pinned browser image.

## Corrective-action matrix

| Priority | Action | Verification |
| --- | --- | --- |
| P0 | Publish v1/v2 candidates with `publish: always` | failure or cancellation leaves a ready candidate artifact |
| P0 | Record a revision-bound Manager checkpoint | retry reports `checkout.mode=resumed` only at the exact revision |
| P0 | Make reviewer votes control revision | unanimous review skips `revise`; rejection permits one pass |
| P0 | Stop a run that outlives its runner | timeout leaves no orphan active DAG and retains bounded diagnostics |
| P0 | Validate runtime DAGGraph projection | asset tests reject unsyncable feedback before deployment |
| P0 | Settle dormant feedback after loop exit | success terminalizes with the unused branch skipped |
| P0 | Enforce built-in tool budgets | call N+1 is denied while DAG handoff still succeeds |
| P0 | Make exact-base full CI authoritative | fixed offline command, including Chromium, passes before publication |
| P1 | Feed trusted validation failure into retry | investigation receives at most the final 30 KB without duplicate patch bytes |
| P1 | Expose safe workspace roots | reviewers start at `source` without host-path disclosure |
| P1 | Bound positive-checkpoint verification | no dependency install, lockfile edit, broad suite, or candidate rewrite |
| P1 | Survive stable Manager deployment | run and artifact waits continue across a transient outage up to 180 seconds |
| P1 | Keep model binding private and replaceable | public template contains no provider/model URL or key; all roles may share one model or use separate implementation/review settings |
| P2 | Align normal inject with actual delivery | acknowledgement must mean active delivery or explicitly identify queued `dag_inbox` semantics |

## Exact-base validation

The accepted 21-file candidate was applied to exact base revision
`2d1d885f15f98358528e1b4f2f5e58002ebe8473` and passed the complete fixed
offline validation command:

- Protocol: 24 files / 304 tests;
- Plugin SDK: 7 files / 35 tests;
- Manager: 128 passed and 1 skipped files; 1,068 passed and 2 skipped tests;
- Node: 16 passed and 1 skipped files; 187 passed and 2 skipped tests;
- Worker: 27 files; 321 passed and 1 skipped tests;
- CLI: 18 files / 251 tests;
- Agent UI: 80 files / 418 tests, including real Chromium isolation;
- live validator: 66 tests on the exact base plus candidate.

The final validator line was:

```text
Auto Fix candidate passed the fixed offline validation command at 2d1d885f15f98358528e1b4f2f5e58002ebe8473.
```

The current PR branch independently passes 72 live-validator contract tests;
the lower exact-base count reflects the older base plus candidate, not skipped
validation.

## Exit criteria and remaining work

- **Approval/resume path: live proven.** Qwen3.6 implementation plus three
  parallel Qwen3.8 Max reviewers reproduced the checkpoint exactly and skipped
  revision.
- **Stopped-candidate resume: live proven.** The exact revision checkpoint was
  restored through the Manager durable-state API, not direct database editing.
- **Trusted full validation: live proven.** The exact-base candidate passed the
  fixed offline CI command including Chromium.
- **Stable Manager reconnect: implementation and regression test complete.**
  CLI and live-validator suites pass; this did not require another model run
  because DAG semantics and candidate bytes did not change.
- **Rejection/revision path: deterministically covered, not forced live.** Tests
  prove one rejection permits one revision/re-review and a second rejection
  terminates. A deliberately bad paid-model candidate was not manufactured
  solely to exercise this branch.
- **Normal inject semantics: still P2.** Delivery acknowledgement should not be
  confused with active-turn intervention.

Manual acceptance did not invoke GitHub publication. In the production Action,
only trusted validation can lead to a human-gated Draft PR. Review approval and
every merge remain human decisions.
