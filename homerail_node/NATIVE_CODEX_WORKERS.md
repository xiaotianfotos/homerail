# Native Codex subscription Workers

This optional Node service provisions the existing HomeRail Worker entry point
as a local child process. Tasks still use the Worker WebSocket protocol for ACK,
progress, cancellation, handoffs and results. Ordinary Worker provisioning keeps
using its configured Docker provider.

The Node operator must explicitly configure these local environment variables:

| Variable | Meaning |
| --- | --- |
| `HOMERAIL_CODEX_SUBSCRIPTION_ENABLED` | Must be `1`; otherwise the service is unavailable. |
| `HOMERAIL_CODEX_SUBSCRIPTION_HOME` | Absolute path to the existing authenticated Codex home directory. |
| `HOMERAIL_CODEX_SUBSCRIPTION_BIN` | Absolute path to the installed executable Codex binary. |
| `HOMERAIL_CODEX_SUBSCRIPTION_WORKER_ENTRY` | Absolute path to the built `homerail_worker/dist/index.js`. |
| `HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR` | Optional absolute directory for persistent native session mappings; defaults to `$HOMERAIL_HOME/node/runtime/native_codex_subscription/sessions`. |

Only a Node with a successfully configured service advertises the
`native-codex-subscription` capability. Setting the capability alone fails closed.
The current implementation requires POSIX process groups; Windows activation is
rejected explicitly.
The session and audit directories must be owned by the Node's user, private
(mode `0700`), and free of symlink components. Keep the session directory outside
both the readable run workspace and the native account home.

The Manager selects this path using `spec.execution_mode =
native_codex_subscription`. Creation requires a safe run `workspace_id`,
`workspace_read_only: true`, and `workspace_access.writable_paths: []`. Workspaces
are derived from the existing HomeRail run workspace layout. Remote source paths,
commands, images, custom working directories and arbitrary environment variables
are rejected. The optional workspace configuration accepts only `isolated` or
`shared` mode; existing validated workspace input projections are supported.

The remote environment allowlist contains the Worker ID, its Manager callback
URL, its Worker control-plane token, and the fixed `codex_appserver` backend.
The callback must match the Node's configured Manager URL, project and Worker ID.
API keys, Manager admin credentials and Node execution options are not inherited
from the Node environment. Native account access uses the locally configured home
without copying credentials. The Worker must independently enforce the explicit
subscription protocol, account authentication, model selection, read-only Codex
sandbox and tool policy. A host Worker is not a Docker container; its restriction
depends on those Worker/Codex checks as well as this provisioning boundary.

The existing lifecycle `container_id` field carries an opaque
`native-codex-worker-…` ID. Only create, start, stop, remove and inspect are
supported; arbitrary exec and log retrieval are rejected. Stop/remove first asks
the Worker to finish its cancellation/lease cleanup, allowing up to 10 seconds,
then terminates any remaining processes in its owned group. Node
shutdown also closes its native Workers. Account home, session mappings, audit
files and run workspaces are retained, so Worker cleanup cannot erase native
history. Node process records are deliberately instance-local; after a Node
restart the Manager must provision a new Worker rather than adopting an
unverified PID. Session continuity belongs to the persistent Worker mapping and
Codex history, not to those process records.

No local installation setting or production service is changed by adding this
code. Deployment requires rebuilding the packages, configuring the opt-in paths,
and arranging any required service restart separately.

## Isolated real smoke

`scripts/native-codex-subscription-smoke.mjs` defaults to a non-executing help
message. After building the current Protocol, Plugin SDK, Manager, Node and Worker
packages, explicitly run:

```sh
node scripts/native-codex-subscription-smoke.mjs --execute \
  --codex-home /absolute/path/to/existing/.codex \
  --codex-bin /absolute/path/to/codex \
  --model EXACT_ACCOUNT_MODEL \
  --reasoning-effort EXACT_SUPPORTED_EFFORT \
  --output-dir /absolute/path/to/smoke-evidence
```

The script creates a fresh temporary `HOMERAIL_HOME`, binds its own Manager to an
available loopback port, and starts a separate Node and actual native Workers.
The Node's ordinary provider is `mock` specifically to ensure no Docker Worker
can satisfy this run; native task execution still uses the real Worker entry and
Codex app-server. No profiles, API settings, credentials, existing HomeRail
database or service configuration are imported.

It checks a real read-only fixture handoff, resumes the same logical actor in a
second round, and requires `thread_resumed` with the original native thread ID
across separate app-server launches. It completes that waiting run through the
public API, re-submits the identical runId/request, and verifies unchanged
`creationRequestDigest` and handoff count. A separate real turn is cancelled after
native turn acknowledgment, and the script waits for all session locks to be
released. The original fixture must remain unchanged.

All services started by the script are stopped on completion, failure, SIGINT or
SIGTERM. The temporary HomeRail directory is retained as a recovery point. The
evidence JSON contains selected statuses, IDs, hashes and native lifecycle events;
it excludes subprocess output and credentials. Actual native account history
remains in the supplied existing Codex home. This is an execution harness, not
proof of success until its result contains `passed: true`; a failed check is
recorded with its stage and the script exits unsuccessfully.

## One validated goal, one native execution

Add `--goal-file /absolute/path/to/validated-goal.txt` to the command above to
select one-shot execution. The caller must first validate the main integration's
restricted Flash route contract and preserve the original user goal in this
UTF-8 file. The script reads only this explicitly supplied goal file; it does not
invoke Flash or inspect router credentials. It accepts a regular, non-symlink
file with nonempty valid UTF-8 text, at most 20,000 characters and 80,000 bytes.
The goal is passed verbatim as the run prompt, preserving whitespace, newlines
and a UTF-8 BOM. Invalid input is rejected before service startup.

The workflow is fixed to a native read-only agent followed by a real success
terminal. No fixture, continuation round, deduplication replay or cancellation
probe is submitted in this mode. Exact model, reasoning effort, Codex paths and
other execution options remain local caller choices. Flash output is task data:
it must never supply arbitrary workflow nodes, runtime fields, commands, paths,
model profiles, credentials or alternative executors.

For a checked-in main integration, import the entry point directly:

```js
import { executeNativeGoal } from "./scripts/native-codex-subscription-smoke.mjs";

const result = await executeNativeGoal({
  goalFile: "/absolute/private/validated-goal.txt",
  codexHome: "/absolute/path/to/existing/.codex",
  codexBin: "/absolute/path/to/codex",
  model: "EXACT_ACCOUNT_MODEL",
  effort: "EXACT_SUPPORTED_EFFORT",
  outputDir: "/absolute/private/results",
  timeoutMs: 180000,
});
```

Each call creates a fresh isolated HomeRail home and returns an object containing
`run_id`, `terminal_status`, `terminal`, `passed`, `handoffs`, `result_path`, and
native session evidence when available. The complete Manager handoff records are
included without rewriting their contents; the result file is atomically written
with mode `0600`. Standard output prints only status and result/recovery paths,
never the goal or full handoff. Treat the result file and retained isolated home
as private because the goal and returned content may be sensitive. Success
requires `passed: true`, `terminal_status: completed`, and an actual nonempty
Worker result handoff. Failures preserve available terminal/handoff evidence and
set a nonzero process exit code. A truthful handoff can report a goal's limitation;
the completed transport alone does not establish that the user's goal succeeded.

The main integration associates its router request ID with the returned run ID
externally. This entry adds no router state, run deduplication engine, API model
setting, profile or paid fallback. Concurrent use of the imported entry point in
one process is not supported; use separate caller processes for parallel isolated
runs.

Lightweight contract checks (no services or models started) run with:

```sh
node --test scripts/native-codex-subscription-smoke.test.mjs
```

These checks require the current Manager package to have been built.
