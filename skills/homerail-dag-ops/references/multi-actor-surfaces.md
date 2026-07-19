# Multi-Actor Surface lifecycle

Read this reference when a request needs independently updating Actor panels,
or when a later user turn changes an existing supervised result.

## Choose the decomposition before the template

Use exactly three Actors only when every answer below is yes:

1. Will the three outputs remain separately useful on the Canvas?
2. Can each responsibility be stated in one non-overlapping sentence?
3. Will the user benefit from focusing or updating one result without replacing
   its siblings?
4. Is there enough work and evidence to justify three independent lifecycles?
5. Does the graph mechanically share source identity and any required upstream
   result?

Good three-Actor decompositions include:

- code architecture / PR history / Issue health for the same repository and
  revision, because the evidence lanes are independent;
- current state / risk review / remediation plan, when each panel owns a
  distinct decision surface;
- evidence research / skeptical synthesis / publication layout, only when the
  research handoff is wired into every downstream Actor that claims to use it.

Do:

- give every Actor one stable id, one responsibility, and one visual grammar;
- use parallel edges for independent lanes and staged edges for dependent work;
- pass conclusions, evidence, gaps, and source identity as structured fields;
- keep unaffected siblings stable during a targeted follow-up;
- state honestly when a staged Actor is waiting for upstream evidence.

Do not:

- create three generalists that independently repeat the same mission;
- split one answer or one dashboard into decorative Actor panels;
- ask a synthesis or publication Actor to infer an upstream result from the
  original prompt;
- claim that parallel nodes formed a pipeline when no data edge connects them;
- start three Actors for simple Q&A, a single status, or one compact report;
- use a fixed domain layout when the requested responsibilities do not match it.

## Required Workflow contract

A live multi-Actor Workflow must declare all of these mechanically. Prompts
alone cannot add them:

- stable named agents and agent nodes;
- a pinned Worker Skill for each agent;
- one or more exact `allowed_surface_views` supplied by that Skill's visual
  profile;
- `report_surface_state` in each presenting node's `allowed_dag_tools`;
- `started -> partial -> final` in the pinned view data contract when continuous
  progress is required;
- a join that admits the complete round only from real Actor handoffs;
- `kind: await_command` with stable `target_actors` and `command_port` when the
  run must remain available for follow-ups.

If any item is missing, describe the Workflow honestly as a normal DAG rather
than promising live panels.

## Starting a run

For the bundled generic three-panel contract, call:

```text
start_supervised_dag({
  "yamlPath": "assets/orchestrations/multi-actor-live-report.yaml.template",
  "prompt": "<complete user objective>",
  "profile": "<available profile only when required>"
})
```

Use the returned run id. Then call `list_dag_actors` and
`get_dag_supervision`; never infer Actor ids from Worker, container, node, or
lease identifiers. Starting this run is the execution action—do not also create
three Manager-owned generated-view Blocks.

The generic Workflow owns these stable responsibilities and asks every lane to
ground its own claims from the shared objective:

- `research`: current attributable evidence and uncertainty;
- `synthesis`: independent judgment, evidence quality, and caveats;
- `visual_story`: concise screenshot-ready social copy grounded in checked facts.

Use a domain Skill's own presenter when it supplies a more specific supervised
Workflow, as Palquery does. Do not force domain data into this generic layout.
Do not use this parallel generic Workflow unchanged when `synthesis` or
`visual_story` must consume `research`; author the dependency explicitly.

## Visual contract

Treat each Surface as a decision panel, not as a transcript:

- Keep the always-visible state to a short title and summary, two or three
  metrics, one compact visual group, and no more than two short findings.
- Give the roles different visual emphasis: research shows evidence and gaps;
  synthesis shows a conclusion, confidence, and risk; publication shows a
  headline, key figures, and short publishing beats.
- Let each Actor choose `primary_tone`, `secondary_tone`, and `accent_tone` for
  the current subject. These are runtime design choices, not permanent mappings
  from research, synthesis, publication, or any content category to a color.
- Use a varied, coherent palette across borders, badges, progress, metrics, and
  sections to form visual groups. Keep the choice stable through one update, but
  allow a later request or different subject to inspire a different palette.
- Keep a text label or icon beside every color-coded state for accessibility;
  host-owned run status is independent of the Actor's expressive palette.
- Put source lists, caveats, and the full publishing copy in `HrDisclosure`.
- Prefer `HrMetric`, `HrProgress`, `HrGrid`, `HrStatusBadge`, `Icon`, and short
  sections over paragraphs. Use an `HrTable`, `HrTimeline`, `HrBarChart`, image,
  or Artifact only when its data is mechanically available and grounded.
- Bound visible strings in the visual profile and send complete snapshots; do
  not stream growing prose into one field.
- Let the host retain activity and handoff data for audit without rendering that
  generic text above a custom Actor view.
- Do not wash the whole Canvas in one accent, use neutral styling everywhere,
  impose a universal role-to-color mapping, or make color the only carrier of
  meaning.

## Handling a later request

1. Read `get_dag_supervision` for `current_run_id` immediately before mutation.
2. Confirm the request fits the Workflow's advertised Actor responsibilities and
   `command_payload_contract`.
3. Build one `send_dag_actor_command` call whose `commands` array contains every
   affected Actor. Keep unaffected siblings absent and unchanged.
4. In an active round, copy each target's opaque `state_token` to that command's
   `expected_state_token` and use a stable per-Actor idempotency key.
5. In a waiting round, copy `current_round.round_id` exactly to top-level
   `expected_round_id`. Never place it inside a command and never guess the next
   round id.
6. Put typed constraints at their advertised payload paths; do not hide them
   only in the natural-language instruction.
7. Treat command acceptance as dispatch evidence only. Read supervision again
   when the user needs proof that all targeted Actors completed and their Surface
   revisions advanced.
8. Use `focus_dag_actor` only to focus an existing Actor Surface. Do not replace
   it with a new Block.

Call `complete_dag_run` or `cancel_dag_run` only when the user explicitly asks
to end or stop the run. A conflict, stale round id, or temporarily disconnected
Worker is a reason to reread supervision, not to terminate or restart the run.

## Worker update rules

Each presenting Worker uses only its pinned view. It sends every visible model-
owned field as a complete snapshot on every required phase, follows the exact
phase order, checks for an accepted/submitted result, and stops Surface calls
after final. It then reports bounded activity and hands off structured evidence.
The Manager owns stable Surface identity and placement; the Worker never writes
Canvas ids, layout, A2UI, patch sequence, or transport details.
