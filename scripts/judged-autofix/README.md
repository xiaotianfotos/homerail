# Externally judged Auto Fix loop

This Linux host controller unfolds repair iterations into fresh HomeRail DAG runs.
The supervising Judger writes every repair strategy and reviews every result.
A local model implements scoped exact-text edits through a single `handoff` tool.
It cannot run commands, write test receipts, approve itself, push branches, or create PRs.

Each DAG is `input → implement → terminal artifact`. The durable outer controller
carries the accepted source candidate and a bounded failure summary into the next
DAG. This keeps the graph acyclic and each model session fresh while permitting
as many Judger-authorized repair iterations as needed.

## Durable boundaries

| Boundary | Saved before action | Recovery |
| --- | --- | --- |
| Model submission | Run ID, exact payload, workflow revision/hash and profile timestamp | Repeat identical `create-and-run`; Manager returns the same receipt or completes pending invocation |
| Candidate application | Git tree and commit object | Reconcile base/index/HEAD and complete the same application |
| Trusted tests | Job identity, command, candidate commit/tree | Independent process continues; restarted controller adopts its receipt |
| Judgment | Round, plan digest, exact candidate tree | Acceptance additionally requires every configured publication check |
| PR publication | Repository, branch, base, accepted SHA, title and body hash | Reconcile the existing PR; never treat a different head as success |

A run ID is an idempotency key. Repeating the same semantic creation request
returns the original run, including its terminal status. Changed requests return
HTTP 409 `RUN_CREATION_CONFLICT`; old runs without a stored request identity also
conflict. Definition changes do not reinterpret an already created run. Clients
should pin workflow revision/hash and profile timestamp when first creating it.
A terminal failed run is not revived by replay: the Judger authorizes another
round with another identity after assessing the failure.

Test receipts are written by a detached host executor under `flock`, with exit
status, timestamps, command identity, source identity, runner hash and log hash.
The executor checks the source before and after the command, kills its process
group on timeout, and distinguishes infrastructure failures from failed tests.
The receipt hash binds evidence; the executor actually running the command is
what establishes execution. A model-authored assertion is never a test receipt.

The frozen engine is stored outside the candidate repository. Self-repair changes
the candidate copy; the current runner continues using its approved copy. Engine
promotion is an explicit Judger action after review. The entry verifies the
manifest before loading the frozen controller.

## Start a task

Requirements: Linux, Node 20+, Git, `flock`, `gh` authenticated on the supervising
host, a clean `codex/` branch, and a HomeRail Manager supporting idempotent run
creation. The selected model setting must already be configured on that Manager.
Do not run this in an unrelated dirty worktree.

Create an external task directory and `config.json` (replace example paths and IDs):

```json
{
  "version": 1,
  "id": "repair-example",
  "repo": "/work/repair-branch",
  "manager_url": "http://127.0.0.1:29191",
  "setting_id": "local-model-setting-id",
  "reasoning_effort": "low",
  "github_repo": "owner/repository",
  "base_branch": "main",
  "pr_title": "fix: reviewed repair",
  "checks": {
    "focused": {"cwd": ".", "argv": ["node", "--test", "test/regression.test.mjs"], "timeout_ms": 60000},
    "ci": {"cwd": ".", "argv": ["npm", "run", "ci"], "timeout_ms": 900000}
  },
  "publish_checks": ["focused", "ci"]
}
```

Configuration is immutable for the task. Supply the Manager mutation token via
`HOMERAIL_DAG_MUTATION_TOKEN` on the supervising host. The local model does not
receive GitHub authentication; `publish` uses the host's existing Git/`gh` login.
Test commands receive a separate HOME and a minimal environment.

After reviewing the engine, freeze it:

```sh
node scripts/judged-autofix/freeze.mjs /work/repair-task
node /work/repair-task/run.mjs /work/repair-task status
```

Write a Judger-authored plan with `objective`, `strategy`, `allowed_paths`,
`checks`, and `context` entries `{path,start,end}`. Only listed paths can be edited.
Use narrow, explicit implementation steps and relevant source excerpts.

```sh
node /work/repair-task/run.mjs /work/repair-task plan /work/repair-task/plan.json
node /work/repair-task/run.mjs /work/repair-task step
```

Repeat `step` while phase is `model`; it safely reconciles ambiguous submissions.
At `apply`, run `apply`; at `test`, run `test`. At `judging`, inspect the candidate,
logs, receipts and model metrics. Write a decision containing `round`,
`plan_digest`, `verdict` (`revise` or `accept`) and `reason`. Acceptance also needs
`tree` matching the exact candidate. A failed round needs a Judger decision before
a new plan. A new round retains previous commits; it does not restart from main.

```sh
node /work/repair-task/run.mjs /work/repair-task judge /work/repair-task/judgment.json
# After all configured publication checks pass and the Judger accepts:
node /work/repair-task/run.mjs /work/repair-task publish /work/repair-task/pr-body.md
```

When a round fails at the proposal stage (e.g. one anchor does not match), the
Judger may salvage valid saved edits without issuing another model request:

```sh
node /work/repair-task/run.mjs /work/repair-task select-edits /work/repair-task/selection.json
```

The selection file requires `round`, `plan_digest`, `proposal_digest` (identity of
the original `proposal.json`), `base`, a nonempty `reason`, and `indices`—a
nonempty, strictly ascending, unique array of zero-based integers selecting a
strict subset of the original proposal edits (max 20 edits, <=96 KiB). The original
`proposal.json` is immutable; selection only reads it. Each chosen edit must pass
the same safety rules (`safePath`, allowed-paths, exactly-one-old-match, new-file
for empty old). The resulting commit carries a `Judger-Selection` trailer with the
selection digest. Any invalid selection leaves the worktree and state untouched,
allowing correction and retry.

Additional named checks can be run with `test ci`. If an interrupted test worker
leaves a live child, the task blocks instead of starting another test. After the
recorded process is gone, the Judger can use `recover-tests`, reassess the result,
and explicitly rerun tests. Do not modify saved receipts to manufacture success.

## Platform requirements

Process-level tests (Git operations, flock, /proc identity) require Linux; they
are skipped via `node:test` skip option on other platforms. The first two
submission tests mock `fetch` and run portably on any OS. The `JudgedLoop`
constructor throws a clear Linux-required error on non-Linux platforms, while
module import remains safe for tooling and CI matrix checks.

## Context, costs and limits

- Each actor uses `session_scope: dispatch`; each repair iteration is a new run.
- Input is capped at 96 KiB, with only the last three round summaries and short
  failed-test tails. Passing test logs remain on disk and are not repeated in input.
- Exact edit anchors are checked against the pinned candidate. Invalid or ambiguous
  edits are retained as evidence and returned to the Judger for correction.
- Durable candidates and completed tests survive controller restarts. This does
  not recover unpublished in-flight model tokens or guarantee every issue has a
  solution. The Judger owns strategy changes, cost limits and escalation.
- Provider usage is measured evidence, not a proof of correctness. Missing usage
  remains unknown. Cache tokens and intermediate tool corrections must be included
  when comparing whole-run costs; source lines produced are a separate measure.
- The host test executor is not an adversarial-code sandbox. Use a disposable
  isolated host for untrusted repositories. This mechanism separates model claims
  from program evidence; hashes alone are not an authentication boundary against
  other programs with the same operating-system privileges.

This implementation was repaired using the same loop and local Qwen DAG runs.
Regression tests exercise real controller SIGKILL, receipt adoption, source and
log tampering, failed/timeout commands, idempotent creation, cold recovery and
publication reconciliation. The supervising Judger also injected a lost Manager
reply and restarted a real isolated Manager between creation and invocation.
