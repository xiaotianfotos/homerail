# Auto Fix v2 Task Document Template

This template is the human-readable source document staged as the immutable
`task_document` input of an Auto Fix v2 run. The caller may generate it through
Manager Agent or another trusted client, but must review it before staging.

The run binds the staged document by SHA-256. Do not edit the staged content in
place. A task change creates a new document revision and a new run.

PR number, repository, branches, base/head SHAs, and credentials are structured
control-plane inputs. Executable local validation commands belong in the
immutable `task-plan.json`; they must not be copied into this document as
authoritative runtime configuration.

---

# <Task title>

## Task Identity

- Source Issue: `<owner/repository>#<number>`
- Task revision: `<caller-defined revision>`
- Prepared by: `<Manager Agent, person, or external caller>`
- Prepared at: `<ISO-8601 timestamp>`

These fields are provenance for readers. The staged artifact digest is the
runtime identity.

## Objective

Describe one concrete outcome. State what a user or operator can do after the
change that they cannot do now.

## Current Behavior And Evidence

Describe the observed behavior and why it is wrong or incomplete. Include
bounded, reproducible evidence such as relevant files, failing test names,
error categories, or public references. Separate verified facts from
assumptions.

## Desired Behavior

Describe the expected externally visible and internal behavior. Include failure
and recovery behavior where relevant.

## Proposed Design

Provide the implementation direction and worker division in enough detail that
the trusted caller can emit `task-plan.json` without another Agent
rediscovering the architecture. Identify the preferred product layer and
explain any Manager change under the allowed Manager categories.

```text
Layer Decision:
- Problem layer:
- Preferred fix layer:
- Manager touched: yes/no
- Manager Change Justification: <allowed category or n/a>
- Rejected shortcuts:
- Public entry path:
- Validation path:
```

## Required Invariants

- `<invariant that must remain true>`
- `<security, compatibility, persistence, or recovery invariant>`

## Repository Scope

### Allowed paths

- `<path or bounded path prefix>`

### Read-only context paths

- `<path or bounded path prefix>`

### Explicitly forbidden paths

- `.github/**`
- `.gitmodules`
- credential, secret, signing-key, and private environment files
- `<task-specific forbidden path>`

The runtime repository policy remains authoritative and may be stricter than
this list. This document cannot grant access that the run policy denies.
Allowed paths must be explicit repository-relative prefixes;
`writable_paths: ["."]` is rejected.

## Work Decomposition Guidance

List the exact parallel-safe work items the caller should encode in the
immutable `task_plan` run input.

1. `<parallel-safe area and expected output>`
2. `<parallel-safe area and expected output>`

If two areas depend on uncommitted output from each other, combine them into
one WorkItem. Auto Fix v2 executes the supplied plan exactly and does not run a
second in-DAG analyzer to reinterpret it.

## Acceptance Criteria

- [ ] `<observable behavior or contract>`
- [ ] `<failure/recovery behavior>`
- [ ] `<compatibility expectation>`
- [ ] No unrelated changes.

## Validation Requirements

Name the bounded container checks that should predict whether later repository
CI will pass. The trusted caller must encode every executable command as a
`local_tests` item in `task-plan.json`; raw commands here are explanatory only.
Auto Fix v2 does not dispatch or wait for GitHub CI inside its review/fix loop.
Every item must include a `timeout_seconds` value from 1 through 1800. This
bounds the test process only; it is never a model or tool-call budget.

- Local test id: `<stable id used in task-plan.json>`
- Focused evidence: `<test suite, fixture, or behavior>`
- Why this bounded set predicts CI: `<coverage rationale>`
- Deferred post-convergence CI: `<repository workflow/check set run later>`

## Risks And Edge Cases

- `<known risk and expected handling>`
- `<head drift, restart, platform, concurrency, or compatibility case>`

## Out Of Scope

- `<explicitly excluded adjacent work>`
- Automatic PR approval, ready transition, merge, force push, or branch delete.

## Human Review Notes

Call out anything the final human reviewer must verify that cannot be proven by
the bounded local tests and two-review convergence gate.
