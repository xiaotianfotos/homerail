import { createServer } from "./server/http.js";
import { getHost, getPort } from "./config/env.js";
import { initEventLogging } from "./persistence/store.js";
import { recoverAllActiveRuns, recoverDagActorInterventions } from "./runtime/active-runs.js";
import { recoverStaleVoiceSessions } from "./server/voice-session-registry.js";
import { markRecoveryComplete } from "./health/index.js";
import { cleanupPluginPackageStaging, recoverPluginPackageTrash } from "./plugins/package-lifecycle.js";
import { shutdownHostShellManagerAgents } from "./server/host-shell-manager-agent.js";
import {
  recoverDagActorSurfacePatches,
  recoverDagLiveSurfaceProjections,
} from "./generative-ui/dag-live-surface-projector.js";
import { getDagEnvironmentController } from "./server/dag-environment.js";
import { HOMERAIL_PLUGIN_SDK_ABI_VERSION } from "homerail-plugin-sdk";
import { recoverCredentialBrokerMutations } from "./runtime/credential-broker.js";

// Precondition: this check itself only runs when the Manager dist is current.
// A stale Manager dist would not contain this guard at all. The check targets
// the more common failure mode: Manager rebuilt but SDK dist left stale.
const EXPECTED_PLUGIN_SDK_ABI_VERSION = 1;
if (HOMERAIL_PLUGIN_SDK_ABI_VERSION !== EXPECTED_PLUGIN_SDK_ABI_VERSION) {
  console.error(
    `[homerail_manager] FATAL: homerail-plugin-sdk ABI version mismatch — ` +
    `Manager expects ${EXPECTED_PLUGIN_SDK_ABI_VERSION}, runtime SDK reports ${HOMERAIL_PLUGIN_SDK_ABI_VERSION}. ` +
    `Rebuild homerail_plugin_sdk (npm run build) and restart.`,
  );
  process.exit(1);
}

initEventLogging();

const port = getPort();
const host = getHost();
const server = createServer(port);
const dagEnvironment = getDagEnvironmentController();

// Cold recovery: replay persisted active runs into the in-memory store before
// the server accepts traffic. The first-worker hook (wired in createServer)
// re-dispatches their READY nodes once a worker reconnects.
// Resolve durable mutation attempts before restoring RUNNING gateways. This
// lets ActiveRun recovery consume a known completed result instead of
// replaying an external side effect.
const brokerRecovery = await recoverCredentialBrokerMutations();
const recovery = recoverAllActiveRuns();
// Intervention Inbox rows are replayed only after their logical runs and
// Actors exist again. Applying is transactionally idempotent.
const interventionRecovery = recoverDagActorInterventions();
// Logical actors are restored before Activity Journal replay. The projector
// can therefore re-establish exact ownership and drain any crash-pending gaps.
const surfaceRecovery = recoverDagLiveSurfaceProjections();
// Actor patch recovery follows host Activity recovery so the single projector
// can rebuild a stable node before draining independent body revisions.
const actorSurfaceRecovery = recoverDagActorSurfacePatches();
// Reset voice sessions stuck in running/submitted (no live process after restart).
const voiceRecovery = recoverStaleVoiceSessions();
const pluginTrashRecovery = recoverPluginPackageTrash();
const pluginStagingRecovered = cleanupPluginPackageStaging();
markRecoveryComplete();

server.listen(port, host, () => {
  // Probing starts only after the Manager is already accepting traffic. Docker
  // is a managed runtime dependency, never a Manager startup dependency.
  dagEnvironment.startMonitoring();
  console.error(`homerail_manager listening on ${host}:${port}`);
  console.error(
    `cold recovery: recovered=${recovery.recovered.length} failed=${recovery.failed.length} skipped=${recovery.skipped.length}`,
  );
  console.error(
    `credential broker recovery: reconciled=${brokerRecovery.reconciled.length} unresolved=${brokerRecovery.unresolved.length} failed=${brokerRecovery.failed.length}`,
  );
  for (const failure of recovery.failed) {
    console.error(
      `cold recovery failed: run=${failure.runId} reason="${failure.reason}" demoted_nodes=[${failure.demotedNodes.join(", ")}]`,
    );
  }
  console.error(
    `live surface recovery: projected=${surfaceRecovery.projected_events} failed=${surfaceRecovery.failed.length}`,
  );
  console.error(
    `actor surface recovery: applied=${actorSurfaceRecovery.applied_patches} stale=${actorSurfaceRecovery.stale_patches} failed=${actorSurfaceRecovery.failed.length}`,
  );
  if (interventionRecovery.applied.length || interventionRecovery.failed.length || interventionRecovery.skipped.length) {
    console.error(
      `actor intervention recovery: applied=${interventionRecovery.applied.length} failed=${interventionRecovery.failed.length} skipped=${interventionRecovery.skipped.length}`,
    );
  }
  if (voiceRecovery.recovered.length) {
    console.error(`voice recovery: reset ${voiceRecovery.recovered.length} stale session(s)`);
  }
  if (pluginStagingRecovered) console.error(`plugin recovery: removed ${pluginStagingRecovered} orphan staging package(s)`);
  if (pluginTrashRecovery.restored || pluginTrashRecovery.removed || pluginTrashRecovery.quarantined) {
    console.error(`plugin recovery: restored=${pluginTrashRecovery.restored} removed=${pluginTrashRecovery.removed} quarantined=${pluginTrashRecovery.quarantined} uninstall package(s)`);
  }
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  dagEnvironment.shutdown();
  const forcedExit = setTimeout(() => process.exit(1), 5_000);
  forcedExit.unref();
  void shutdownHostShellManagerAgents().finally(() => {
    server.close(() => process.exit(0));
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
