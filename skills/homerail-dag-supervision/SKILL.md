---
name: homerail-dag-supervision
description: Start or supervise HomeRail DAG work from Codex with a persistent background event listener. Use when a DAG runs asynchronously and Codex should resume only for completion, a required decision, or sustained observation problems, instead of repeatedly polling progress. Includes event consumption, acknowledgment, and listener recovery using existing HomeRail APIs.
---

# HomeRail DAG supervision

Codex plans and handles decisions; HomeRail executes the DAG; an ordinary Python
process waits for events. After registering a verified listener, **end the model
turn**. Do not keep a goal loop, periodic model automation, repeated tool waits,
or `hr dag watch` loop alive just to check unchanged progress.

This skill uses HomeRail's existing CLI, run metadata, approvals API, and SSE.
Its bundled listener is external to HomeRail. It does not change Manager or CLI
code, call a model, or mutate a DAG. The current listener requires Linux, Python
3.10+, persistent user systemd with lingering enabled, and a verified local
`codex queue --thread ... --message ...` transport. If these are unavailable,
report the concrete missing capability instead of claiming unattended wakeup.

## Start once and hand off

1. Resolve the actual CLI, Manager origin, current Codex task ID, and workspace.
   Inspect `hr doctor`, relevant command help, and `codex queue --help` once.
   Never guess a task ID, credential, installed version, or profile. Use the
   current task's configured model; no particular supervisor model is required.
2. Agree on task outputs, permitted changes, budget, and acceptance evidence.
   Reuse a concrete workflow and database runtime profile. If a new workflow is
   needed, inspect `hr dag schema`, author it, validate with `hr --json dag
   validate <file>`, then sync it. Keep provider credentials and model choices
   in database settings/runtime profiles. The optional `homerail-dag-patterns`
   skill helps select topology; it is not needed to observe an existing run.
3. Start authorized work once with `hr run --workflow <id> --profile <id>
   --prompt <task>` after checking local help. Persist the returned **run ID**,
   workflow revision/hash, inputs, and acceptance criteria in the task's private
   receipt. If submission has an unknown outcome, reconcile existing runs;
   do not create another run to recover a missing response.
4. Read [listener.md](references/listener.md), create the private subscription
   spec, and invoke `scripts/dag_subscription.py install`. The script persists
   registration, freezes its own runtime outside the checkout, and enables a
   user service. Save the returned subscription ID and directory. Retry the
   same spec if registration output is lost; do not use a second storage root.
5. Inspect compact `status` once and verify its service is active (or a terminal
   event is already persisted). Registration alone is not evidence that the
   notification transport reaches this task. Use a proven transport or a
   clearly marked one-time test callback, never a periodic model heartbeat.
6. Tell the user the run and subscription IDs, what will wake the task, and end
   the turn. Background HTTP reconnection consumes no model tokens. Do not
   interpret absence of notifications as completion.

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

Use [listener.md](references/listener.md) for registration, explicit redelivery,
stopping, and recovery. Use [acceptance.md](references/acceptance.md) when changing
or validating this skill. All implementation and tests belong inside this skill.
