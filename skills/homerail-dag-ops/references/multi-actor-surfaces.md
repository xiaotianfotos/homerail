# Multi-Actor Surface lifecycle

Read this reference when a request needs independently updating Actor panels,
or when a later user turn changes an existing supervised result.

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

The generic Workflow owns these stable responsibilities:

- `research`: current attributable evidence and uncertainty;
- `synthesis`: independent judgment, evidence quality, and caveats;
- `visual_story`: concise screenshot-ready social copy grounded in checked facts.

Use a domain Skill's own presenter when it supplies a more specific supervised
Workflow, as Palquery does. Do not force domain data into this generic layout.

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
