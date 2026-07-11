# WorkflowSpec v1 Design

Status: Accepted for incremental implementation on 2026-07-11. WorkflowSpec
validation and canonical compilation may land before runtime adoption; legacy
runtime behavior remains authoritative until the runtime migration phase.

For a complete Chinese overview of the proposed DSL, its rationale, execution
model, compatibility strategy, and future extension boundary, see
[`dag-workflow-spec-v1-overview.zh-CN.md`](dag-workflow-spec-v1-overview.zh-CN.md).
For the runnable authoring flow and minimal v1 source, see
[`workflow-spec-v1-authoring.md`](workflow-spec-v1-authoring.md).

## Context

HomeRail currently uses YAML as both the authoring format and the persisted
source for DAG workflows. `parseDAGYaml()` normalizes that YAML directly into
`ParsedDAG`, and stored workflows are parsed again when a run is created. This
has worked for the initial static DAG runtime and the built-in pattern library,
but the contract is implicit:

- there is no workflow schema or language version;
- unknown fields can be ignored instead of rejected;
- gateway configuration is represented by one permissive structure;
- handoff ports describe routing but not payload schemas;
- aliases such as `type`, `node_type`, `gateway.kind`, and `gateway.type` are
  normalized by code rather than defined by a public contract;
- a workflow row is mutable and has no immutable revision history;
- the authoring representation and runtime graph types are coupled.

YAML is a serialization format, not the domain model. HomeRail already has an
implicit DSL; WorkflowSpec v1 makes that DSL explicit while retaining YAML and
JSON as interchangeable serializations.

## Goals

1. Define one strict, versioned public contract for static DAG workflows.
2. Compile authoring documents into a canonical, provider-independent IR.
3. Preserve every existing legacy workflow without changing its behavior.
4. Persist immutable workflow revisions and bind each run to an exact revision.
5. Expose the public JSON Schema through Manager for CLI and AI clients.
6. Produce path-aware diagnostics suitable for humans and autonomous agents.
7. Keep runtime model selection in database-backed runtime profiles.

## Non-goals

- Dynamic graph mutation or a Graph Patch protocol.
- Executor-Advisor, sub-DAG calls, or new orchestration patterns.
- New gateway behavior.
- A general-purpose expression or scripting language.
- Replacing YAML with a custom textual syntax.
- Embedding provider names, models, endpoints, or secrets in workflow source.
- Automatically rewriting stored legacy YAML.

Dynamic graph mutation will be designed separately after the static language,
canonical IR, revision model, and run snapshot contract are stable.

## Proposed Architecture

```text
YAML or JSON
    |
    v
WorkflowSpec v1                 public authoring DSL
    |
    | parse, validate, normalize, compile
    v
CanonicalWorkflowIR v1          provider-independent canonical graph
    |
    | bind workflow revision and runtime profile
    v
RunPlan revision 0              immutable run-start snapshot
    |
    v
Runtime graph state             execution state, mailboxes, counters
```

Legacy YAML uses a separate legacy adapter and compiles into the same canonical
IR. Runtime code should consume canonical IR rather than branch on source
format.

## Proposed Authoring Envelope

The v1 envelope is:

```yaml
api_version: homerail.ai/v1
kind: Workflow

metadata:
  id: release-review
  name: Release Review

spec:
  description: Review one release candidate and report a verified verdict.
  workspace:
    mode: isolated

  contracts:
    Task: { type: object }
    Evidence: { type: object }

  agents:
    reviewer:
      system: Review the supplied release evidence.

  nodes:
    review:
      kind: agent
      agent: reviewer
      inputs:
        task: { contract: Task }
      outputs:
        reviewed: { contract: Evidence }

    report:
      kind: agent
      agent: reviewer
      inputs:
        evidence: { contract: Evidence }
      outputs:
        done: { contract: Evidence }

    success:
      kind: terminal
      outcome: success
      inputs:
        result: { contract: Evidence }

  edges:
    - { from: $run.input, to: review.task }
    - { from: review.reviewed, to: report.evidence }
    - { from: report.done, to: success.result }
```

V1 uses top-level edges and explicit terminal nodes only. Existing inline
`outputs.<port>.to` routing and empty-string terminal targets remain supported
only by the isolated legacy/v0 adapter.

## Strict Schema

WorkflowSpec v1 should publish a JSON Schema with these properties:

- unknown fields are rejected at every defined object boundary;
- `api_version` and `kind` are required and constant for v1;
- node definitions are a discriminated union by `kind`;
- gateway configuration is a discriminated union by gateway kind;
- node and port identifiers use one documented identifier grammar;
- output targets use one documented grammar and are validated before compile;
- limits, retry bounds, thresholds, and iteration counts are range checked;
- provider, model, API key, and endpoint fields are prohibited;
- defaults are documented and materialized in canonical IR.

Schema validation is necessary but not sufficient. Semantic validation still
checks graph connectivity, references, cycles, feedback bounds, gateway
dependencies, terminal paths, and provider policy.

### Handoff Contracts

V1 should allow ports to declare optional JSON Schema payload contracts. A
minimal shape could be:

```yaml
outputs:
  verdict:
    payload_schema:
      type: object
      required: [verdict, evidence]
      additionalProperties: false
      properties:
        verdict:
          enum: [pass, fail]
        evidence:
          type: array
    to: gate.in:verdict
```

The design must decide whether input ports repeat their expected schema or
reference an output contract. Compile-time compatibility checks should be
limited to deterministic JSON Schema relationships that HomeRail can explain;
runtime payload validation remains authoritative.

## Canonical IR

Canonical IR is JSON-compatible, contains no YAML aliases or shorthand, and is
stable for hashing and persistence. It should contain:

- normalized workflow metadata;
- resolved workspace and policy defaults;
- canonical agent references without runtime model credentials;
- a discriminated node union;
- explicit node input and output ports;
- explicit edges with structured source and target references;
- normalized retry and gateway configuration;
- derived entry, terminal, and bounded-feedback metadata;
- the source API version and compiler version.

Illustrative TypeScript only:

```ts
interface CanonicalWorkflowIR {
  ir_version: "1";
  workflow_id: string;
  name: string;
  description?: string;
  agents: Record<string, CanonicalAgentSpec>;
  nodes: CanonicalNode[];
  edges: CanonicalEdge[];
  entry_nodes: string[];
  terminal_nodes: string[];
  feedback_sources: string[];
  source_api_version: string;
  compiler_version: string;
}
```

Canonical serialization must sort map-derived collections and materialize
defaults so semantically equivalent source documents produce the same
canonical hash.

`ParsedDAG` can be evolved into this IR or become a runtime projection of it.
The public DSL must not expose runtime-only mutable state such as node status,
mailboxes, traversal counters, dispatch credentials, or worker identities.

## Dependency and Edge Semantics

Current YAML uses both `after` and routed outputs:

- `after` is a completion barrier;
- an output route carries data into a named input mailbox.

This distinction is useful, but requiring both for the common data dependency
is error prone. Two options need design review:

1. Preserve current semantics exactly in v1. Authors declare both control and
   data dependencies when both are needed.
2. Make a data route imply a completion dependency in v1, with `after` reserved
   for control-only barriers. The compiler emits both canonical edge forms.

Option 2 is the current recommendation because it removes redundant authoring
state, but it requires explicit rules for fan-in and bounded feedback edges.

## Workflow Identity and Revisions

`metadata.id` is the stable workflow identity. Revision is assigned by Manager,
not trusted from authoring input.

Proposed persistence model:

```text
dag_workflows
  workflow_id
  head_revision
  created_at
  updated_at

dag_workflow_revisions
  workflow_id
  revision
  api_version
  source_format
  source_text
  source_hash
  canonical_json
  canonical_hash
  compiler_version
  created_at
```

Sync behavior:

- first sync creates revision 1;
- a new canonical hash creates the next immutable revision;
- the same canonical hash is idempotent and does not create a revision;
- source-only formatting changes may update source metadata without changing
  semantic revision, subject to an explicit retention policy;
- every run stores workflow id, workflow revision, canonical hash, and compiler
  version in its immutable start metadata.

This model prevents a parser upgrade or later workflow sync from changing the
meaning of an already-created run.

## Legacy Compatibility

Existing unversioned YAML is `legacy/v0` and remains accepted through a legacy
adapter. Compatibility rules:

- legacy parsing keeps current aliases and defaults;
- legacy semantic behavior is covered by characterization tests before refactor;
- legacy source compiles into CanonicalWorkflowIR v1;
- legacy rows are not rewritten automatically;
- new built-in pattern instances and newly generated examples use v1;
- a future `hr dag migrate` command may produce reviewed v1 source, but it is
  not required for the first implementation.

The compatibility layer should be isolated. New v1 features must not be added
to the legacy parser through more aliases.

## Manager Schema API

Manager should expose:

```text
GET /api/dag/schema
POST /api/dag/validate
GET /api/dag/workflows/:workflow_id/revisions
GET /api/dag/workflows/:workflow_id/revisions/:revision
```

Proposed response data:

```json
{
  "api_version": "homerail.ai/v1",
  "kind": "Workflow",
  "schema": {},
  "compiler_version": "1",
  "examples": ["minimal", "fan-out", "bounded-loop"]
}
```

The schema endpoint supports ETag and a stable schema hash. It returns the
same schema used by Manager validation, not a separately maintained copy. CLI
and Manager Agent tools use these endpoints to fetch the live contract, receive
structured diagnostics, and inspect immutable source/canonical provenance.

CLI entry points are `hr dag schema` and `hr dag validate <file>`. Manager Agent
uses `get_dag_schema`, `validate_dag_workflow`, and `sync_dag_workflow`; custom
source is not synced until validation succeeds.

## Diagnostics

Errors should include:

- stable error code;
- source path when available;
- YAML/JSON path;
- line and column when available;
- concise message;
- optional expected values or remediation hint.

Example:

```text
DAG_SCHEMA_UNKNOWN_FIELD at spec.nodes.review.gatway_config (line 24, col 7):
unknown field 'gatway_config'; expected 'gateway_config'
```

The compiler should collect independent schema errors where safe instead of
stopping at the first typo.

## Security and Policy Boundaries

- Workflow source cannot contain secrets or direct runtime credentials.
- Runtime profiles continue to reference encrypted database settings by id or
  alias.
- Schema retrieval is read-only and contains no configured provider data.
- Payload schemas need size and nesting limits to avoid validation abuse.
- Canonical hashes must be computed from deterministic serialization.
- Compiler and migration code must not execute YAML tags, expressions, or
  embedded scripts.

## Dynamic Graph Boundary

Future dynamic graphs should not edit persisted WorkflowSpec source. A run will
start from an immutable RunPlan and accept audited Graph Patch commands against
the current graph revision. Expected patch fields include operation,
base_revision, idempotency_key, actor, reason, and a typed node or edge payload.

Graph Patch is deliberately not specified here. WorkflowSpec v1 must only leave
a clean boundary for it:

- canonical node and edge types are reusable by patches;
- each run has a graph revision;
- runtime graph snapshots are serializable;
- completed or traversed graph regions can later be protected by patch policy.

## Accepted Decisions

1. Use the `api_version`/`kind`/`metadata`/`spec` envelope.
2. Require top-level explicit `spec.edges`; inline routes are legacy-only.
3. A data edge implies completion dependency; `depends_on` is control-only.
4. Express completion with explicit terminal nodes whose outcome is `success`,
   `failure`, or `cancelled`.
5. Input and output ports reference the same named, bounded JSON Schema contract.
6. A typed TypeBox definition generates both TypeScript types and the exact JSON
   Schema returned by Manager.
7. RuntimeProfile v1 remains a separately versioned follow-up.
8. Formatting-only source changes update sync audit metadata but do not create a
   semantic revision.
9. Run input is the reserved source `$run.input`.
10. V1 node kinds are `agent`, `condition`, `join`, `foreach`, `while`, and
    `terminal`.

These decisions freeze WorkflowSpec v1 authoring semantics. Later additions
require a compatible schema extension or a new API version; legacy aliases must
not leak into v1.
