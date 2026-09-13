# DAG event subscriptions: acceptance contract

Branch: `codex/dag-event-subscriptions`. Baseline: `ae61a9721388d3d23b9af6931b38e4580555000b`.

## Outcome

A caller registers observation of an existing DAG once and ends its model turn.
A persistent, ordinary host process listens to Manager events, without running a
model or repeatedly returning progress into a model conversation. Only completion,
external decisions, or sustained observation problems trigger a notification.
The observer never creates, retries, resumes, cancels, or approves a DAG.

## Required acceptance gates

1. The skill’s `dag_subscription.py install` returns a durable subscription/service identity promptly;
   it does not remain the watcher. Status, events, acknowledgment and unsubscribe
   are available through the bundled script. Repeating the same registration is idempotent;
   incompatible changes to an existing subscription fail.
2. Only existing Manager run metadata, approvals, and SSE APIs are used. The
   observer projects a small versioned local snapshot and binds run creation /
   workflow identity. SSE is a hint; reconnects reconcile current state. No
   Manager endpoint, heartbeat, durable cursor, or HomeRail CLI command is added.
3. Ordinary progress, chat/token deltas and handled node failures cause zero
   notifications. Terminal outcomes, pending external commands/approvals, quiet
   deadlines and sustained unavailability have distinct typed events. An
   observation failure never claims the DAG failed. Waiting/approval consumption
   does not end observation of later completion.
4. Events are persisted before delivery; stable event identity, private receipts,
   bounded notification text and explicit consumer acknowledgment are retained.
   Repeated acknowledgment is harmless. Pending delivery survives a crash;
   attempted-but-unknown delivery is not blindly repeated. An explicit redelivery
   uses the same event ID and documents the possibility of duplicate transport.
5. A persistent user service and frozen observer runtime survive controller exit,
   disconnect and process restart. Boot ID and process start identity prevent PID
   reuse mistakes. Completed/cancelled subscriptions do not restart observation.
   Cancelling observation leaves the DAG running and retains all event evidence.
6. Protocol validation, identity replacement, malformed/oversized responses,
   credential references, notification failure and concurrent operations are
   tested. No credentials or raw model text enter events, notifications or logs.
7. Skill-local deterministic fault tests, script CLI tests, existing Manager SSE
   integration, and skill structure validation pass on the final tree. An isolated real Manager/systemd lifecycle proof and
   a real notification to the current task are retained outside the repository;
   no production restart or host reboot is used as a test.
8. Documentation states Linux/user-systemd requirements, how to end the model
   turn, acknowledgment semantics, retry limits, recovery commands and mechanism
   boundaries. Keep the branch diff inside this skill, install it by symlink for Codex, and
   commit a reviewable result; do not merge or deploy HomeRail.

## Boundaries

The subscription observes durable current state, not an exactly-once journal of
every transient event. Completed decisions that need no further action are not
replayed as new requests. Delivery acceptance is not consumer acknowledgment.
No transport without an idempotency contract can promise exactly-once wakeup.
Snapshot hashes bind observed identity/integrity, not test truth or PR acceptance.
No claim of whole-host reboot validation is made from a simulated boot or a
service restart. Existing Auto Fix command supervisors retain their semantics.

## Reproduce

Run from the repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s skills/homerail-dag-supervision/scripts -p 'test_*.py' -v
```

For the opt-in integration check, build the existing protocol, plugin SDK, and
Manager packages first with their respective `npm --prefix <package> run build`.
Then run:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 skills/homerail-dag-supervision/scripts/check_integration.py \
  --evidence /absolute/fresh/private/evidence-directory
```

The fixture uses unchanged Manager HTTP handlers and GraphExecutor with a real
deterministic command; it does not launch production Manager, Workers, or models.
It kills/restarts only its observer, asserts a single command execution and one
terminal event, then stops/disables its test service. To test actual queue
acceptance, add `--thread <current-task-id> --codex <absolute-codex-path>`; this
sends one real notification. Queue acceptance is not proof of an idle task being
woken. Verify that separately after ending the model turn, and retain that
distinction in the evidence. Failed fixture attempts keep logs for diagnosis.

Initial validation on 2026-09-13: 15 fault/HTTP/script tests passed; skill
structure validator passed; real Manager handler/GraphExecutor integration and
systemd SIGKILL recovery passed. The test DAG command executed once, ordinary
progress produced zero notifications, and completion produced one accepted
Codex queue delivery. The current task inspected and acknowledged the persisted
event. The callback subsequently arrived in the same active Codex task and its
already-acknowledged event was deduplicated. Idle-task wakeup and a whole-host
reboot were not validated in that run.
