# Listener operations

Resolve `scripts/dag_subscription.py` relative to the installed skill, following
its symlink. The default private store is
`${HOMERAIL_HOME:-~/.homerail}/dag-subscriptions`; a single explicit `--home`
may be used consistently instead. Keep it outside the project checkout.

## Registration

Write a mode-0600 JSON spec in a private directory using a structured file write.
Replace all placeholders with verified values. Do not pass secrets on argv.

```json
{
  "version": 1,
  "manager_url": "http://MANAGER-IP:PORT",
  "run_id": "RETURNED_RUN_ID",
  "thread": "CURRENT_CODEX_TASK_ID",
  "notify_argv": ["/absolute/path/to/codex", "queue"],
  "timeout_seconds": 86400,
  "quiet_seconds": 1800,
  "unavailable_seconds": 180,
  "request_seconds": 30
}
```

Optional `admin_token_file` references an absolute, user-owned, regular 0600 file
containing the existing Manager admin token. Its contents are never persisted
in subscription state. The only optional `environment` keys are `PATH` and
`CODEX_HOME`; supply the verified PATH if the Codex launcher requires it under
systemd. `notify_argv` is an argument array, never a shell string. The listener
appends `--thread` and `--message`; validate transport support before installing.

```bash
python3 /absolute/skill/scripts/dag_subscription.py install < /private/spec.json
python3 /absolute/skill/scripts/dag_subscription.py status SUBSCRIPTION_ID
systemctl --user is-active homerail-dag-subscription-SUBSCRIPTION_ID.service
```

The same Manager origin, run ID, and task ID under the same store produce one
subscription. Repeating the exact spec is safe; changing it is rejected. A
completed/stopped subscription stays stopped. Normal status output is compact;
`events ID` lists the journal and `event ID EVENT_ID` reads a single entry.

The listener uses existing `GET /api/runs/:id`, `GET /api/dag/approvals`, and
`GET /api/dag-status/:id/events`. SSE payloads may contain chat or replayed
history; they are discarded. An event triggers a current-state read, coalesced
for ordinary progress. The existing SSE has no durable cursor or heartbeat, so
socket timeouts/reconnects also reconcile current state in the background.
This is current-state observation, not a lossless event journal. A transient
condition entirely between observations may not be reported.

Normal progress emits no notifications. A waiting approval suppresses a second
generic command alert and quiet alerts. The same unresolved condition is
reported once; an observed exit and re-entry can create a new occurrence.
Outage/quiet alerts occur once per episode. Deadlines, identity mismatch, and
event limits stop observation. Network and notification calls are bounded;
deadline delivery can lag by in-flight calls and reconnect backoff.

## Delivery and acknowledgment

```bash
python3 /absolute/skill/scripts/dag_subscription.py event ID EVENT_ID
python3 /absolute/skill/scripts/dag_subscription.py ack ID EVENT_ID EVENT_DIGEST
```

Events are atomically saved before delivery. `pending` events can resume after
restart. The transport's zero exit code records `accepted`, not consumption.
An explicit hash-checked ACK records consumption and is idempotent.

If the sender dies during delivery, the outcome is `unknown`; a nonzero exit or
timeout is also ambiguous. There is **no automatic resend** of accepted/unknown
delivery, because Codex queue has no verified idempotency-key contract. A failed
executable launch is `not_started`. After investigating the destination task,
explicitly resend an unacknowledged event if needed:

```bash
python3 /absolute/skill/scripts/dag_subscription.py redeliver ID EVENT_ID EVENT_DIGEST
```

Redelivery preserves the event ID, with at most three attempts in total. This
supports consumer deduplication; it does not promise exactly-once wakeup or
exactly-once DAG mutations. No automatic transport-recovery notification can
be guaranteed when the transport itself is broken; inspect status during a
subsequent user interaction.

## Stop and recover

```bash
python3 /absolute/skill/scripts/dag_subscription.py unsubscribe ID
```

This stops/disables only the owned observer service and preserves all receipts.
It does not cancel the DAG. A callback already in flight can still arrive.

The service survives the launching shell and restarts after process failure.
With existing user lingering, its enabled unit can start after host reboot.
PID checks include boot identity and process start time. Runtime copies are
content-addressed and checked before use, so checkout changes do not silently
replace a running observer. Reinstalling the exact spec restores a missing
owned unit. Corrupt registration/runtime/state fails closed; preserve evidence
and investigate rather than deleting state and blindly resubscribing.

Keep the Codex task available to receive callbacks. Do not archive it while
supervision is active. An unavailable task/app server may leave an unacknowledged
delivery requiring explicit recovery.
