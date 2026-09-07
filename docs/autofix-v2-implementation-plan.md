# Auto Fix v2 Implementation Plan

Proposed GitHub Issue title:

> feat(autofix-v2): document-first Draft-PR repair DAG with secure dynamic fan-out

Status: Opt-in MVP implemented and locally verified on 2026-08-02. The real
Draft-PR pilot and production adoption gates remain open. This is the umbrella
delivery plan for [`Auto Fix v2`](architecture/autofix-v2.md); it does not
authorize replacing the existing `auto-fix` workflow or enabling automatic PR
publication.

## Implementation checkpoint (2026-08-03)

The local-test convergence revision supersedes earlier checklist text that put
`validate_head` or `required_checks` inside Auto Fix v2. Those broker actions
remain generic infrastructure but are not part of this DAG.

Implemented in the MVP:

- content-addressed, immutable run inputs with read-only Worker projection and
  recovery verification;
- fail-closed dynamic worker policy inheritance, unique repeated-fanout node
  ids, and isolated Git worktrees;
- `session_scope: dispatch` for transcript-free review re-entry;
- a Manager-only `github_pr` broker for bounded exact-head PR reads,
  Manager-computed review assessment, and expected-head, non-force
  complete-workspace commits;
- generic required-workspace-file evidence that validates a producer-local JSON
  report before accepting its handoff and persists accepted bytes as a durable
  content-addressed run artifact;
- an opt-in `auto-fix-v2` WorkflowSpec, mixed-model profile
  configurator, CLI input staging, operator runbook, and deterministic fake
  remote/recovery proof.

Required before the first real low-risk Issue pilot:

- create the same-repository Draft PR and immutable `pr-context.json`;
- install `github-autofix` as an encrypted fine-grained PAT or GitHub App
  credential;
- verify the stable Manager still has active, runnable Qwen3.8-Max and
  GLM-5.2 settings after deploying the v2-capable release;
- sync the opt-in workflow and mixed-model profile, then run a
  broker-write-disabled real PR snapshot dry run;
- encode a non-empty bounded `local_tests` list in `task-plan.json`; repository
  CI remains deferred until the DAG converges.

## Outcome

Deliver a manual `auto-fix-v2` workflow in which:

- a caller stages an immutable local task document, a bound task plan, and a
  Draft PR context;
- the DAG validates and executes the caller-authored one to three parallel-safe
  work items without repeating analysis inside the execution graph;
- dynamically created Qwen3.8-Max implementers work without remote
  credentials in isolated worktrees;
- a Qwen3.8-Max aggregator integrates their patches;
- aggregation and every fix submit a Manager-verified exact-head TestReport;
- GLM-5.2 reviews each candidate with a fresh provider context;
- Manager quantifies convergence from full diff coverage, weighted actionable
  findings, passing local evidence, and two clean reviews of one unchanged head;
- a new Qwen3.8-Max fixer handles each rejected round;
- no more than four fix rounds run;
- only the aggregator and fixers can request fast-forward PR writes through a
  least-privilege Manager broker;
- the successful outcome remains a Draft PR marked `ready_for_ci` in HomeRail,
  not approved, marked ready, or merged on GitHub.
- a trusted finalizer publishes `autofix-result.json` with the exact head,
  immutable task/plan digests, final review/test digests, and quality score;
- explicit model inability and exhausted fix rounds end as `needs_human`
  instead of being mislabeled as infrastructure success or merge approval.

## Delivery Rules

- Keep `assets/orchestrations/auto-fix.yaml.template` and workflow id
  `auto-fix` unchanged during the pilot.
- Introduce a new workflow id, profile id, scenario documentation, and trigger.
- Keep provider/model names out of WorkflowSpec. Bind active LLM setting ids in
  the runtime profile.
- Never store provider or GitHub secrets in repository files, workflow source,
  run prompts, artifacts, comments, or logs.
- Treat every task document, PR body, comment, diff, patch, and model output as
  untrusted input.
- Keep Manager changes inside lifecycle, persistence, public API, provider
  routing, or stable inspection/mutation boundaries.
- Require deterministic evidence for every hard gate.

## Phase 0: Freeze And Characterize

### AFV2-001: Record the current Auto Fix baseline

- [ ] Add a fixture that asserts the current compiled node/edge/kind counts.
- [ ] Record the five observed production failure classes without embedding
      private logs or credentials.
- [ ] Characterize current candidate checkpoint recovery and Draft PR adapter
      behavior.
- [ ] Add a regression assertion that v2 work does not change workflow id
      `auto-fix` or its existing runtime graph.

Done when the existing scenario has a stable compatibility baseline and can be
kept as a rollback path.

## Phase 1: Immutable Run Inputs

### AFV2-101: Persist content-addressed run input artifacts

- [ ] Define the public protocol descriptor and bounded staging request.
- [ ] Persist immutable metadata and content digest under Manager ownership.
- [ ] Enforce file count, size, media type, name, and relative-path limits.
- [ ] Bind staged artifact ids atomically to a newly created run.
- [ ] Retain inputs with run evidence and apply the existing redaction rules.
- [ ] Reject an artifact id owned by another project/caller scope.

Likely code areas:

- `homerail_protocol/src/manager-agent-tools.ts`
- Manager run-creation protocol and persistence modules
- Manager Agent tool implementations
- CLI `run` and supervised-run argument handling

### AFV2-102: Project run inputs read-only

- [ ] Expose logical inputs at a stable `$run_input/<logical_name>` resolver.
- [ ] Materialize or mount Worker input paths read-only through Manager/Node
      policy, never through arbitrary caller host paths.
- [ ] Verify the content digest before first dispatch and cold recovery.
- [ ] Reject traversal, symlink, remount, overwrite, and mutable-alias attacks.
- [ ] Expose input descriptors and digests through run inspection.

Tests:

- [ ] staging and idempotent content-addressing;
- [ ] atomic run binding and recovery;
- [ ] size, type, path, and project-scope rejection;
- [ ] write denial from Agent and command nodes;
- [ ] Worker cannot access any unstaged host path.

## Phase 2: Secure Dynamic Workers

### AFV2-201: Add a canonical fan-out worker runtime policy

- [ ] Add a strict WorkflowSpec worker template or node reference containing
      Agent, tool, workspace, credential, and session policy.
- [ ] Compile the worker policy into canonical IR and include it in workflow
      hashing.
- [ ] Copy the canonical policy to every dynamically appended child.
- [ ] Make dynamic-child defaults fail closed.
- [ ] Preserve the effective policy across correction and replay.
- [ ] Persist and expose an effective policy digest per child.

Likely code areas:

- `homerail_manager/src/orchestration/workflow-spec-v1-schema.ts`
- `homerail_manager/src/orchestration/workflow-spec-v1.ts`
- `homerail_manager/src/runtime/active-runs.ts`
- dispatch capability and runtime-policy projection

Tests:

- [ ] child inherits either an exact built-in allowlist or an explicit
      backend-native policy, plus the exact DAG tool allowlist;
- [ ] child inherits workspace restrictions without introducing a tool-call
      budget;
- [ ] child cannot acquire undeclared credentials or broker actions;
- [ ] correction and recovery do not widen policy;
- [ ] old `worker_agent` workflows remain compatible without permissive
      write/credential defaults.

### AFV2-202: Add isolated fan-out worktrees

- [ ] Create one credential-free worktree or equivalent immutable snapshot per
      dynamic child from the same source SHA.
- [ ] Restrict each child to its own writable root.
- [ ] Return bounded patch artifacts instead of shared working-tree mutations.
- [ ] Clean up physical worktrees without deleting durable patch evidence.
- [ ] Detect overlapping files and provide deterministic conflict metadata to
      aggregation.

Tests:

- [ ] two workers editing the same path cannot race through a shared checkout;
- [ ] one worker cannot read or write another worker's private mutable state;
- [ ] all patch artifacts declare the same expected base SHA;
- [ ] cleanup is safe after success, failure, timeout, and Manager restart.

## Phase 3: Fresh Dispatch Context

### AFV2-301: Add explicit provider session scope

- [ ] Add `session_scope: dispatch` to the reusable Agent runtime policy.
- [ ] Allocate a new provider session id for every completed node re-entry and
      loop iteration; keep bounded handoff corrections in the same logical
      dispatch so same-session verification receipts remain recoverable.
- [ ] Prevent provider-native transcript resume in dispatch scope.
- [ ] Retain transcript evidence without feeding it into the next dispatch.
- [ ] Make the selected scope visible through run/node inspection.

Tests:

- [ ] repeated execution of one logical review node uses distinct provider
      session ids;
- [ ] a dynamic fixer gets a new provider session;
- [ ] review prompts contain only declared task, PR, TestReport, and finding
      inputs;
- [ ] restart/replay cannot accidentally resume an old provider transcript.

## Phase 4: GitHub PR Capability Broker

### AFV2-401: Implement read-only PR and review-evidence gates

- [ ] Add a `github_pr` Manager broker with `pull_request_snapshot`,
      `read_diff`, `read_file`, and `assess_review`. Retain check actions only
      as generic compatibility capabilities outside Auto Fix v2.
- [ ] Add a generic Manager-owned `broker` DAG node with one projected
      credential/action, structured input mapping, and explicit result/error
      ports.
- [ ] Bind repo, PR, Draft state, base branch/SHA, head branch/SHA, and policy id
      to the run.
- [ ] Reject fork PRs, non-Draft PRs, disallowed branches, closed PRs, and
      mismatched repositories in the pilot.
- [ ] Return bounded, redacted, immutable receipts.
- [ ] Require complete contiguous `read_diff` coverage for every changed path
      before `assess_review` can compute a quality result.
- [ ] Bind the Manager-computed findings digest, coverage, TestReport digest,
      weighted defect load, score, and clean status to the reviewer handoff.

### AFV2-402: Implement fast-forward `commit_workspace`

- [ ] Accept only the node's exact declared writable worktree, a bounded
      message, and an exact `expected_head_sha`; derive all file bytes in
      trusted code.
- [ ] Revalidate path, file count, size, binary, symlink, submodule, and secret
      restrictions in trusted code.
- [ ] Create bounded Git blobs, a tree, and a commit without giving the Worker
      a checkout credential or Git transport.
- [ ] Re-read the remote head immediately before a fast-forward-only push.
- [ ] Return old/new head, commit, patch digest, run/node/session/generation, and
      timestamp in an immutable receipt.
- [ ] Reject force push, merge, approve, ready, close, retarget, branch delete,
      and arbitrary GitHub API operations.

Tests:

- [ ] unauthorized node and action rejection;
- [ ] secret values never enter Worker input, error output, or audit events;
- [ ] expected-head mismatch produces `head_drift` and no push;
- [ ] forbidden paths and malformed patches are rejected twice: collection and
      broker application;
- [ ] concurrent push race cannot overwrite a remote commit;
- [ ] exact idempotent retry returns the original receipt.

## Phase 5: Auto Fix v2 Workflow

### AFV2-501: Define bounded workflow contracts

- [ ] Adopt the caller-facing
      [`task document template`](scenarios/auto-fix-v2-task-template.md) and
      validate that its staged digest is the run's task identity.
- [ ] Add `TaskManifest`, `PRContext`, `BoundTask`, `WorkPlan`, `WorkItem`,
      `ImplementationResult`, `AggregateCandidate`, `TestReport`,
      `ReviewVerdict`, `FixResult`, `LoopState`, and `AutoFixV2Result`.
- [ ] Bound every string, array, patch, log, finding set, file set, and round.
- [ ] Require stable finding ids and exact source/head SHAs.
- [ ] Reject incomplete success handoffs rather than synthesizing success.

### AFV2-502: Validate the caller plan and build implementation fan-out

- [ ] Require a versioned immutable `task_plan` with one to three independent
      WorkItems bound to `task_document_sha256`.
- [ ] Reject arbitrary graph mutation and dependent parallel tasks.
- [ ] Dynamically create one Qwen3.8-Max implementer per item.
- [ ] Run each child in its isolated worktree without a PR broker.
- [ ] Capture and validate one patch artifact per successful child.

### AFV2-503: Build aggregation and local evidence

- [ ] Apply worker patches in the WorkPlan's declared order.
- [ ] Give Qwen3.8-Max an integration worktree and bounded conflict
      metadata.
- [ ] Deterministically collect the aggregate patch.
- [ ] Let the aggregator push the patch-safe first candidate through the
      fenced broker.
- [ ] Run every immutable `local_tests` command in the container after
      aggregation and every fix.
- [ ] Require a producer-local report file whose path, SHA-256, JSON contract,
      head/manifest fields, and status are verified by Manager at handoff.

### AFV2-504: Build the quantitative review/fix loop

- [ ] Push each collected candidate through `commit_workspace` using exact head
      fencing; write its local TestReport only after source publication so the
      report does not enter the PR.
- [ ] Dispatch GLM-5.2 with fresh context against the exact pushed head.
- [ ] On rejection, dynamically create one fresh Qwen3.8-Max fixer.
- [ ] Make every fix produce a new fenced patch, broker receipt, and TestReport.
- [ ] Require defect load zero, coverage 1.0, passing exact-head evidence, and
      two consecutive clean fresh-context reviews on the unchanged head.
- [ ] Allow at most four fix rounds, then end as `needs_human`.
- [ ] End convergence as `ready_for_ci`; never change Draft state.

### AFV2-505: Add the mixed-model runtime profile

- [ ] Resolve one active Qwen3.8-Max setting for `implementer`,
      `aggregator`, and `fixer`.
- [ ] Resolve one active GLM-5.2 setting for `reviewer`.
- [ ] Require Codex app-server Responses with `reasoning_effort: max` for every
      Qwen3.8-Max role and Claude Agent SDK for GLM review.
- [ ] Add preflight smokes for built-in tools, structured handoff, and fresh
      context.
- [ ] Fail explicitly when Qwen3.8-Max is unavailable; do not substitute
      `qwen3.8-max-preview`, `qwen3.7-max`, or another model.

Likely new assets:

- `assets/orchestrations/auto-fix-v2.yaml.template`
- `scripts/configure-auto-fix-v2-runtime-profile.mjs`
- `docs/scenarios/auto-fix-v2.md`

## Phase 6: Evidence, CLI, And Recovery

### AFV2-601: Make the run inspectable

- [ ] Show task digest, PR binding, current expected head, round, WorkPlan
      digest, dynamic children, policy digests, patches, validation, findings,
      fixers, and broker receipts in supported inspection surfaces.
- [ ] Make `hr templates list` report strict v1 static nodes and bounded dynamic
      worker capacity accurately.
- [ ] Ensure `hr dag quick`, chats, handoffs, scorecard, eval-run, and replay
      retain enough evidence to explain every terminal outcome.

### AFV2-602: Recover without transcript state

- [ ] Recover from task artifact, workflow revision, profile identity, PR head,
      WorkPlan, patches, loop state, and receipts.
- [ ] Continue only when task digest and current PR head match durable state.
- [ ] Preserve and report `head_drift`, expired input, invalid artifact, and
      missing-evidence outcomes.
- [ ] Stop or suspend the logical run explicitly when the outer CI job times
      out.

## Phase 7: Pilot

### AFV2-701: Deterministic and fake-remote proof

- [ ] Run schema, compiler, policy, recovery, and broker tests with deterministic
      Agents and a local fake Git remote.
- [ ] Demonstrate at least two fan-out children and one rejected review/fix
      round.
- [ ] Demonstrate denial of an implementer PR write and denial of a Reviewer
      push.
- [ ] Demonstrate four exhausted fix rounds ending in `needs_human`.

### AFV2-702: Dry-run shadow mode

- [ ] Run against a real Draft PR snapshot with broker writes disabled.
- [ ] Produce the exact patches and broker requests that would have occurred.
- [ ] Verify no remote mutation and complete retained evidence.

### AFV2-703: First real Draft-PR pilot

Select an owner-authored task with:

- [ ] one to three independent work items;
- [ ] fewer than approximately twenty changed files;
- [ ] no workflow, credential, dependency, migration, release, or
      security-sensitive infrastructure changes;
- [ ] a pre-created same-repository Draft PR and automation-owned head branch;
- [ ] explicit bounded `local_tests` commands in the immutable task plan.

As of 2026-08-01, the recommended multi-worker pilot candidate is
[`xiaotianfotos/homerail#172`](https://github.com/xiaotianfotos/homerail/issues/172).
It has two parallel-safe work areas: deterministic reviewer-identity
canonicalization and terminal-state classification. It has concrete production
evidence and regression criteria, and does not require credentials, migrations,
dependency changes, release automation, or GitHub workflow edits. The caller
must still create a new same-repository Draft PR and revalidate the Issue state
before the run starts.

The pilot passes when:

- [ ] the immutable task digest remains stable across the complete run;
- [ ] every implementation child is isolated and credential-free;
- [ ] every GLM review has a distinct provider session;
- [ ] at least one candidate is pushed fast-forward through the broker;
- [ ] every aggregate/fix handoff has a verified TestReport;
- [ ] the exact final head has two clean fresh reviews, 100% diff coverage, and
      zero actionable defect load;
- [ ] the PR remains Draft and unapproved;
- [ ] the result is `ready_for_ci` with complete evidence;
- [ ] no capability policy violation occurs.

## Adoption Gate

Do not replace the current workflow until at least four of five eligible pilot
tasks:

- produce a locally tested, quantitatively converged Draft PR;
- complete within the agreed wall-time budget;
- survive retry/recovery without task loss;
- require no hidden credentials or host mounts;
- produce an operator-readable terminal reason;
- show zero unauthorized PR operations or workspace-policy violations.

After the gate, decide separately whether to deprecate `auto-fix`, retain it as
a compatibility fixture, or migrate its public trigger to v2.

## Explicitly Out Of Scope

- automatic merge, approval, ready-for-review transition, or branch deletion;
- force push or conflict resolution against human head drift;
- arbitrary host mounts and caller-selected shell commands;
- fork or cross-repository PRs;
- more than three initial implementation children;
- arbitrary planner-generated graphs or dependent child DAGs;
- self-hosting the first pilot by asking Auto Fix v2 to implement itself.
