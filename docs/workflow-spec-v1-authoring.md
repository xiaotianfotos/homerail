# WorkflowSpec v1 Authoring

WorkflowSpec is HomeRail's versioned DAG language. YAML and JSON are equivalent
serializations; Manager compiles either form into the same canonical graph and
hash.

## Discover the Live Contract

Do not copy a stale schema from documentation when Manager is available:

```bash
hr dag schema > /tmp/homerail-workflow-schema.json
hr --json dag validate ./workflow.yaml
```

The corresponding Manager endpoints are:

```text
GET  /api/dag/schema
POST /api/dag/validate
```

Manager Agent uses `get_dag_schema`, `validate_dag_workflow`, and
`sync_dag_workflow` for the same flow.

## Minimal Runnable Workflow

```yaml
api_version: homerail.ai/v1
kind: Workflow

metadata:
  id: verified-task
  name: Verified Task

spec:
  contracts:
    Text:
      type: string
      maxLength: 20000

  agents:
    worker:
      system: Execute the supplied task and return concise evidence.

  nodes:
    execute:
      kind: agent
      agent: worker
      inputs:
        task: { contract: Text }
      outputs:
        result: { contract: Text }

    done:
      kind: terminal
      outcome: success
      inputs:
        result: { contract: Text }

  edges:
    - { from: $run.input, to: execute.task }
    - { from: execute.result, to: done.result }
```

Run input is the prompt supplied when the run starts. A JSON object or array
may be supplied as a JSON-encoded prompt; Manager parses it before validating
the entry contract.

## Language Rules

- Root fields are `api_version`, `kind`, `metadata`, and `spec` only.
- Unknown fields fail validation instead of being ignored.
- Node kinds are `agent`, `condition`, `join`, `foreach`, `while`, and
  `terminal`.
- Ports declare interfaces. Connections exist only in `spec.edges`.
- A data edge carries a payload and implies a completion dependency.
- `depends_on` is only for a completion barrier that carries no payload.
- Multiple producers must converge through an explicit `join`.
- Feedback may target only `foreach` or `while` and requires
  `max_traversals`.
- Every output port must be routed. Every non-terminal node must have a path to
  a terminal.
- Terminal outcome is `success`, `failure`, or `cancelled`.
- Provider, model, endpoint, API key, and other runtime credentials are not
  workflow fields. Bind them through a database runtime profile.

## Contracts

Contracts are named once and referenced by both sides of an edge:

```yaml
contracts:
  Verdict:
    type: object
    additionalProperties: false
    required: [verdict, evidence]
    properties:
      verdict: { type: string, enum: [pass, fail] }
      evidence:
        type: array
        maxItems: 100
        items: { type: string, maxLength: 4000 }
```

V1 requires the source and target ports of an edge to reference the same named
contract. Manager validates run input and model handoffs at runtime. A contract
violation fails the node and cannot continue through a success edge.

## Sync and Revisions

```bash
hr --json dag validate ./workflow.yaml
hr dag sync ./workflow.yaml
hr profile sync ./runtime.profile.yaml --workflow verified-task
hr run --workflow verified-task --profile local-main --prompt "Inspect the release"
```

The first sync creates revision 1. A changed canonical hash creates revision
N+1. Whitespace, comments, and formatting changes update source audit metadata
without creating a semantic revision. Every run stores its exact workflow
revision, canonical hash, compiler version, contracts, and runtime graph so a
later workflow sync cannot change an active or historical run.

Revision inspection endpoints are:

```text
GET /api/dag/workflows/:workflow_id/revisions
GET /api/dag/workflows/:workflow_id/revisions/:revision
```

## Legacy Compatibility

Unversioned HomeRail YAML remains accepted as `legacy/v0`. Its aliases, inline
`outputs.<port>.to` routes, `after`, gateway names, and empty-string terminals
continue through an isolated adapter. New workflows and generated built-in
pattern instances use strict v1.

Legacy source is not rewritten automatically. Validate and review a migrated
v1 document before syncing it because v1 intentionally makes data dependencies,
terminal outcomes, contracts, and feedback bounds explicit.

## Not Part of v1

WorkflowSpec describes a static workflow revision. Dynamic graph changes will
use a separate audited Graph Patch protocol against a run graph revision. Human
approval nodes, executable deterministic predicates, rollback compensation,
durable schedules, and dynamic fan-out remain separate runtime capabilities;
they must not be emulated through unvalidated YAML fields.
