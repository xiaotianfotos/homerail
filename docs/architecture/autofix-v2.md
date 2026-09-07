# Auto Fix v2: Document-First, Draft-PR-Backed Repair

Status: Opt-in MVP implemented and locally verified; real Draft-PR pilot
pending

This document defines a replacement architecture for the current Auto Fix
scenario. It keeps the existing workflow available for rollback and introduces
`auto-fix-v2` as a manual, shadow-mode scenario until the new control-plane
primitives have been proven on real Draft pull requests.

The central rule is that an immutable task document is the source of truth.
The Draft pull request is a mutable delivery surface, and model conversation
history is never required to recover the task.

The current MVP enforces immutable inputs, secure dynamic fan-out, fresh review
sessions, fenced PR reads/writes, mandatory Manager-verified local test reports,
and quantitative review convergence. It deliberately does not consume GitHub
CI while iterating. Repository CI begins only after the DAG has converged. A
real Draft-PR pilot remains necessary before production adoption.

## Problem Statement

The current [`auto-fix.yaml.template`](../scenarios/auto-fix.md) combines issue
sanitization, repository preparation, investigation, implementation, patch
capture, three independent reviews, revision, re-review, arbitration,
publication, checkpointing, validation, and Draft PR creation.

The compiled workflow has 47 nodes and 70 edges against limits of 48 nodes and
80 edges. Twenty-four nodes are terminal outcomes. The workflow also contains
two nearly identical patch collectors for the initial implementation and the
single revision.

Recent production runs have failed at multiple unrelated layers: orchestration,
external fetches, timeout handling, publication, and deterministic build
validation. In one run the model reviewers approved a candidate that later
failed the real Vite build. More review roles therefore do not solve the core
problem: the workflow has too many states, and model consensus is being asked
to stand in for durable task state and deterministic evidence.

## Goals

- Bind every run to an immutable, content-addressed task document.
- Bind every mutable PR operation to an exact repository, PR number, branch,
  base SHA, and expected head SHA.
- Require the trusted caller to supply a bounded, immutable work plan.
- Dynamically fan out one to three independent Qwen3.8-Max implementers.
- Use a Qwen3.8-Max aggregator to integrate worker patches.
- Use a fresh-context GLM-5.2 reviewer for every review round.
- Dynamically create a fresh Qwen3.8-Max fixer when review rejects the
  current candidate.
- Bound the loop to four fixes and require two consecutive clean fresh-context
  reviews of the final unchanged head.
- Give remote PR write capability only to the aggregator and fixers, through a
  Manager-side broker. Reviewers receive read-only PR capability.
- Preserve enough durable state to recover without an Agent transcript.
- Require all caller-authored bounded container tests after aggregation and
  every fix, without dispatching GitHub CI.

## Non-Goals

- Automatically approving, marking ready, merging, retargeting, or closing a
  pull request.
- Force-pushing or deleting a branch.
- Passing GitHub tokens, SSH keys, or credential files into Workers.
- Mounting arbitrary caller-selected host paths into Workers.
- Supporting fork pull requests, cross-repository changes, or multiple PRs in
  the first release.
- Letting the caller emit arbitrary graph patches. The first release supports
  a bounded list of parallel-safe work items only.
- Replacing the current Auto Fix workflow before the pilot gates pass.

## Invariants

1. `task_document_sha256` never changes during a run.
2. Every patch names the exact source tree SHA against which it was produced.
3. Every PR write uses an `expected_head_sha` precondition and is
   fast-forward-only.
4. A dynamic child receives an explicit, fail-closed tool, workspace,
   credential, and session policy.
5. Implementers never receive remote repository credentials or PR mutation
   tools.
6. A candidate or fix handoff is invalid without a SHA-256-bound TestReport
   file in the producer's sole writable workspace. Manager validates its path,
   bytes, JSON contract, exact head, manifest binding, and passing status.
7. A review round uses a new provider session and receives no prior model
   transcript.
8. Missing evidence, head drift, invalid contracts, incomplete diff coverage,
   or exhausted fixes produce explicit non-success outcomes.
9. Manager, not GLM, computes review quality from structured findings, full
   diff coverage, and the exact-head TestReport. Zero actionable defect load
   must be confirmed by a second fresh reviewer on the unchanged head.
10. The DAG's successful outcome is `ready_for_ci`, not merge approval. It does
    not change the PR's Draft state.

## Proposed Flow

```text
caller creates immutable task + task-plan inputs and identifies an existing Draft PR
  -> bind task SHA + immutable PR base/head snapshot
  -> validate the caller-authored 1..3 parallel-safe WorkItems
  -> dynamic Qwen3.8-Max implementers work in isolated worktrees
  -> deterministic patch collection and safety checks
  -> Qwen3.8-Max aggregator integrates patches in declared order
       -> run every immutable local_tests command
       -> broker fast-forward pushes candidate round 1 to Draft PR
       -> write and hash required local TestReport outside the PR commit
  -> fresh GLM reads every exact-head diff through EOF and emits findings
       -> Manager assesses weighted defect load + 100% coverage + TestReport
       -> clean: second fresh GLM repeats full review on the unchanged head
            -> clean again: ready_for_ci
            -> defect: fresh Qwen3.8-Max fixer
       -> defect: fresh Qwen3.8-Max fixer
  -> fixer runs every local_test, publishes one fenced commit, writes TestReport
       -> fresh primary review, then clean confirmation
  -> fourth unsuccessful fix cycle: needs_human
  -> after DAG convergence only: caller starts normal repository CI
```

One fix round is one mutation attempt followed by fresh review. Most tasks
should converge in one to three fixes. A fourth unsuccessful fix cycle
terminates as `needs_human`; graph iteration caps are safety bounds, not model
or tool-call budgets.

## Run Input Artifacts

### Why prompt text is insufficient

The current Manager Agent `create_and_run` surface accepts a workflow, profile,
prompt, and run id. A prompt does not provide immutable file identity, durable
content storage, or a safe way for a Worker to access a caller-local design
document. Workers also cannot see arbitrary host paths.

### Proposed API

Add a staging operation that writes bounded content to Manager-owned,
content-addressed storage:

```json
{
  "name": "task.md",
  "media_type": "text/markdown",
  "content": "..."
}
```

It returns an immutable descriptor:

```json
{
  "artifact_id": "run-input-...",
  "sha256": "...",
  "size_bytes": 12345,
  "media_type": "text/markdown"
}
```

`create_and_run` and `start_supervised_dag` then accept bounded input bindings:

```json
{
  "workflow_id": "auto-fix-v2",
  "profile": "auto-fix-v2-mixed",
  "input_artifacts": [
    {
      "artifact_id": "run-input-...",
      "logical_name": "task_document",
      "mount_path": "input/task.md"
    },
    {
      "artifact_id": "run-input-plan-...",
      "logical_name": "task_plan",
      "mount_path": "input/task-plan.json"
    }
  ]
}
```

Requirements:

- accept at most 16 files and 1 MiB per file in the first version;
- allow only declared text and JSON media types;
- validate names and relative mount paths before storage;
- bind artifacts atomically when the run is created;
- store the descriptor and digest in immutable run provenance;
- expose the content to Workers through a Manager/Node-controlled read-only
  projection, never a caller-selected host bind mount;
- expose a read-only `$run_input/<logical_name>` resolver to trusted command
  nodes;
- verify the digest when materializing and whenever recovery reconstructs a
  run;
- retain inputs at least as long as run evidence and checkpoints;
- reject writes to the projected input path at the sandbox boundary.

The task document itself should contain the objective, constraints, detailed
design, acceptance criteria, excluded paths, and required validation. PR
metadata belongs in the structured run input, not in the document body. Use the
[`Auto Fix v2 task template`](../scenarios/auto-fix-v2-task-template.md) as the
caller-facing authoring contract. The caller also supplies a versioned
`task-plan.json` whose `task_document_sha256` binds it to that exact document.

## PR Binding

The caller creates or selects an existing Draft PR before starting the DAG. The
run binds this immutable context:

```json
{
  "version": 1,
  "owner": "owner",
  "repo": "name",
  "pull_number": 123,
  "clone_url": "https://github.com/owner/name.git",
  "head_ref": "autofix/task-123",
  "base_ref": "main",
  "initial_head_sha": "...",
  "base_sha": "...",
  "task_document_sha256": "...",
  "require_draft": true,
  "writable_paths": ["src", "tests"]
}
```

The binding command verifies that the PR is open, is a Draft, is in the same
repository, targets an allowed base branch, and has an allowed automation head
branch. Each successful push returns a new head SHA, which becomes the only
valid precondition for the next round.

If a human or another automation changes the PR head during a run, the run
enters `head_drift` and stops mutating the PR. It must not silently merge,
rebase, force-push, or re-plan against the new head. A caller may start a new run
using the same task document revision and a new PR snapshot.

## Workflow Contracts

The WorkflowSpec should define these bounded contracts:

| Contract | Required content |
| --- | --- |
| `TaskManifest` | artifact id, digest, media type, size, logical path |
| `PRContext` | repo, PR, draft state, base/head branches and SHAs, explicit writable prefixes |
| `BoundTask` | task manifest plus verified PR context and policy id |
| `WorkPlan` | plan digest, 1..3 work items, integration order, required local test commands |
| `WorkItem` | id, objective, allowed paths, acceptance checks, context paths, risk |
| `ImplementationResult` | work item id, base SHA, patch artifact, files, tests, status |
| `AggregateCandidate` | exact head and manifest digests, summary, TestReport reference |
| `TestReport` | phase, exact head/manifest, every required command, exit status, duration, bounded output, overall status |
| `ReviewVerdict` | reviewed head, structured findings, Manager-computed coverage/load/score/status |
| `FixResult` | previous/current head, manifest, summary, TestReport reference |
| `LoopState` | task SHA, current PR head, round, candidate and evidence digests |
| `AutoFixV2Result` | exact final head, task/plan digests, two-review confirmation, findings/test digests, score, and `ready_for_ci` |

Every finding must have a stable id, severity, file, optional line, evidence,
and a concrete expected correction. The fixer reports which finding ids it
resolved or rejected.

### Caller-authored plan restrictions

The trusted caller may supply one to three work items. In the first release
every item must be parallel-safe:

- no dependencies on another work item's uncommitted output;
- an explicit allowed-path set;
- an explicit acceptance check;
- a declared integration order;
- overlapping paths identified as a conflict risk.

If the task cannot be represented safely, the caller supplies one combined
work item or does not start the run. The plan cannot request arbitrary dynamic
nodes or edges.

## Secure Dynamic Fan-Out

The v1 `fanout` gateway records a bounded worker Agent policy and materializes
that policy onto every dynamically appended child node.

The strict v1 fan-out configuration uses a validated worker policy. An
isolated Git worktree must opt in with the reserved
`{{fanout_workspace}}` placeholder:

```yaml
config:
  input: plan
  item_field: work_items
  max_items: 3
  max_parallelism: 3
  completion: all
  worker_agent: implementer
  worker_policy:
    session_scope: dispatch
    allowed_builtin_tools: [Bash, Read, Write, Edit, Grep, Glob]
    allowed_dag_tools: [handoff]
    workspace_access:
      writable_paths: ["{{fanout_workspace}}"]
      readonly_paths: [input, evidence]
    credentials: []
  workspace_strategy: isolated_git_worktree
  workspace_root: workers
  repository_path: repo
  result_git_commit:
    commit_field: commit_sha
    workspace_field: workspace_path
    require_clean: true
    commit_mode: manager
```

Its semantics are:

- the compiler validates the complete template;
- every child receives a canonical copy of it;
- Auto Fix v2 deliberately leaves both node-level and workflow-level tool-call
  budget fields unset; completion is governed by handoff contracts,
  model/runtime limits, and operator cancellation rather than a fixed
  tool-call budget;
- omitted tool allowlists are empty for dynamic children unless the workflow
  explicitly selects `builtin_tool_policy: backend_native`;
- `backend_native` is mutually exclusive with `allowed_builtin_tools`, requires
  declared workspace access, and is accepted only by a backend that explicitly
  supports the policy (currently Codex app-server);
- omitted credentials mean no credentials;
- omitted workspace access means no writable paths;
- `isolated_git_worktree` is rejected unless the worker policy declares
  exactly `{{fanout_workspace}}`; Manager replaces that placeholder with the
  unique child worktree path before dispatch, so isolation does not imply a
  hidden write grant;
- only `handoff` is available unless DAG tools are declared explicitly;
- each child has a unique logical actor, provider session, and isolated
  worktree based on the same immutable source SHA;
- when a dispatch declares exactly one writable path, Node mounts the run
  workspace read-only and overlays only that exact subtree read-write. Sibling
  worktrees remain physically read-only even though Worker snapshots exclude
  their concurrent Manager-owned changes;
- with `commit_mode: manager`, Git metadata remains read-only to the model. A
  successful child reports its exact worktree with intended file changes;
  `workspace_access.git_metadata_read_only: true` makes Node apply a final
  read-only nested mount over that worktree's `.git`, and
  Manager runs Git with host/global configuration disabled plus hooks, signing,
  credential helpers, non-HTTPS transports, fsmonitor, and external diff
  commands forced off. Manager then validates the binding, stages and commits
  those changes under a deterministic identity, enriches the result with the
  new exact HEAD, and verifies that the worktree is clean before aggregation.
  A no-op or a fabricated workspace is rejected;
- child corrections retain the same policy and cannot broaden it;
- runtime events expose the effective policy digest for audit.

The existing `worker_agent` form may remain for compatibility, but it must not
create write-capable or credential-bearing children through permissive defaults.

## Aggregation

Implementers hand off changed worktrees; they do not write Git metadata, merge
branches, or push. HomeRail's Worker boundary first rejects changes outside the
declared worktree policy. Manager then creates and validates one commit per
successful worker, preserving a durable exact proposal without granting the
model access to the shared repository's `.git` directory.

The Qwen3.8-Max aggregator receives the immutable task, WorkPlan, bounded worker
reports, Manager-created commits, and conflict metadata. It inspects those
commits read-only and copies or applies their file changes in WorkPlan order to
the integration checkout; it does not stage, commit, merge, or cherry-pick. It
may resolve integration conflicts and add glue changes, but all resulting
changes remain subject to the global path policy and deterministic patch
collector.

The aggregator is the first model node allowed to request a PR write. It passes
only its exact Manager-declared writable worktree, a bounded commit message,
and the expected head SHA to `commit_workspace`. Manager independently derives
the complete dirty-file manifest, reads the bytes, and publishes one atomic
candidate commit. The model neither serializes large base64 payloads nor
chooses a partial file list, and it never receives the underlying credential.

## Local Test Evidence And Quantitative Convergence

GitHub CI is intentionally outside this DAG. It is a finite repository resource
and should validate a converged change, not serve as the inner-loop debugger.
The trusted caller therefore supplies a non-empty bounded `local_tests` list in
the immutable WorkPlan. Every item has a required 1–1800 second process timeout;
this is not a model or tool-call budget. The aggregator and every fixer run
every command inside their disposable container worktree.

After source publication, the producer writes a JSON TestReport below its own
`.homerail/test-reports/` directory. Writing after `commit_workspace` keeps the
report out of the PR. The handoff includes its relative path, SHA-256, and
status. A reusable WorkflowSpec `required_workspace_files` rule makes Manager:

- resolve the path below the producer's sole writable workspace;
- reject absolute paths, traversal, symlinks, non-files, invalid UTF-8, and
  oversized content;
- verify the byte digest and JSON contract;
- bind exact report fields such as head, manifest, and status to the handoff;
- copy the accepted bytes into a content-addressed `workspace_evidence` run
  artifact in the same Manager transaction as the handoff.

The persisted TestReport artifact is the review and audit source of truth. Worker
workspace retention can therefore expire without deleting the evidence used to
assess the exact head, and the report remains retrievable through the normal
run-artifact API. It is never added to the Draft PR.

Review quality is also Manager-computed. Each fresh GLM returns structured
findings, classifying every real defect as actionable. Non-actionable advice is
allowed only with `preexisting`, `out_of_scope`, or `optional_preference`.
Before handoff the reviewer calls `assess_review`; Manager verifies that
`read_diff` covered every current PR path contiguously from offset zero through
EOF, locates the verified TestReport for the exact head, hashes the findings,
and calculates:

```text
defect_load = 16*critical + 8*high + 3*medium + 1*low
quality_score = max(0, 100 - defect_load)
clean = defect_load == 0 && diff_coverage == 1.0 && test_report == passed
```

A single clean result is not convergence. A second GLM dispatch with a fresh
provider session must independently return clean for the same unchanged head.
A trusted confirmation node rejects the pair unless both exact head and
Manager-verified TestReport digest match. Any fixer mutation resets
confirmation. Four exhausted fixer iterations end in `needs_human`. Once
converged, the caller may start the repository's normal CI; CI failure is new
evidence for a later run rather than an event polled by this completed DAG.

On success, a trusted deterministic finalizer emits `autofix-result.json` with
`status: ready_for_ci`, the exact PR head, immutable task and plan digests, the
two-review confirmation count, final findings digest, exact TestReport digest,
and quality score. Model inability (`cannot_implement` or `cannot_fix`) and fix
exhaustion end as `needs_human`; policy violations and invalid trusted evidence
remain hard failures.

## Fresh-Context Review And Fix Rounds

Add a declarative dispatch-scoped session policy for Agent nodes and dynamic
workers. `session_scope: dispatch` means:

- Manager creates a new provider session id for every completed node re-entry
  or review/fix round;
- no provider-native transcript is resumed;
- a bounded handoff-contract correction retains the same provider session and
  same-session broker receipts because it retries the rejected logical
  dispatch; after a valid handoff, the next loop iteration receives a fresh
  session id;
- the run still retains all transcripts as audit evidence, but they are not
  model input.

GLM receives only the immutable task, current PR context and diff, the current
TestReport reference, and exact-head repository bytes returned by the read-only
`read_file` broker action. It has no local repository mount, so an uncommitted
integration or fixer worktree cannot be mistaken for the Draft PR. A new Qwen3.8-Max fixer
receives those inputs plus the current structured findings. Neither receives
previous review prose that is absent from the current contract.

Read-evidence receipts from one completed dispatch are not valid in a later
review round, even when it is the same logical review node after recovery or a
loop iteration. A correction of that dispatch may reuse its already-recorded
receipts or repeat only the broker actions declared as hard output evidence for
that port in the same session before handing off. This preserves prerequisite
reads such as `pull_request_snapshot` and `assess_review` alongside the final
review handoff or `commit_workspace` call; correction still cannot use built-in
tools, mutate beyond the original capability, or broaden the permitted broker
actions.

Tests must assert unique provider session ids, not merely different logical
round ids.

## GitHub PR Capability Broker

The Manager-side `github_pr` broker implements these first-version actions:

| Action | Purpose |
| --- | --- |
| `pull_request_snapshot` | Return bounded immutable PR metadata and the changed-file inventory |
| `read_diff` | Return one bounded GitHub PR patch chunk for a changed path on the exact current head |
| `read_file` | Return one bounded UTF-8 file chunk from the exact current head SHA |
| `assess_review` | Verify full per-session diff coverage and exact-head TestReport, then compute finding digest, defect load, score, and clean status |
| `checks_snapshot` | Return bounded checks for the current exact head SHA |
| `required_checks` | Fail unless every immutable required check succeeds on that head |
| `validate_head` | Optionally dispatch trusted validation and wait for required checks on one exact head |
| `commit_workspace` | Derive every dirty file from the node's unique writable worktree and publish one commit |
| `commit_files` | Create bounded blobs/tree/commit and fast-forward the bound head branch |

`checks_snapshot`, `required_checks`, and `validate_head` remain generic broker
capabilities for other workflows. Auto Fix v2 does not project or call them.

`commit_workspace` and the lower-level compatibility action `commit_files`
share the GitHub mutation fence. Auto Fix v2 uses only `commit_workspace`,
which additionally enforces:

- the caller-supplied `workspace_path` equals the node's one declared writable
  path;
- the worktree HEAD equals `expected_head_sha`, its top-level and Git metadata
  remain inside the run workspace, and changed paths contain no symlink;
- every tracked or non-ignored untracked dirty path is included in one sorted
  manifest;
- the returned `manifest_sha256` and `head_sha` both match the structured
  candidate/fix handoff.

The shared mutation fence enforces:

- the run's exact repository, PR, base branch, and head branch binding;
- `expected_head_sha` equals the remote PR head immediately before push;
- no force push and no non-fast-forward update;
- explicit writable prefixes (`"."` is invalid) and an unconditional deny for
  `.github/**`, `.git/**`, and mounted input paths;
- at most 64 unique regular-file paths and 1 MiB total decoded bytes;
- regular or executable blob modes only, with no symlink or submodule
  operation; `commit_workspace` may delete only a tracked path that trusted Git
  inspection reports deleted in the bound worktree;
- a bounded single-line commit message;
- durable current/pending-head reconciliation across Manager recovery.

GitHub's blob/tree/commit/ref calls are not atomic as a group. A failure before
the final non-force ref update may leave unreachable Git objects, but cannot
advance the PR head. File/byte bounds, expected-head recovery, and operator
rate-limit discipline keep this failure mode bounded.

The broker must never expose token values or provider error bodies containing
secrets. A Worker call requires `credential_broker_call` plus the exact
declared action; a Manager `broker` node receives exactly one projected action
and has no Worker tool surface.
The PR snapshot deliberately omits per-file patch bodies and bounds the PR
description so a 100-file inventory remains inline in Claude Agent SDK instead
of being redirected to an SDK-private temporary file outside the reviewer's
read-only workspace. The reviewer obtains trusted source bytes through
exact-head `read_file` calls for the inventory paths relevant to its decision.
The reviewer first calls `read_diff` per inventory path so review cost scales
with changed hunks rather than whole repository files. GitHub may omit a patch
for binary or oversized diffs; `patch_available` is explicit and the reviewer
falls back to exact-head file chunks and acceptance-test evidence.
`read_file` accepts an optional Unicode-character `offset` and `max_chars`,
returns `next_offset`, and caps each JSON-escaped content chunk below the SDK
inline-result threshold. A reviewer can therefore inspect a large UTF-8 source
file without receiving a host path it is forbidden to read. The broker still
hashes and binds the complete exact-head file and rejects files above 1 MiB.
The tool schema enumerates the credential references and action names actually
projected into that dispatch, and its description lists the valid
credential/action pairs. Trusted runtime validation remains authoritative for
the pair and its action-specific input.

### Node permission matrix

| Role | Repository workspace | Built-in tools | PR broker |
| --- | --- | --- | --- |
| Binder | trusted command | fixed command only | `pull_request_snapshot` |
| Caller plan validator | trusted command | fixed command only | none |
| Qwen3.8-Max implementer | isolated worktree | bounded read/write/shell | none |
| Qwen3.8-Max aggregator | integration worktree | bounded read/write/shell | `pull_request_snapshot`, `commit_workspace` |
| GLM reviewer | immutable input only; exact diffs/files via broker | Read/Grep/Glob | `pull_request_snapshot`, `read_diff`, `read_file`, `assess_review` |
| Qwen3.8-Max fixer | fresh integration worktree | bounded read/write/shell | `pull_request_snapshot`, `commit_workspace` |

Reviewer mutation is intentionally excluded. If operator-visible comments are
required later, add only `post_comment`; never grant review approval or merge
actions.

## Model Routing

The workflow remains provider-neutral. Model bindings live in a DB runtime
profile:

| Agent role | Required setting |
| --- | --- |
| `implementer` | Qwen3.8-Max |
| `aggregator` | Qwen3.8-Max |
| `fixer` | Qwen3.8-Max |
| `reviewer` | GLM-5.2 |

All Qwen3.8-Max roles use the container Codex app-server Responses
harness with explicit `reasoning_effort: max` and explicit
`builtin_tool_policy: backend_native`; their long reasoning phase is normal and
is not an execution timeout signal. The adapter waits until a notification,
operator cancellation, or child-process exit and emits a content-free reasoning
heartbeat every 30 seconds of silence. Worker converts reasoning events into a
throttled generic activity renewal without streaming or persisting the model's
reasoning text. This mode authorizes Codex's native sandboxed shell/patch
surface, not a fictional translation to Claude tool names. The outer HomeRail
workspace policy still verifies paths after the turn, and all GitHub mutation
remains fenced behind the Manager broker. GLM-5.2 review uses the Claude Agent
SDK with a fresh dispatch-scoped session.

On Linux Docker Nodes, Manager derives a trusted `codex_nested_sandbox` worker
provisioning flag only from the combination of Codex app-server and
`backend_native`; it is not a WorkflowSpec field. Node maps that boolean to the
fixed Docker options `seccomp=unconfined` and `apparmor=unconfined`, which let
Codex create an inner unprivileged `bwrap` namespace when the dispatch retains
an inner sandbox. These Workers are not privileged and receive no added Linux
capabilities. Auto Fix v2's writable coding roles explicitly select
`codex_sandbox: danger-full-access`, so their model-issued commands are **not**
constrained by Codex's inner `workspace-write` sandbox. Their containment relies
on the disposable Worker container's mount, network, user, and cgroup
boundaries, HomeRail's post-turn workspace-policy verification, and the
Manager's credential and GitHub broker fences. Dispatches that do not opt into
`danger-full-access` may still retain Codex's inner sandbox. Other Worker
backends and Plugin Runtime isolation are unchanged.

Writable Codex dispatches also receive a trusted dependency projection when
the checked-out HomeRail dependency metadata matches the metadata baked
into the selected Worker image. Worker creates an ignored per-worktree
`node_modules` facade whose external entries point into the immutable image
cache and whose HomeRail-local entries point at the current isolated worktree.
The cache covers `homerail_protocol`, `homerail_plugin_sdk`,
`homerail_manager`, `homerail_worker`, `homerail_node`, and `homerail_cli`;
its manifests participate in the Worker source fingerprint, so deployment
cannot select an image with stale cache metadata. Read-only dispatches receive
no facade. Changed manifests,
changed locks, missing cache data, symlinked target package roots, and existing
dependency trees without HomeRail's matching projection marker all fail
closed without opening network access.

Before a real run, the stable adapter resolves each selector to exactly one
active LLM setting, confirms the required compatible harness and endpoint, and
runs bounded capability smokes for tool use, structured handoff, and fresh
session behavior. Qwen3.8-Max is selected from the built-in Aliyun Token Plan
catalog and must expose the Responses endpoint; the profile fails closed rather
than silently selecting `qwen3.8-max-preview` or another Qwen model.

## Recovery And Durable State

The durable loop state is data, not conversation:

```text
task document artifact + SHA
PR binding + current expected head SHA
WorkPlan + digest
worker patch artifacts + digests
aggregate/fix candidate + digest
round number
verified local TestReport path + digest + command results
current ReviewVerdict + Manager quality assessment
broker action receipts
```

On recovery:

1. verify the task artifact digest;
2. restore the exact WorkflowSpec revision and runtime profile identity;
3. resolve the current PR head through the broker;
4. continue only when it equals the stored expected head;
5. otherwise enter `head_drift` and retain all evidence.

Post-convergence CI is a separate lifecycle. Its timeout must not reopen or
silently mutate this completed logical run.

## Observability

The run summary and CLI should expose:

- task document digest and PR base/head binding;
- planner model and WorkPlan digest;
- number of fan-out children, their effective policy digests, worktree ids,
  status, patch digest, and focused tests;
- aggregation order and conflicts;
- candidate round, local test report digest/status, reviewer provider session
  id, diff coverage, weighted defect load, score, finding ids, and fixer id;
- clean-confirmation streak for the unchanged exact head;
- every broker call with redacted input and immutable receipt;
- final outcome and the next human action.

Template listing and validation should report dynamic worker templates and
their effective node/parallelism limits instead of showing zero nodes for a
strict v1 template.

## Pilot And Rollout

1. Land the four control-plane prerequisites behind explicit feature flags.
2. Test them with deterministic providers and a fake GitHub remote.
3. Add `auto-fix-v2` as a new workflow id; do not change `auto-fix`.
4. Run `dry_run` mode, which produces patches and broker requests but cannot
   push.
5. Select an owner-authored, low-risk Issue with an existing Draft PR, at most
   three independent work items, and fewer than approximately twenty changed
   files.
6. Exclude `.github/**`, credentials, dependency upgrades, migrations, release
   automation, and security-sensitive infrastructure from the first pilot.
7. Run one real Draft-PR pilot with no auto-ready or merge behavior.
8. Expand only after at least four of five eligible pilots produce a locally
   tested, review-converged Draft PR that later passes repository CI within the
   agreed operational window and no capability boundary is violated.

The current Auto Fix workflow can be deprecated only after the pilot evidence
shows that v2 has better completion rate, wall time, recovery, and operator
clarity.

## Open Decisions

- Whether run input blobs live in the Manager database or a Manager-owned
  content-addressed file store. The public contract should not depend on this.
- Whether reviewer comments should be posted during the pilot. The safer
  default is to keep review evidence inside HomeRail and post only the final
  summary after human inspection.
