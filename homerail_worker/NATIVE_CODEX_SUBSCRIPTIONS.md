# Native subscription execution and history

This opt-in mode uses the existing Codex app-server with its authenticated native
home. It is selected only by the `codex_subscription` protocol, through the
[Manager agent selection](../homerail_manager/NATIVE_CODEX_SUBSCRIPTIONS.md) and
[Node-owned Worker lifecycle](../homerail_node/NATIVE_CODEX_WORKERS.md).
The ordinary API adapter continues using its temporary, isolated Codex home.

The native Worker requires an existing ChatGPT login and an exact model and
reasoning effort available in `model/list`. It verifies the thread response
against that selection. API credentials, alternate provider endpoints, service
tier overrides and credential environment projections are rejected. The Worker
cannot switch to an API provider or another execution backend when a native
request fails. Native-only host Workers also reject API tasks independently of
Manager routing.

## Restricted execution

The current host binary must support named permission profiles in the app-server.
For each process the adapter supplies a uniquely named profile through temporary
command-line configuration: deny filesystem reads by default, allow the native
minimal runtime paths and the assigned run workspace, deny the native account
and session-map directories, allow no writes or command network access. The
profile is selected and verified on thread creation/resume and selected again
for each turn. There is no fallback to a broader sandbox on older binaries.

The adapter disables inherited hooks, external integrations, browser/computer
use, web search, ambient Skills and multi-agent spawning. It refuses overridden
OpenAI/ChatGPT endpoints and external model-instructions files. User configuration
is not rewritten. Native sandboxed tools retain their required code-mode host.
Model commands receive an empty inherited environment plus fixed runtime values;
the native process receives only basic OS variables and its trusted `CODEX_HOME`.
Manager control-plane tokens and API credentials are not inherited by the model.

This initial mode does not support projected Skills, advisors, credential broker
access or write-capable workspaces. HomeRail dynamic tools retain their normal
contract checks. Native interactive permission/login requests and unknown dynamic
tools are rejected. The original account directory is used in place, never copied
to a run workspace, prompt or receipt.

## Native continuity and terminal results

The adapter stores only a binding digest and native thread ID in the Node-owned
session directory. The key is derived from `(runId, nodeId)`, not a transient
dispatch ID. It writes the association before starting the first model turn.
The digest binds native home, workspace, model, reasoning effort and dynamic-tool
schema. Subsequent dispatches resume that native thread. A changed binding or
failed native resume is an error; the adapter does not replace the transcript.
Manager marks later dispatches as requiring the existing native association; a
missing mapping on those attempts is also an error. An ambiguous first dispatch
may therefore require explicit recovery rather than automatically starting over.
The existing Manager run ID and creation-request digest remain responsible for
submission idempotency.

A file lease prevents concurrent writes to one native transcript. Normal
completion and cancellation wait for the owned app-server to exit before
releasing the lease. Worker/Node shutdown gives cancellation time to finish, then
terminates remaining owned processes. After a hard crash, a stale lease fails
closed: verify the recorded process has exited before explicitly removing only
that lease file. Never remove the mapping or native home as a recovery shortcut.
The automatic path does not guess ownership or risk two concurrent recoverers.

HomeRail handoff data remains provisional until the native turn acknowledges
successful completion. Tool-call replies are delivered before the consumer sees
the tool result. Failed/interrupted turns, transport loss and cancellation reject
the buffered handoff. Cancellation that arrives before turn acknowledgement is
sent as soon as the native turn ID is available; an unresponsive app-server is
terminated after the bounded grace period.

The durable native transcript can be resumed by Codex. Desktop task-list
visibility and actual voice playback are separate properties; this adapter does
not assert either. The isolated smoke in `scripts/native-codex-subscription-smoke.mjs`
verifies real Manager/Node/Worker execution, a same-thread second round,
submission idempotency and cancellation. Unit/transport tests separately cover
authentication rejection, model/policy substitution, terminal failures, lease
conflicts, API isolation and premature iterator cleanup.

The configuration follows the official [permission-profile documentation](https://learn.chatgpt.com/docs/permissions)
and [app-server lifecycle](https://learn.chatgpt.com/docs/app-server). Compatibility
must be checked against the actual installed binary; generated schemas alone do
not prove that legacy request fields remain accepted.

Correction turns retain the original native thread and its fixed DAG tool
declarations. The session binding includes the full declared tool schema; changing
that schema, model, account directory, or workspace still fails closed. A
correction may narrow the executable DAG tool handlers to handoff: calls to tools
outside that turn's allowlist are rejected even if the native thread remembers
their declarations. This restriction concerns HomeRail dynamic tools; the native
built-in tools remain governed by the explicit read-only sandbox policy.
