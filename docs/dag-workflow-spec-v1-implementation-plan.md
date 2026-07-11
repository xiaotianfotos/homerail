# WorkflowSpec v1 Implementation Plan

Status: Draft task design. This plan depends on approval of
`dag-workflow-spec-v1-design.md` and does not authorize implementation yet.

## Delivery Boundary

The first delivery includes strict WorkflowSpec v1 validation, canonical IR,
immutable workflow revisions, legacy YAML compatibility, and
`GET /api/dag/schema`.

It does not include dynamic graph mutation, Graph Patch, new gateway behavior,
new DAG patterns, or a custom textual language.

## Phase 0: Freeze Existing Behavior

### DSV1-001: Legacy characterization fixtures

- Capture canonical test fixtures for every current public orchestration asset.
- Cover aliases currently accepted by `parseDAGYaml()`.
- Cover condition, loop, join, and while gateways.
- Cover terminal edges, failure routes, retry policies, requirements, scorecard,
  workspace, limits, pattern metadata, and runtime profile application.
- Record current valid/invalid outcomes before parser refactoring.

Done when:

- every tracked orchestration asset parses in a focused compatibility suite;
- representative legacy aliases have explicit tests;
- no production parser code has changed.

### DSV1-002: Persistence and run provenance baseline

- Characterize current workflow upsert, YAML hash, runtime profile resolution,
  run creation, cold recovery, and replay metadata.
- Add assertions showing exactly which workflow identity and source evidence a
  run currently retains.

Done when:

- tests would detect loss of an existing workflow or runtime profile;
- current recovery and replay behavior is documented by assertions.

## Phase 1: Public Schema and Typed Source Model

### DSV1-101: Resolve design decisions

- Record decisions for the eight open questions in the design document.
- Add examples for the selected terminal, edge, and port contract syntax.
- Mark rejected alternatives and compatibility consequences.

Done when:

- the design document contains no unresolved syntax or ownership decision that
  blocks schema implementation.

### DSV1-102: Define WorkflowSpec v1 schema

- Create one public schema source for `homerail.ai/v1` Workflow documents.
- Define strict root, metadata, workspace, agent, node, gateway, output, retry,
  policy, and pattern metadata objects.
- Use discriminated unions for node and gateway kinds.
- Prohibit provider and secret fields.
- Bound identifiers, collection sizes, retries, thresholds, and iterations.

Done when:

- valid v1 fixtures pass;
- unknown and misspelled fields fail with a JSON path;
- invalid gateway-specific fields fail before graph compilation;
- schema artifacts cannot drift from Manager validation unnoticed.

### DSV1-103: Source-aware diagnostics

- Parse YAML with source ranges.
- Map schema and semantic diagnostics to line/column locations.
- Define stable diagnostic codes and JSON output.
- Preserve concise CLI text output.

Done when:

- malformed fixtures assert code, path, line, and message;
- multiple independent field errors can be returned together.

## Phase 2: Canonical Compiler and IR

### DSV1-201: Define CanonicalWorkflowIR v1

- Replace permissive graph configuration shapes with discriminated canonical
  node and gateway unions.
- Define structured port and edge references.
- Keep runtime-only mutable fields out of IR.
- Define deterministic ordering and serialization.

Done when:

- canonical IR has no YAML shorthand or aliases;
- equivalent v1 documents produce byte-identical canonical JSON and hash;
- TypeScript exhaustiveness checks cover every node and gateway kind.

### DSV1-202: Compile WorkflowSpec v1

- Validate source schema.
- Normalize defaults and routing shorthand.
- Build explicit canonical edges and derived graph metadata.
- Run semantic graph validation against canonical IR.

Done when:

- v1 fixtures compile to approved IR snapshots;
- invalid references, cycles, unbounded feedback, and terminal gaps fail with
  actionable diagnostics.

### DSV1-203: Isolate legacy/v0 adapter

- Move current compatibility normalization behind a legacy adapter.
- Compile legacy source into the same canonical IR.
- Prevent new v1-only aliases from entering the legacy path.

Done when:

- all Phase 0 fixtures retain behavior;
- runtime execution cannot distinguish v1 IR from equivalent legacy IR;
- legacy warnings identify the source as unversioned without blocking it.

### DSV1-204: Move runtime consumers to canonical IR

- Update graph executor, active run creation, validation, scorecard, recovery,
  and inspection paths to consume canonical IR or a single projection of it.
- Remove source-format conditionals from runtime code.

Done when:

- existing package tests pass for both source formats;
- one parity test runs equivalent legacy and v1 workflows and compares graph
  transitions and terminal output.

## Phase 3: Immutable Workflow Revisions

### DSV1-301: Add revision persistence

- Add immutable workflow revision storage and a mutable workflow head pointer.
- Store source text/hash, canonical JSON/hash, API version, and compiler version.
- Migrate existing workflow rows transactionally as legacy revision 1.

Done when:

- existing databases migrate without data loss;
- changed canonical content creates revision N+1;
- idempotent sync does not create a duplicate revision;
- rollback to the pre-migration binary remains covered by the repository's
  migration compatibility policy.

### DSV1-302: Bind runs to exact workflow revisions

- Include workflow revision, canonical hash, and compiler version in run-start
  metadata.
- Recover and inspect runs from their immutable snapshot.
- Keep later workflow syncs from changing active or historical runs.

Done when:

- a workflow can be updated while an older run continues with its original IR;
- cold recovery and replay preserve the same revision and graph hash;
- API and CLI inspection expose provenance.

## Phase 4: Manager API and CLI

### DSV1-401: Implement `GET /api/dag/schema`

- Return the exact WorkflowSpec v1 JSON Schema used by Manager.
- Include API version, kind, compiler version, and stable schema hash/ETag.
- Do not expose provider configuration or secrets.

Done when:

- endpoint schema validates all approved v1 fixtures;
- endpoint supports cache validation;
- API tests prove the response and internal validator use the same schema.

### DSV1-402: Add CLI validation and inspection

- Add or extend a command to validate YAML/JSON without syncing it.
- Support human-readable and JSON diagnostics.
- Show source version, canonical hash, and derived graph summary.
- Add an opt-in command to print or fetch the public schema.

Done when:

- CI can validate all tracked workflow assets without starting Manager runtime;
- AI clients can consume structured diagnostics.

### DSV1-403: Manager Agent schema access

- Expose schema retrieval and validation through bounded Manager Agent tools.
- Update DAG authoring skill guidance to request the live schema before emitting
  v1 source.

Done when:

- Manager Agent can produce a valid v1 workflow through public tools;
- invalid generated source returns diagnostics rather than partial sync.

## Phase 5: Built-in Assets and Documentation

### DSV1-501: Migrate generated patterns and examples

- Make built-in pattern instantiation emit WorkflowSpec v1.
- Convert tracked examples after parity tests pass.
- Retain legacy fixtures specifically for compatibility testing.

Done when:

- every built-in pattern emits strict v1 source;
- static, fake-dispatch, and real model-backed pattern validation remain green;
- no runtime profile embeds provider or secret data.

### DSV1-502: Publish authoring and migration documentation

- Document the v1 language, defaults, node/gateway contracts, handoff schemas,
  diagnostics, revisions, and compatibility policy.
- Document that Graph Patch is a separate future protocol.
- Provide minimal, fan-out, conditional, finite-loop, and bounded-while examples.

Done when:

- a new user or AI can author, validate, sync, and run v1 without reading
  Manager source code.

## Required Test Matrix

### Schema tests

- Valid minimal and full WorkflowSpec v1 documents.
- Unknown fields at every object layer.
- Every node and gateway discriminant.
- Invalid identifiers, references, bounds, output targets, and payload schemas.
- Explicit rejection of provider, model, endpoint, and secret fields.

### Compiler tests

- Stable canonical snapshots and hashes.
- Equivalent YAML and JSON produce identical IR.
- Default materialization and deterministic ordering.
- Data/control dependency semantics selected in design review.
- Terminal and feedback edge normalization.

### Compatibility tests

- Every existing orchestration asset.
- Existing database rows and runtime profiles.
- Legacy aliases and current error behavior where compatibility requires it.
- Legacy and v1 execution parity.

### Persistence tests

- Initial migration, idempotent sync, semantic revision, concurrent sync, and
  transaction rollback.
- Run provenance, cold recovery, replay, and historical inspection.
- Source hash versus canonical hash behavior.

### API and CLI tests

- Schema endpoint, ETag/hash, and no secret leakage.
- Validation diagnostics in text and JSON modes.
- Pattern instantiation and workflow sync through CLI and Manager Agent tools.

### End-to-end gates

- Root typecheck, build, and package tests on supported Node versions.
- Windows CI and Docker lifecycle test.
- Legacy public smoke DAG.
- WorkflowSpec v1 public smoke DAG.
- Full model-backed DAG pattern validation on the isolated live runner.

## Pull Request Strategy

Do not implement all phases in one review unit after the design is approved.
Recommended implementation PR sequence:

1. Schema, diagnostics, canonical IR, and legacy compiler parity.
2. Runtime adoption of canonical IR.
3. Workflow revision persistence and run provenance.
4. Manager schema API, CLI, Manager Agent tools, assets, and documentation.

Each PR must keep legacy workflows runnable and include migration or parity
evidence appropriate to its blast radius. Graph Patch starts only after all four
are merged and WorkflowSpec v1 is stable.

## Discussion Gate

Implementation remains paused until the design review resolves:

- public envelope shape;
- edge and `after` semantics;
- terminal representation;
- handoff payload schema ownership;
- schema source-of-truth strategy;
- RuntimeProfile v1 scope;
- formatting-only revision retention.
