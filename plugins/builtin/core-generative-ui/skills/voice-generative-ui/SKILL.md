---
name: voice-generative-ui
description: Choose and maintain truthful structured UI for a HomeRail voice session, using only currently available Core and plugin tools.
---

# Voice Generative UI

Use this Skill in voice mode when structured state materially helps the user listen, confirm, or follow real execution.

The voice surface is a listening and confirmation surface first. Simple chat and small local facts normally need no UI. During multi-turn requirement gathering, maintain one stable memo or task-state node instead of appending cards. Show execution, blocker, progress, or artifact state only when a real tool result, run ID, or explicit blocker supports it.

Use only the tools present in the current turn's catalog. Scenario-specific tools come from enabled plugins; if a tool or Skill is absent, that capability is unavailable. Never route around a missing plugin with a generic widget type.

Keep generated UI compact:

- At most two meaningful UI updates in one turn.
- Reuse stable IDs so later turns replace state rather than duplicate it.
- Keep lifecycle and visibility truthful; hide obsolete transient state.
- Put long checklists, evidence, or artifacts in UI and keep spoken text brief.
- Ask for confirmation before execution when the task is ready.
- Never invent a run, file change, artifact, or external action.

## Runtime ViewSpec V1

When no scenario-specific Tool matches and a structured interface would materially improve comprehension, call the current catalog entry for `com.homerail.core:upsert_generated_view`. Reuse one stable Core-owned `id` so later calls replace the same interface. Send a complete semantic `content.data` snapshot and a complete `view` on every call.

`view` is a bounded component tree, not HTML, CSS, JavaScript, or a template language:

```json
{
  "view_version": 1,
  "root": {
    "id": "root",
    "type": "stack",
    "gap": "md",
    "children": [
      { "id": "title", "type": "heading", "text": { "path": "/data/title" }, "level": 2 },
      { "id": "status", "type": "badge", "text": { "path": "/data/status" }, "tone": { "path": "/data/status", "format": "tone" } }
    ]
  }
}
```

Available V1 types:

- Layout: `stack`, `grid`, `section`, `divider`, `repeat`, `disclosure`.
- Content: `heading`, `text`, `markdown`, `icon`, `badge`, `link`.
- Data: `metric`, `progress`, `list`, `table`.
- Visual: `timeline`, `bar_chart`, `dag`.
- Interaction: `action`, but only when the node's Kind exposes that exact registered Action ID. The generic Core Tool exposes no Actions.

Bindings are exactly one of `{ "literal": ... }`, `{ "path": "/data/...", "format": "..." }`, or inside `repeat`, `{ "item_path": "/...", "format": "..." }`. Formats are `text`, `number`, `percent`, `datetime`, `duration`, `status`, and `tone`. Conditions use a structured `when` with one `path` or `item_path` and an operator: `exists`, `not_empty`, `equals`, `not_equals`, `gt`, `gte`, `lt`, or `lte`.

Use only design tokens:

- `gap`: `none`, `xs`, `sm`, `md`, `lg`.
- `tone`: `neutral`, `info`, `positive`, `warning`, `critical`.
- `align`: `start`, `center`, `end`, `stretch`.
- `grid.columns.default`: 1 to 3; `compact`: 1 to 2.
- `span`: 1 to 3 within the current grid.

Choose `density` by information need: `glance` and `summary` normally occupy one area unit; `detail` may occupy 2x2. The host may downgrade detail on compact devices. Never encode coordinates or assume a viewport size.

Limits are depth 8, 128 materialized nodes, 24 direct children, 50 repeat/source items, and 64KB ViewSpec. Keep source arrays smaller than the maximum. Every node id must be stable and unique in the template. Never include executable markup, arbitrary style values, direct network requests, or invented Action IDs.

For the current memo, treat each update as the complete state rather than an append-only transcript. Preserve still-relevant facts, mark answered questions complete, keep only important open questions visible, and make the next requested input explicit.
