# Codex harness / DeepSeek Responses

Status: Ready for review; investigated and live-tested on 2026-07-31.

## Supported runtime shapes

| Surface | Codex model source | Wire transport | Placement |
| --- | --- | --- | --- |
| Manager Agent | OpenAI/ChatGPT subscription | Codex native Responses transport | host |
| Manager Agent | HomeRail setting with `responses_base_url` | Responses | host |
| DAG actor | HomeRail setting with `responses_base_url` | Responses | container |

DeepSeek V4 Flash is the built-in provider-backed Codex preset. Local or custom
Responses-compatible providers keep using the generic transport fallback; they
do not inherit DeepSeek model assumptions.

## Abstraction boundary

Provider transport and provider/model capabilities are deliberately separate:

- `codex-responses.ts` owns generic Codex Responses wiring: provider id, base
  URL, credential environment variable, wire API, app-server isolation, and an
  optional model catalog path.
- `codex-provider-profiles.ts` owns provider/model facts that Codex cannot infer
  from an endpoint URL. DeepSeek is the first registered profile.
- Manager and Worker materialize the same shared profile into their own
  process-local Codex homes. Placement-specific filesystem/process work stays
  outside the provider profile.
- Unregistered Responses providers retain fallback behavior. A registered
  provider fails closed for unknown or explicitly unsupported models.

This keeps `deepseek-v4-flash`, its reasoning levels, and its Codex catalog
metadata out of the generic Manager/DAG harness code.

## DeepSeek Responses contract

The built-in DeepSeek configuration is:

- model: `deepseek-v4-flash`
- API root: `https://api.deepseek.com`
- Codex wire API: `responses`
- reasoning efforts: `none`, `low`, `high`, `max`
- HomeRail default reasoning effort: `high`

`deepseek-v4-pro` is recorded as known but currently unsupported for Responses,
so HomeRail rejects it before starting Codex. This follows DeepSeek's official
[Responses API guide](https://api-docs.deepseek.com/zh-cn/guides/responses_api)
and [Codex integration guide](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex).

The shared model profile also supplies the model metadata required by Codex
0.145.0. HomeRail obtains the current native Codex base instructions from
`codex debug models --bundled` and builds an isolated `model_catalog_json`;
it does not vendor a stale copy of the native prompt. The metadata shape is
anchored to DeepSeek's official
[Codex setup catalog](https://cdn.deepseek.com/api-docs/codex-deepseek-setup.sh).

The real provider credential remains in the Worker. For each provider-backed
dispatch the Worker starts a loopback-only relay restricted to `POST` on that
provider's `/responses` path, then gives Codex a random dispatch-scoped relay
key and relay URL through `HOMERAIL_CODEX_API_KEY`. The relay replaces that
authorization value with the real provider credential while streaming the
request and response. It closes with the adapter, so reading a Codex parent
process's environment cannot reveal a reusable external credential.

The scoped variable is excluded from Codex-spawned shell environments, is not
written to configuration, and is not included in command arguments. As defense
in depth, the production Worker image preloads
`homerail-codex-secret-guard.so` into the Worker and dynamically linked Codex
launcher processes. Its constructor marks those processes non-dumpable after
`exec` (ordinary `exec` resets this Linux flag), protecting the Worker's relay
closure as well as launcher environments. Linux provider dispatch fails closed
when the configured guard is absent. Because the dynamic loader does not report
an ignored preload for a static or secure-exec launcher, the relay credential
boundary remains the primary control when guard loading cannot be observed.
Provider-backed Codex
also disables ambient apps, plugins, remote plugin sharing, Skill search/install,
and native multi-agent features.

Direct, secret-safe probes returned HTTP 200 for all four reasoning efforts.
DeepSeek Responses is stateless and does not support OpenAI conversation/store
features such as `previous_response_id`, `conversation`, `store`, background
mode, or provider-side truncation; the HomeRail harness does not depend on
those fields.

## Live harness verification

The tests below used the encrypted local DeepSeek setting, the official
`https://api.deepseek.com` base URL, `deepseek-v4-flash`, and the Responses
transport. No API key was logged.

### Manager Agent

A host Manager Agent used Codex app-server to review the change set. It
completed naturally with HTTP 200 after a multi-minute run, producing 116 tool
calls and 75 reasoning items. Debug events identified the DeepSeek provider,
Responses base URL, model catalog, and selected reasoning effort.

### DAG Workers

A test-only copy of the three-reviewer PR workflow assigned the same
`deepseek-codex-low` profile to all three actors. The tracked workflow was not
modified. Final run `44d99f3812f03b768cdce953` completed naturally after
about ten minutes:

- all three Worker containers initialized `homerail_codex_appserver/0.145.0`;
- all three selected `deepseek-v4-flash`, Responses, the provider model
  catalog, and `reasoning_effort=low`;
- the nested checkout was selected as `cwd=/workspace/repository` while
  `/workspace` remained the HomeRail audit boundary;
- an outer read-only DAG workspace mapped to Codex `read-only` sandboxing;
- reviewers made 55, 85, and 65 tool calls (205 total), read all three diff
  chunks, and each produced a contract-valid `request_changes` handoff;
- the graph produced 11 non-empty handoffs, no automatic handoff fallback, no
  failed nodes, and a ready `pr-review.json` artifact.

The graph's final `cancelled` status is the workflow's semantic rejection path
for review findings, not a harness or transport failure.

The live test exposed and fixed two deployment-specific gaps: the Worker image
did not contain the Codex CLI, and Codex `workspace-write` sandbox bootstrap
was incompatible with an outer read-only checkout. The image now pins and
verifies Codex 0.145.0, and the Worker maps the declared HomeRail workspace
mode into Codex sandbox/cwd configuration.

Production PR-review CI uses deterministic diff injection and agents that do
not need built-in tools. Workflow definitions should not use tool-call counts
as an execution limiter.

## Claude Agent SDK alignment

| Capability | Claude Agent SDK | Manager Codex | DAG Codex in this change |
| --- | --- | --- | --- |
| Shared HomeRail Manager prompt | yes | yes | n/a |
| Preserve native harness prompt and append HomeRail instructions | yes | yes (`developerInstructions`) | yes (`developerInstructions`) |
| Native HomeRail tools | in-process MCP | app-server dynamic tools | app-server dynamic tools |
| Manager tool schema parity | yes | yes, parity-tested | n/a |
| Native Skill bodies, references, and assets | yes | yes for HomeRail/plugin roots | yes, explicit turn projection |
| Provider-backed ambient app/plugin isolation | n/a | yes | yes |
| User-level ambient Skill isolation | yes | provider-backed: yes; subscription uses account home | yes (isolated `HOME`/`CODEX_HOME`) |
| Project-level ambient Skill isolation | yes | no | no; Codex extra roots are additive |
| Correct turn interruption | SDK abort | `turn/interrupt` | `turn/interrupt` |
| Persistent native session | yes | yes | no; DAG checkpoint resume only |
| Live mid-turn steering | yes | partial | no |
| Live Voice | n/a | subscription Codex only | n/a |
| Exact Claude-style built-in tool allowlist | yes | no | no; asserted DAG allowlists fail closed |
| Explicit backend-native coding surface | n/a | implicit | yes; `backend_native` + required workspace policy |
| Workspace read-only mode | hooks plus SDK permissions | Codex sandbox | HomeRail outer policy + Codex `read-only` |
| Per-root mixed read/write policy | yes | configurable Codex sandbox | audit-only; not yet mapped into Codex roots |
| Token usage and backend-native raw trace | yes | partial | no |

The most important Skill limitation is upstream-shaped: `skills/extraRoots/set`
adds roots, while Codex can still discover project `.agents/skills`. Codex can
disable individual discovered Skills, but it currently has no "only these
roots" switch. HomeRail must not claim strict fixed-projection parity until
that is enforceable.

## Follow-up work

1. Add an app-server capability or two-pass discovery/restart strategy that
   disables every project Skill outside the pinned DAG projection.
2. Map HomeRail's per-root mixed workspace policy and, where a workflow asserts
   a Claude-style built-in tool allowlist, an equivalent enforceable Codex
   permission policy. Exact allowlists remain fail-closed; workflows that need
   the complete Codex coding surface must opt in explicitly with
   `builtin_tool_policy: backend_native` and a declared workspace policy.
3. Add DAG native thread resume, turn-controller steering, cumulative usage,
   and raw app-server trace capture.
4. Distinguish subscription Codex and provider-backed Codex more explicitly in
   settings UI, including provider-profile reasoning controls.
5. Add a CI app-server integration fixture backed by a deterministic local
   Responses server; keep the live DeepSeek smoke test opt-in and secret-safe.

Provider-backed Responses runtimes currently reject Live Voice explicitly;
they cannot use Codex's subscription-backed realtime transport. Likewise, an
explicit harness selection is authoritative: selecting Codex with a setting
that lacks a Responses endpoint fails validation instead of silently switching
to another harness.
