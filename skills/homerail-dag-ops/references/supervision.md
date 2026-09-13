# Background supervision and event consumption

Read this after obtaining a run ID for asynchronous Codex work, or on an event
callback. The listener is a bundled ordinary process using existing HomeRail APIs.

It requires Linux, Python 3.10+, user systemd with lingering already enabled,
and a verified `codex queue --thread ... --message ...` transport. A one-shot
`codex exec` can submit work, but delivery into that closed process is not a
verified idle-task wakeup path. Keep a persistent destination task available.
If requirements are missing, state what is unavailable; do not claim that a
background wakeup has been registered.

## Register once

1. Resolve the current Codex task ID, Manager origin, run ID and credentials.
   Read [listener.md](listener.md) and register the private JSON spec using
   `scripts/dag_subscription.py install` from this skill.
2. Save the subscription ID and directory. Check compact `status` once and its
   service is active, or confirm a terminal event has already been persisted.
   If registration output is lost, retry the same spec and storage root.
3. Tell the user what events will notify this task and **end the model turn**.
   Do not add a goal loop, periodic model automation, or repeated tool waits.

## Consume a wake event

For a `[homerail-dag-event ...]` message:

1. Read this skill and the **single event** using the command in the message.
   Verify the subscription belongs to this task, and its event hash matches
   the notification. The `ack` operation also enforces the hash. If already
   acknowledged, end quietly; do not repeat prior side effects.
2. Read current run metadata once from the registered Manager. Compare run ID,
   creation time, workflow revision/hash, and creation request digest where
   available with the pinned identity. Events are hints about persisted state;
   approvals and metadata are separate reads, so recheck a proposal's current
   status and hash before presenting or acting on it. Ignore stale decisions.
3. Handle the reason:
   - `terminal`: inspect relevant artifacts/handoffs and acceptance evidence.
     A completed DAG is not by itself proof the user's task passed acceptance.
   - `approval_required`: present the current proposal and hash to the human.
     Notification/consumption acknowledgment does not approve the proposal.
   - `command_required`: continue the existing run only within the user's
     authorized task; otherwise ask for the missing decision. Record action
     intent before submitting, and reconcile an ambiguous result before retry.
   - `quiet_timeout` or `observation_unavailable`: make one bounded diagnosis.
     These describe observation, not a failed DAG. The listener continues.
   - `identity_mismatch`, `observation_deadline`, or `event_limit`: observation
     has stopped. Explain the concrete limit or mismatch and reconcile current
     state; do not silently rerun the DAG.
4. Record the finding and any decision/action intent in the task receipt, then
   `ack <subscription> <event> <digest>`. ACK means this event was consumed;
   the DAG may still be waiting for a human. Do not wait for a user answer just
   to ACK a notification already presented to them.
5. End the turn when no further authorized action is ready. An approval ACK
   leaves the listener active for later completion. Terminal observers exit.

Use [listener.md](listener.md) for registration, explicit redelivery,
stopping, and recovery. Use [acceptance.md](acceptance.md) when changing
or validating this skill. All implementation and tests belong inside this skill.

Callbacks from frozen runtimes installed under the former
`homerail-dag-supervision` name use the same journal and ACK contract. Consume
them with this skill and the absolute frozen-script path in the message; do
not recreate an active subscription solely to rename its skill.
