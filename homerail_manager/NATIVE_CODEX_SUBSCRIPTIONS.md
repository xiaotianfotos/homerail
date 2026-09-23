# Explicit native Codex subscription DAGs

A DAG agent can explicitly use an opted-in Node's existing Codex account through
the native app-server. This path never selects a database API setting. Model and
reasoning effort are exact requests; unavailable choices fail without substitution.

```yaml
api_version: homerail.ai/v1
kind: Workflow
metadata:
  id: native-codex-readonly
  name: Native Codex read-only inspection
spec:
  contracts:
    Task: { type: string, minLength: 1, maxLength: 20000 }
  agents:
    inspector:
      native_subscription:
        provider: codex
        model: gpt-6-astra
        reasoning_effort: low
      system: Inspect the supplied task within the read-only workspace and hand off the result.
  nodes:
    inspect:
      kind: agent
      agent: inspector
      builtin_tool_policy: backend_native
      codex_sandbox: read-only
      workspace_access: { writable_paths: [] }
      inputs: { task: { contract: Task } }
      outputs: { result: {} }
    done:
      kind: terminal
      outcome: success
      inputs: { result: {} }
  edges:
    - { from: $run.input, to: inspect.task }
    - { from: inspect.result, to: done.result }
```

The model and effort above are an example, not defaults. Select a combination
available to the opted-in account. The Manager stores the selection in the
canonical workflow and projects `codex_appserver` with protocol
`codex_subscription`, provider `openai`, and the exact model/effort. It does not
project an API key, endpoint, service-tier override or credential environment.

The agent cannot combine `native_subscription` with an LLM setting, `llm`, a
separate `model`, another backend or arbitrary agent extras. Run-level
`llm_setting_id` is rejected if any subscription agent is present. Profiles may
configure other agents, but a default or explicit profile entry targeting a
subscription agent is rejected. Read-only sandbox/workspace and native tools are
mandatory; credential injection, advisors, dispatch-scoped sessions, container
images and groups are unsupported. This initial Manager path also rejects run
input artifact projections at run creation, including mixed native/API workflows.
The dispatch guard also rejects bindings on previously persisted runs. An
explicit workspace mode of `isolated` or `shared` is forwarded unchanged to the
Node. Other workspace configuration, including `git_clone`, `local_copy` and
source paths, is rejected by public workflow validation and the dispatch guard
rather than discarded. An
isolated verification harness can prepare files
in the Node's run workspace before execution.

Configure the trusted Node as described in
[the Node runtime contract](../homerail_node/NATIVE_CODEX_WORKERS.md). Manager
provisions an on-demand Worker through the existing lifecycle requests with
`execution_mode: native_codex_subscription`. Only Nodes and Workers advertising
`native-codex-subscription` can receive this work. The callback uses the Manager
base URL, not its Docker callback URL; the Node's configured Manager URL must
match. Native-only HTTP create/invoke requests check the native Node capability;
ordinary and mixed workflows retain the existing Docker readiness check.
Nodes and Workers must belong to the Manager's project. Multiple matching native
Nodes are rejected instead of selecting an account arbitrarily. The first
provisioning pins each logical node to its host Node in persisted run metadata;
an unavailable host is waited for without moving its history to another Node.

The existing run ID and creation request digest remain the submission identity.
Registration, actor leases, acknowledgements, handoffs, cancellation and Worker
cleanup use the existing Manager lifecycle. The Worker owns the persistent
native thread binding for `(runId, nodeId)`; Manager does not copy native account
files, translate history into prompts, or introduce another deduplication store.
Worker cleanup must preserve the account home and session-binding directory.
Before sending a native prompt, Manager persists that a send was attempted. The
first envelope has `nativeSessionRequired: false`; every subsequent envelope,
including corrections in the same actor generation, has `true`. Missing native
history then fails explicitly. An ambiguous first send can therefore require
explicit recovery even if no thread was created; Manager never resolves that
ambiguity by silently starting fresh history. Dynamic node append cannot replace
an existing subscription agent's configuration.

Tests in `tests/native-codex-subscription.test.ts` cover public validation,
canonical round trips, settings/profile conflicts, duplicate creation, altered
dispatch rejection, dedicated provisioning, cancellation cleanup and isolated
HTTP admission. These tests do not claim a live account execution or desktop
history visibility; those require the separate end-to-end smoke evidence.
