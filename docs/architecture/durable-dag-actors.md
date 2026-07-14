# Durable DAG Actors

This document defines the durable activity boundary introduced by Epic #36. It is intentionally narrower than actor retention, command routing, UI projection, or supervision.

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
| `actor_id` | Logical actor identity. It defaults to `node_id` until logical actors are introduced. |
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

## Follow-up Boundaries

- **Logical actors and inbox (#38):** assign stable `actor_id`, durable inbox records, and sequence starts.
- **Multi-round execution (#39):** create new `round_id` values while continuing the actor-generation sequence.
- **Lease and cold recovery (#40):** increment `generation` when ownership changes and reject stale writes for live projection while retaining them for audit.
- **Projector (#41):** consume journal events and produce A2UI transactions. It must not edit journal rows.
- **Live UI (#42):** subscribe to projected state, not raw Worker output.
- **Supervisor and intervention (#43-#44):** read the same journal and issue commands through the control plane, never by rewriting activity history.
- **End-to-end proof (#45):** verify multiple actors, live projection, recovery, and release as one scenario.

Keeping these boundaries separate lets the journal remain the stable fact source while actor lifecycle and presentation evolve independently.
