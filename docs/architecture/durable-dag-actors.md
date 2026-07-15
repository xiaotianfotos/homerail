# Durable DAG Actors

This document defines the durable actor boundaries introduced by Epic #36. Activity is an append-only fact plane; actor identity and commands form a separate control plane. UI projection and supervision consume these records but do not own them.

## Activity Plane

The Activity Plane is the append-only record of what a DAG actor did. The Worker emits events, the Manager validates and persists them, and consumers replay them. Activity events never mutate A2UI directly.

The V1 envelope is `dag-activity-event-v1`:

| Field | Meaning |
| --- | --- |
| `schema_version` | Contract version. V1 is the integer `1`. |
| `event_id` | Globally unique idempotency key. Replaying the same event is a no-op; reusing the ID for different content is rejected. |
| `run_id` | Durable DAG run identity. |
| `round_id` | Command/response round that produced the event. Until multi-round actors land, the node session is used. |
| `node_id` | DAG node that owns the execution slot. It must match the authenticated Worker stream context. |
| `actor_id` | Stable logical actor identity from `dag_actors`. It defaults to `node_id` when the workflow does not declare one. |
| `generation` | Actor process generation, starting at 1. A replacement process increments it; older generations remain auditable. |
| `surface_id` | Optional logical UI surface association. It is routing metadata, not a request to update A2UI. |
| `sequence` | Strictly increasing sequence inside one `(run_id, actor_id, generation)`. |
| `timestamp` | Producer time in Unix milliseconds. Journal receive order is stored separately. |
| `type` | `started`, `progress`, `finding`, `tool_used`, `blocked`, `completed`, or `failed`. |
| `payload` | Structured, redacted event-specific data. |

Ordering is guaranteed only for one actor generation. Journal sequence provides deterministic replay order for events the Manager received, but it is not a causal total order across actors. Consumers must use actor identity, generation, and activity sequence when deciding whether an event is current.

Workers receive `activity_sequence_start` with dispatch metadata and continue from the last sequence already persisted for that actor generation. A first dispatch starts at zero; corrections and later dispatches resume after the durable cursor.

## Production Rules

Lifecycle events are runtime-owned:

- `started` is emitted when a Worker begins a node invocation.
- `tool_used` is emitted for tool start and completion, including a redacted result preview.
- `completed` is emitted immediately before a contract-valid handoff. It closes the Worker round; the Manager run state remains authoritative for whether the DAG node was accepted.
- `failed` is emitted before a terminal node error.

Agents may explicitly report only `progress`, `finding`, and `blocked` through `report_activity`. These events must represent useful state changes or evidence. Fixed, tool-name-derived status prose is not activity.

## Persistence And Replay

The Manager persists Activity Plane events in `dag_activity_events`; the existing `dag_events` table and `/api/runs/:run_id/events` endpoint remain unchanged for backward compatibility.

Journal writes enforce:

1. protocol validation before persistence;
2. transport `run_id`, `node_id`, and `round_id` identity matching;
3. credential redaction again at the Manager trust boundary;
4. idempotency by `event_id`;
5. uniqueness of sequence within one actor generation;
6. append-only rows with no update API.

Replay uses `GET /api/runs/:run_id/activities`, with optional `actor_id`, `after_seq`, and bounded `limit` query parameters. The cursor is the Manager journal sequence, so replay resumes without relying on producer clocks.

## Logical Actor Registry

`dag_actors` is the canonical identity source for one durable run. A row binds:

- stable `actor_id`, role, and owning `node_id`;
- stable `surface_id`, unique within the run;
- current session, model profile, workspace, and checkpoint references;
- monotonic actor `generation`, logical `attempt`, and row `version`.

Physical Worker, container, node, and WebSocket identifiers are deliberately absent. Reconnecting the same logical actor on another Worker does not change its identity or surface. Binding updates require the current row version. Generation changes require both the current generation and version, so two recovery attempts cannot both become current.

Workflow nodes may declare `extra.agent_runtime.actor_id`, `role`, and `surface_id`. Missing values receive deterministic defaults (`node_id`, agent id, and `actor:<actor_id>`). Gateway nodes are Manager-owned runtime primitives and do not receive logical actor rows.

The persisted model profile contains only routing identity such as agent, provider, model, protocol, and setting id. Credentials are neither copied into the profile nor accepted without redaction at the persistence boundary.

## Durable Command Inbox

`dag_actor_commands` is the control-plane inbox. Every command records its `command_id`, idempotency key, `round_id`, target actor generation, status, payload, and lifecycle timestamps. The state machine is:

```text
pending -> delivered -> claimed -> acknowledged
    |           |          `-----> failed
    `-----------'
```

A Worker may claim a pending command directly after reconnect, so an unavailable immediate-delivery path does not lose work. The runtime follows these rules:

1. create and commit the command before invoking an immediate-delivery callback;
2. treat an identical `command_id` or actor-scoped idempotency key as the same command;
3. reject semantic reuse of either identity;
4. allow claims only when actor generation, target generation, and command state all match;
5. allow only the claiming generation to acknowledge or fail the command;
6. redact and size-bound model profiles, command payloads, and failure details before storage.

The TypeScript runtime API exposes registration, binding CAS, generation advancement, command creation/listing/delivery/claim/ack/fail, and bounded reads.

## Branch-local Intervention

`dag_actor_interventions` is a second durable Inbox for operator corrections. It is separate from activity history because a user command is intent, not evidence that work happened. `intervene_dag_actor` and the matching HTTP endpoint accept only stable `run_id` and `actor_id` identities plus an actor state token. Physical Worker, node, container, lease, and socket identifiers never enter the public contract.

Five operations share one generation transition:

| Operation | Runtime effect |
| --- | --- |
| `retry` | Capture the current portable checkpoint, stop the old attempt, and make the same actor branch ready with a new generation. |
| `reassign` | Apply `retry` semantics while excluding the previous physical execution target from the immediate redispatch. |
| `checkpoint_fork` | Start the new generation from an explicitly selected immutable checkpoint version. |
| `interrupt` | Stop the current branch attempt while retaining its checkpoint and projected evidence for a later decision. |
| `cancel` | Cancel the branch and retire its lease so it cannot be dispatched again accidentally. |

The write path enforces this order:

1. verify the actor state token and idempotency key;
2. commit a `queued` intervention row before changing runtime state;
3. transition the row to `applying` and atomically capture/select the checkpoint, release the old lease, advance actor generation, reset only the affected branch, supersede its projected Surface, and mark the intervention `applied`;
4. reject old-generation activity and handoffs through the existing generation and lease fences;
5. redispatch only a branch that remains runnable.

An exact idempotent retry returns the original result even when the caller still holds the old state token. Reusing the identity for different content or submitting a new command with a stale token returns a conflict. Startup recovery protects Actors with `queued` or `applying` interventions from ordinary orphaned-node demotion, then replays their Inbox after logical runs have been restored.

`dag_surface_generation_snapshots` stores the previous A2UI node as append-only audit evidence. The current generation keeps the same stable `surface_id`, receives a new revision, focuses briefly, and starts with fresh findings. Other Actors and their node revisions do not change. The UI fetches historical generations only when a card is expanded and renders them read-only.

## Follow-up Boundaries

- **Logical actors and inbox (#38):** this registry and durable command control plane.
- **Multi-round execution (#39):** create new `round_id` values while continuing the actor-generation sequence.
- **Lease and cold recovery (#40):** increment `generation` when ownership changes and reject stale writes for live projection while retaining them for audit.
- **Projector (#41):** the [Live Surface Projector](./dag-live-surface-projector.md) consumes journal events, orders them per actor generation, and produces revision-checked native A2UI transactions without editing journal rows.
- **Live UI (#42):** subscribe to projected state, not raw Worker output.
- **Supervisor and intervention (#43-#44):** read the same journal and issue commands through the control plane, never by rewriting activity history.
- **End-to-end proof (#45):** verify multiple actors, live projection, recovery, and release as one scenario.

Keeping these boundaries separate lets the journal remain the stable fact source while actor lifecycle and presentation evolve independently.
