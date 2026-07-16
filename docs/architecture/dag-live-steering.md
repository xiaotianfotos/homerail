# Live DAG Actor Steering

This document defines the runtime boundaries for Issue #58. It extends durable
DAG actors without changing the DAG graph while a run is active.

The feature is split into three independently reviewable planes:

1. a durable command plane for steering one logical actor;
2. an immutable Skill Context pinned when a run is admitted;
3. a bounded Surface patch plane whose only canvas writer is the Manager
   projector.

Activity remains an append-only fact plane. Commands are user or Manager intent,
Skill Context is execution input, and Surface patches are presentation proposals.
None of these records may masquerade as activity evidence.

## Live Command Plane

A live command targets a stable `actor_id`, never a physical Worker or container.
The Manager commits the command before attempting delivery. Each actor owns a
monotonic command sequence, so reconnects and retries cannot reorder user intent.

The lifecycle is:

```text
queued -> delivered -> applied -> completed
   |          |           |
   |          |           `-----> failed
   |          `-----------------> rejected | superseded | failed
   `----------------------------> rejected | superseded | failed | cancelled
```

The states have precise meanings:

- `queued`: the command and its fences are durable;
- `delivered`: the current turn controller accepted the command into its ordered
  provider queue;
- `applied`: the provider adapter submitted the command to the active model turn;
- `completed`: that actor generation reached a safe successful boundary after
  applying the command;
- `superseded`: a newer ordered command explicitly replaced an unapplied command;
- `rejected`: a permanent capability, identity, or semantic check failed;
- `failed`: delivery or provider application failed after processing began;
- `cancelled`: the run or actor was intentionally stopped before application.

A successful WebSocket `send()` is not a lifecycle transition. Worker status
messages must carry the current run, node, session, round, actor generation, and
lease generation fences. The Manager validates those fences against the current
dispatch target before changing durable state.

Backends with native steering use an `AgentTurnController`. Kimi SDK turns map to
`Turn.steer()`. Claude SDK turns use streaming input backed by an ordered,
closeable async queue. A backend that cannot steer leaves the command queued for
the next safe actor boundary; it must never report false delivery.

## Pinned Worker Skill Context

Only Skill IDs explicitly declared by the WorkflowSpec agent are resolved.
Resolution occurs when the run is admitted, from bounded trusted roots or an
exact trusted plugin archive. The Manager stores an immutable content snapshot
and digest for each agent.

Dispatch carries a dedicated Skill Context envelope. It is not embedded in the
credential-bearing agent configuration. The Worker verifies every content digest
and the aggregate context digest before appending the bounded Skill instructions
to that actor's system prompt.

Chat, transcripts, supervision, and public diagnostics may record Skill IDs,
digests, sources, and byte counts. They must not copy Skill bodies or credentials.
Hot continuation, Manager restart, and cold Worker recovery all reuse the same
pinned context. A changed file on disk affects only a newly admitted run.

## Actor-owned Surface Patch Plane

A Worker may propose a passive A2UI body for its own stable Surface. It cannot
write the canvas, choose another actor's Surface, replace Manager-owned status or
lifecycle fields, or publish arbitrary HTML and script.

The patch journal is separate from Activity. Every patch is fenced by actor
generation and lease, ordered by an actor-local patch sequence, bounded in bytes
and component count, and idempotent by patch ID. The patch body contains:

- a passive HomeRail Catalog A2UI fragment;
- structured data addressed only by that fragment;
- a readable text fallback;
- optional presentation hints that the projector may accept or ignore.

The projector validates identity, ownership, catalog components, bindings,
credential-free media references, sequence, and generation. It then composes the
body into the existing Manager-owned Surface and commits a revision-checked A2UI
transaction. Stable structure should use data-model updates; component-tree
replacement is reserved for actual presentation changes.

Focus and Activity may advance the outer Surface revision independently. The
actor patch plane therefore owns its own body sequence and materialized revision,
instead of using the outer revision as a producer compare-and-swap token.

## Recovery Rules

1. Manager restart replays durable commands and patch queues before accepting new
   status transitions.
2. Worker reconnect never inherits an in-memory provider queue. The current actor
   generation and persisted command cursor determine what can be applied.
3. Cold recovery receives the pinned Skill Context and unapplied commands in
   sequence order.
4. Output from an old session, generation, lease, or patch sequence is rejected
   deterministically.
5. A command or patch for one actor cannot change a sibling actor's generation,
   command cursor, Surface identity, or Surface body revision.

## Pull Request Boundaries

- Live steering: command persistence, Manager API, Worker controller, and Kimi and
  Claude adapters.
- Worker Skill Context: admission-time resolution, immutable snapshots, dispatch,
  Worker validation, and prompt injection.
- Rich Surface patches: protocol, journal, Worker tool, projector, supervision,
  and renderer validation.

The final stacked PR validates all three planes together with multiple actors,
repeated commands, incremental visual revisions, hot continuation, and cold
recovery.
