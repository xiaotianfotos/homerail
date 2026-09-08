# Durable Auto Fix event supervision

[中文](event-supervision.zh-CN.md)

Use the host event supervisor when a trusted test/controller command or a pinned
GitHub workflow needs to finish without keeping a model busy polling progress.
It runs separately from Manager, Node, and Worker. It does not create repair
plans, approve changes, retry DAGs, publish PRs, or deploy HomeRail.

## Install a job

Requirements: Linux, Python 3.9+, an accessible `systemctl --user`, and user
linger already enabled (`loginctl show-user "$USER" --property=Linger`). The
installer checks prerequisites; it does not enable linger or modify system
services. GitHub observation also requires authenticated `gh` in the configured
PATH. macOS/Windows do not support this user-systemd adapter.

Create a private job spec outside the checkout and outside every Worker mount:

```json
{
  "id": "issue-123-round-2-tests",
  "execution_id": "issue-123:round-2:plan-sha:head-sha:trusted-tests",
  "thread": "exact-codex-task-id",
  "event_dir": "/absolute/private/jobs/issue-123-round-2-tests",
  "cwd": "/absolute/reviewed-checkout",
  "argv": ["/absolute/node", "/absolute/frozen-test-controller.mjs"],
  "queue_argv": ["/absolute/node", "/absolute/codex.js", "queue"],
  "environment": {"PATH": "/absolute/runtime/bin:/usr/local/bin:/usr/bin:/bin"},
  "preflight_argv": [["/absolute/node", "--version"]],
  "attention_after_seconds": 1800
}
```

All paths are absolute. Commands are argument arrays, never implicitly passed
through a shell. `queue_argv` is a host-configured notification transport: it is
called with `--thread ID --message TEXT`, and exit 0 means transport acceptance,
not consumer acknowledgment. The Codex queue adapter is optional; any compatible
transport can be used. Runtime paths must be real installed paths on your host.
Use credential references and host credential stores; do not put secrets in the
spec, command arguments, repository, or test logs. Preflights must be read-only.

Optional `repo_dir` and `head` bind a command to a full lowercase Git SHA before
and after execution. Use that for immutable candidate tests, not commands that
intentionally create a new commit. Optional `task_root`, positive `round`,
`plan_digest`, and nonempty `expected_phases` bind a judged Auto Fix task's
`state.json` before/after execution. The model loop still owns budgets and fresh
contexts; this supervisor does not replace the frozen test controller.

```bash
chmod 600 /absolute/private/job.json
python3 scripts/event-supervisor/durable.py install /absolute/private/job.json
```

The command returns the registration path and service name. Default data root:
`${HOMERAIL_HOME:-$HOME/.homerail}/event-supervision`; override using `--home`
**before** the subcommand. User units use `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user`.
`--unit-dir` is for isolated lifecycle tests; a real install must use the directory
read by the user's systemd manager.

The installer copies its runtime into a content-addressed directory, so moving
or changing this checkout does not change installed supervisors. It pins the
Python executable path, not the interpreter's bytes. The external command and
its working directory remain the caller's responsibility: use a frozen
controller, candidate SHA and independent test receipt for trusted validation.

A command `execution_id` must identify the original task/round/plan/head/operation
and be reused after interruption, regardless of notification label or event
directory. Deduplication is scoped to one supervisor data root. Changed specs
for an existing identity are rejected. Do not invent a new identity to retry an
unknown external operation. Reinstalling the same immutable spec repairs a lost
unit without repeating completed work.

## Observe one GitHub workflow

Replace `argv` and `execution_id` with a `github` object:

```json
{
  "repo": "owner/repository",
  "pr": 123,
  "pr_head": "0123456789abcdef0123456789abcdef01234567",
  "run_id": 456,
  "run_attempt": 1,
  "workflow_head": "89abcdef0123456789abcdef0123456789abcdef",
  "workflow_path": ".github/workflows/pr-review.yml",
  "poll_seconds": 30,
  "maximum_wait_seconds": 7200
}
```

Use actual workflow metadata. Workflow and reviewed PR heads are separate:
`workflow_dispatch` may execute a base-branch workflow against another candidate.
The built-in adapter only reads GitHub. It reports completion, stale PR identity,
wrong execution/attempt, unexpected observations, three consecutive read errors,
or the observation deadline. It never dispatches, cancels, or publishes. The
deadline is checked between bounded API requests; it is not a workflow timeout.
An unavailable observation does not prove the workflow failed. A successful
workflow does not prove all reviewers completed: the Judger must read artifacts.

## Recover and consume evidence

```bash
python3 scripts/event-supervisor/durable.py status /absolute/registration.json
python3 scripts/event-supervisor/durable.py reconcile /absolute/registration.json
```

The supervisor records intent before starting a separate host executor. The
executor writes `runner.json` with command exit code, observed task state and log
digest even if the supervisor dies. Restarting the service never starts another
command: it reuses a complete receipt or emits one interruption event, rejoins
the exact surviving executor using boot ID plus kernel process start time, and
waits for completion. This is ordinary program observation, with no model calls.
If the original executor is gone without a complete receipt, it preserves the
unknown outcome for the Judger; it cannot reconstruct an exit code.

`reconcile` uses the installed runtime and only observes existing execution. It
cannot start a new command. It waits for an identified surviving executor,
promotes a valid completed receipt, or exits 75 for an unresolved interruption.
A registration that has never executed also returns 75, without an alert or
queue delivery: absent execution is not corrupt evidence. Digest/log/receipt
mismatches still produce an evidence error and an idempotent alert.
Check `status`/event outcome to distinguish a completed failed command from a
passed command. Changed specs or receipts are errors, not permission to retry.

Events are private JSON files alongside `execution.json`, `runner.json` and
`execution.log`. The consumer checks event identity, current round/plan/head,
execution result and independent test/review evidence before deciding. Save an
idempotent consumer receipt; duplicate or stale notifications must not regenerate
patches, rerun tests, create another DAG, or publish again. Only failure,
interruption, attention deadline and completion cause notifications; unchanged
progress is silent. An interruption followed by completion can legitimately
produce two different events.

Queue intent is persisted before delivery. Failed, timed-out or ambiguous queue
attempts are retained and never blindly resent. Files survive reboot, but this
is not an exactly-once external mutation or guaranteed wake-delivery mechanism.
A whole-host crash can also interrupt the executor before receipt creation;
inspect the saved candidate and the actual remote execution before resuming the
missing phase with its original identity. A hash checks evidence integrity, not
whether a model truthfully ran tests. Keep the executor/evidence directory outside
model write access, and use the trusted test controller's own receipts.

## Upgrade, rollback and uninstall

```bash
python3 scripts/event-supervisor/durable.py upgrade /absolute/registration.json
python3 scripts/event-supervisor/durable.py upgrade /absolute/registration.json --source /absolute/retained/runtime
python3 scripts/event-supervisor/durable.py uninstall /absolute/registration.json
```

Use the same `--home` as installation. Upgrade and rollback are allowed only for
inactive/failed services with no unfinished execution or live recorded child.
They retain the old runtime and migration history. Repeat an interrupted upgrade
with the same source to repair its unit; do not edit unit files by hand. A changed
command/spec is a new reviewed operation, not a runtime upgrade.

Uninstall refuses active or unresolved work, writes a persistent tombstone,
disables/removes only the owned unit, and retains registrations, runtimes, logs,
events and receipts. It does not cancel a DAG or kill a child. Unresolved jobs
need Judger reconciliation before lifecycle changes; do not delete evidence to
bypass that gate. Reinstalling the original spec clears the tombstone and still
reuses a terminal execution.

Legacy transient supervisors are not silently adopted. Check their actual
service, lock, boot/process identity and remote task first. Retain their results,
consume their events, and register only genuinely new work with this installer.
Starting two different supervisor data roots or legacy manual observers bypasses
registration deduplication.

## Validation

`node --test scripts/event-supervisor.test.mjs` runs Linux process and fault tests
using Python's standard library; no real notifications or systemd changes occur.
It is included in `npm run test:live-validator` and therefore `npm run ci`.
Actual systemd installation/restart and whole-host reboot are separate integration
proofs. Do not infer either from mocked lifecycle tests or simulated boot IDs.

For an opt-in service proof on a Linux test host, run
`python3 scripts/event-supervisor/prove-systemd.py /absolute/new-proof-directory`.
It installs one fixture unit, kills only its supervisor, verifies reconnection
and completion, exercises upgrade/uninstall/reinstall, then uninstalls its unit.
All logs and receipts remain in the new directory. It uses a local notification
fixture and does not reboot the host or call models. On failure it lets the
fixture finish and retains evidence/the unit for diagnosis; check the recorded
registration and uninstall after reconciliation.
