# Multi-Round DAGs

Multi-round execution keeps one durable `run_id` and its logical actors alive
across command/response rounds. An `await_command` node closes the current
round and moves the run to `waiting`; an actor command opens the next round, or
the caller can explicitly complete or cancel the waiting run.

## Strict WorkflowSpec v1

`await_command` is a first-class WorkflowSpec v1 node. It is an outputless
persistent boundary, not a terminal alias and not a prompt convention:

```yaml
api_version: homerail.ai/v1
kind: Workflow

metadata:
  id: multi-round-research
  name: Multi-Round Research

spec:
  contracts:
    Summary:
      type: string
      maxLength: 20000

  agents:
    researcher:
      system: >
        Use the run prompt on the first round. On later rounds, follow the
        command input and hand off a concise summary.

  nodes:
    researcher:
      kind: agent
      agent: researcher
      outputs:
        summary: { contract: Summary }

    wait_for_command:
      kind: await_command
      inputs:
        summary: { contract: Summary }
      config:
        primitive_version: 1
        target_actors: [researcher]
        command_port: command
        expires_after_ms: 86400000

  edges:
    - { from: researcher.summary, to: wait_for_command.summary }
```

This is strict `homerail.ai/v1`: it uses `kind`, `config`, and explicit
`spec.edges`, not legacy `type`, `gateway_config`, or inline `outputs.*.to`
fields. There is deliberately no synthetic `terminal` node. Workflow
validation accepts `await_command` as the persistent boundary.

The source agent intentionally has no input edge. Manager seeds the initial
`hr run --prompt` value into the default `prompt` input of a ready source node;
later rounds wake the selected actor through the configured command port.

The node rules are:

- A workflow may contain at most one `await_command` node. A run has one
  durable round boundary, so multiple independent wait points would be
  ambiguous.
- `primitive_version` must be the integer `1`.
- `target_actors`, when present, contains unique agent node IDs. The default
  logical actor ID for a strict v1 agent is its node ID, so the example is
  addressed as actor `researcher` through the CLI and API.
- `command_port` defaults to `command`. A resumed actor receives a structured
  command envelope on that runtime input, including `command_id`, `round_id`,
  `actor_id`, and the caller's `payload`.
- `expires_after_ms` is optional and, when set, must be an integer of at least
  1000 milliseconds.
- The node may declare inputs and upstream dependencies but no outputs,
  outgoing routes, or downstream `depends_on` consumers. It is the durable end
  of a round, not a pass-through control node.

Validate and sync the document through the live Manager contract:

```bash
hr --json dag validate ./multi-round.yaml
hr dag sync ./multi-round.yaml
hr profile sync ./runtime.profile.yaml --workflow multi-round-research
hr run --workflow multi-round-research --profile local-main \
  --prompt "Research the current release risk"
```

## Waiting And Round Lifecycle

`waiting` is non-terminal. The terminal run states remain `completed`,
`failed`, and `cancelled`.

```text
run active, round N active
  -> await_command
run waiting, round N waiting
  -> send actor command: round N completed, round N+1 active, run active
  -> explicit complete: round N completed, run completed
  -> cancel: round N cancelled, run cancelled
  -> expiry: round N failed, run failed
```

Round IDs are durable and monotonically ordered (`round-0001`,
`round-0002`, ...). Resuming atomically completes the expected waiting round,
opens the next active round, persists its actor commands, and updates run
metadata. At most one round is current (`active` or `waiting`) for a run.
If an `await_command` node becomes ready before another parallel branch has
settled, it remains ready and closes the round only after every sibling node is
quiescent. Graph scheduling order therefore cannot prematurely fail or suspend
live work.

`hr dag watch` and continuous `hr dag supervise` stop polling and return
success when they observe `waiting`. That means "a command boundary was
reached", not "the run completed". Read the run status or rounds before making
the next lifecycle decision.

## CLI Flow

Always take the expected round ID from current state instead of constructing
it locally:

```bash
hr dag supervise "$RUN_ID"
hr dag rounds "$RUN_ID"
hr dag commands "$RUN_ID"
```

Resume one actor with stable command identities for retry safety:

```bash
hr dag send-command "$RUN_ID" \
  --expected-round round-0001 \
  --actor researcher \
  --payload '{"task":"continue","focus":"new evidence"}' \
  --command-id command-research-round-2 \
  --idempotency-key research-round-2-v1
```

Inspect the new round and its command:

```bash
hr dag rounds "$RUN_ID"
hr dag commands "$RUN_ID" --round round-0002
```

As an alternative request shape, resume multiple actors from one waiting
boundary by repeating paired `--actor` and `--payload` options in the same
order:

```bash
hr dag send-command "$RUN_ID" \
  --expected-round "$CURRENT_ROUND" \
  --actor researcher --payload '{"task":"refresh sources"}' \
  --actor reviewer --payload "review the updated evidence"
```

A payload is parsed as JSON when valid and otherwise remains a string.
`--command-id` and `--idempotency-key` are available only for a single-command
CLI request. Use the HTTP API when a batch needs explicit identity per command.
The global `--json` option makes all four commands machine-readable.

When the current round reaches `waiting` again and no further round is needed,
complete it explicitly:

```bash
CURRENT_ROUND=round-0002
hr dag complete "$RUN_ID" --expected-round "$CURRENT_ROUND"
```

Completion is valid only at the current waiting boundary. A premature request
or stale round ID returns a conflict. To abort instead, `hr stop "$RUN_ID"`
cancels either an active or waiting run.

## Fencing And Idempotency

There are two related fences:

1. Control-plane writes require `expected_round_id`. A send or complete request
   for any round other than the current waiting round is rejected with HTTP
   `409 Conflict`.
2. Worker handoffs after round 1 carry the current `round_id`, logical
   `actor_id`, actor `generation`, and `command_id`. Manager rejects missing or
   stale fences, including a late handoff from an earlier round, before it can
   mutate current DAG state.

Each resumed actor receives at most one command per round. Commands target the
actor's current generation and normally follow `pending -> delivered -> claimed
-> acknowledged`; a reconnecting Worker may claim directly from `pending`.
`failed` and `cancelled` are exit states. Manager persists a command before
dispatch and acknowledges it only after a fenced handoff is accepted.

For retryable clients, reuse the same `command_id` or actor-scoped
`idempotency_key` with byte-equivalent semantic content. An exact retry returns
the already-opened round with `deduplicated: true`; reusing either identity for
a different actor, round, generation, or payload is rejected. For a batch, the
retry must reproduce the complete accepted command set; a subset is not an
idempotent retry. Supplying stable IDs is recommended whenever a client might
lose the first response.

## HTTP API

Manager exposes the following run-scoped endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/runs/:run_id/status` | Read `status` and `current_round`. |
| `GET` | `/api/runs/:run_id/rounds` | List durable rounds in ordinal order. |
| `GET` | `/api/runs/:run_id/commands` | List commands; supports `actor_id`, `round_id`, `status`, and `limit`. |
| `POST` | `/api/runs/:run_id/commands` | Fence the waiting round and resume one or more actors. |
| `POST` | `/api/runs/:run_id/complete` | Explicitly complete the current waiting round. |
| `POST` | `/api/runs/:run_id/cancel` | Cancel an active or waiting run. |

The response envelope is `{ success, message, data }`. A command request is:

```bash
curl -sS -X POST "$HOMERAIL_MANAGER_URL/api/runs/$RUN_ID/commands" \
  -H 'Content-Type: application/json' \
  -H "X-Homerail-Dag-Token: $HOMERAIL_DAG_MUTATION_TOKEN" \
  -d '{
    "expected_round_id": "round-0001",
    "commands": [{
      "actor_id": "researcher",
      "command_id": "command-research-round-2",
      "idempotency_key": "research-round-2-v1",
      "payload": {"task": "continue", "focus": "new evidence"}
    }]
  }'
```

The response data includes `previous_round_id`, the new `round_id` and
`ordinal`, selected `actor_ids` and `node_ids`, durable `command_ids`, ready
nodes, and dispatch count. Exact retries also include `deduplicated: true`.

Explicit completion uses the same current-round fence:

```bash
curl -sS -X POST "$HOMERAIL_MANAGER_URL/api/runs/$RUN_ID/complete" \
  -H 'Content-Type: application/json' \
  -H "X-Homerail-Dag-Token: $HOMERAIL_DAG_MUTATION_TOKEN" \
  -d '{"expected_round_id":"round-0002"}'
```

When `HOMERAIL_DAG_MUTATION_TOKEN` is configured, all listed mutation requests
must send it as `X-Homerail-Dag-Token`, including loopback requests; the `hr`
client adds the header from the environment automatically. Without a configured
token, mutations are restricted to loopback clients. Malformed input returns
`400`, unknown runs or actors return `404`, and stale/not-waiting lifecycle
writes return `409`.

## Cancellation, Expiry, And Recovery

Cancellation terminalizes the current round as `cancelled`, marks waiting or
running nodes accordingly, cancels unclaimed commands, persists the result,
and starts terminal resource cleanup.

If `expires_after_ms` is present, Manager stores an absolute `expires_at` when
the run enters `waiting`. Crossing that deadline marks the `await_command` node,
current round, and run as `failed` with an `await_command expired` reason. The
deadline is durable, so a wait that expires while Manager is down is failed by
the scheduler after recovery. A terminal run cannot be resumed.

On startup, Manager cold-recovers both active and waiting runs from persisted
graph/runtime state, handoffs, rounds, actors, sessions, and commands. A
recovered waiting run keeps the same `run_id`, current round, actor generation,
and session binding. It is not redispatched until a valid command opens the
next round.

If no compatible Worker is connected when a round opens, the selected actor
stays `READY` and its command stays `pending`. Offline attempts and capability
mismatches do not consume `max_dispatches`; registration of a compatible
Worker triggers a retry. Socket-send failures remain real failed attempts.

## Concurrency Slot Release

A waiting run remains durable but does not count as an active run. Runtime
status reports `active_runs` and `waiting_runs` separately, and workflow-level
trigger admission counts only rows whose status is `active`. Reaching
`await_command` therefore releases the workflow's overlap/`max_concurrency`
admission slot, so another run may start while the first waits.

Resuming continues the existing `run_id`, but it must reacquire workflow
admission before changing the waiting round or persisting commands. Manager
re-evaluates the workflow's enabled trigger policies using the same strictest
`overlap` and `max_concurrency` limits used for a new run. If another active run
holds the available slot, resume returns `409 Conflict` and leaves the original
run, round, node states, and command set unchanged in `waiting`. A successful
admission changes the resumed run back to `active`; releasing the slot while it
waited never erased its actors, rounds, commands, or recovery state.

An exact retry of an already accepted resume is resolved before admission, so
a lost HTTP response can be recovered even if the workflow slot is occupied by
the time the caller retries. Crash-window resume reservations are discarded as
soon as the corresponding durable run is observed active or terminal.
