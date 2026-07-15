# DAG Live Surface Projector

The Live Surface Projector is the trusted bridge between durable DAG Activity events and native A2UI. Workers report facts; they never submit A2UI components or Canvas mutations. The Manager validates identity, orders the facts, and produces one stable Block for each logical actor.

## Ownership

`dag_actors` remains the only mutable identity authority. A projection records the exact `(run_id, actor_id, node_id, surface_id)` tuple through a composite foreign key, so a row cannot be attached to another actor, node, or surface. The same tuple is present on queue and control records for database-enforced ownership at every write boundary.

All actor Blocks for a run share the active canonical Generative UI document with scope `{ type: "run", id: run_id }`. Each actor owns exactly one node whose id is its stable `surface_id`. The projector rejects an existing node unless its kind, provenance, actor id, run id, and projector marker all agree.

## Ordered Projection

The durable state is split into three tables:

| Table | Responsibility |
| --- | --- |
| `dag_surface_projections` | Current actor generation, applied activity sequence, journal cursor, independent Surface revision, activity state, and visibility state. |
| `dag_surface_projection_queue` | Journal references waiting for a contiguous actor sequence, plus applied, stale, or rejected outcomes. Worker payload is not copied. |
| `dag_surface_projection_controls` | Idempotent, revision-checked Manager focus and removal commits. |

Activity sequence, not journal arrival order, controls application. If sequence 2 arrives before sequence 1, it remains pending. Adding sequence 1 drains both in order. Events from an older actor generation remain in the Activity Journal but become `stale` and cannot update A2UI. An event ahead of the canonical actor generation fails closed.

Every visual update is one native Generative UI transaction with both:

1. document `base_revision` CAS; and
2. existing node `if_revision` CAS.

The A2UI transaction, projection cursor, Surface revision, and queue outcome commit in one SQLite transaction. A failure in any part rolls back all of them, leaving the queue entry pending for safe retry.

## Bounded A2UI

The projector owns a fixed Core A2UI component graph. It maps these Activity states:

- `started`
- `progress`
- `finding`
- `blocked`
- `completed`
- `failed`

`tool_used` advances the actor sequence without creating noisy visual text. A Worker payload contributes only bounded scalar fields such as title, summary, progress, and recent findings. Unknown fields, component arrays, actions, scripts, and catalog choices are ignored. Content, strings, finding count, and component count are all bounded before the protocol validator runs.

`focused` and `removed` are trusted Manager controls rather than Worker Activity types. They require the exact current Surface revision and an idempotent control id. Focus marks the stable Block as critical and records optional expiry metadata; removal uses a native A2UI remove operation. Animation and layout remain host responsibilities.

## Recovery And Reads

On Manager startup, logical DAG runs and actors recover first. The projector then replays the Activity Journal, recreates missing queue rows, and drains contiguous pending events. Exact transaction ids make replay idempotent, and the persisted document snapshot must remain identical across repeated restarts.

The read endpoint is:

```text
GET /api/runs/:run_id/live-surfaces
```

It returns the run-scoped canonical A2UI document and per-actor projection metadata. The live UI consumes this projection, not raw Worker streams.

## Trust Boundary

The data flow is deliberately one way:

```text
Worker -> Activity validation -> append-only Journal -> ordered Projector -> native A2UI transaction
```

There is no Worker endpoint for focus, removal, document transactions, or arbitrary Canvas writes. Manager commentary, layout selection, motion, and branch supervision are separate layers implemented by later Epic #36 issues.
