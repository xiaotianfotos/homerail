import { createServer } from "./server/http.js";
import { getHost, getPort } from "./config/env.js";
import { initEventLogging } from "./persistence/store.js";
import { recoverAllActiveRuns, recoverDagActorInterventions } from "./runtime/active-runs.js";
import { recoverStaleVoiceSessions } from "./server/voice-session-registry.js";
import { markRecoveryComplete } from "./health/index.js";
import { cleanupPluginPackageStaging, recoverPluginPackageTrash } from "./plugins/package-lifecycle.js";
import { shutdownHostShellManagerAgents } from "./server/host-shell-manager-agent.js";
import { recoverDagLiveSurfaceProjections } from "./generative-ui/dag-live-surface-projector.js";

initEventLogging();

const port = getPort();
const host = getHost();
const server = createServer(port);

// Cold recovery: replay persisted active runs into the in-memory store before
// the server accepts traffic. The first-worker hook (wired in createServer)
// re-dispatches their READY nodes once a worker reconnects.
const recovery = recoverAllActiveRuns();
// Intervention Inbox rows are replayed only after their logical runs and
// Actors exist again. Applying is transactionally idempotent.
const interventionRecovery = recoverDagActorInterventions();
// Logical actors are restored before Activity Journal replay. The projector
// can therefore re-establish exact ownership and drain any crash-pending gaps.
const surfaceRecovery = recoverDagLiveSurfaceProjections();
// Reset voice sessions stuck in running/submitted (no live process after restart).
const voiceRecovery = recoverStaleVoiceSessions();
const pluginTrashRecovery = recoverPluginPackageTrash();
const pluginStagingRecovered = cleanupPluginPackageStaging();
markRecoveryComplete();

server.listen(port, host, () => {
  console.error(`homerail_manager listening on ${host}:${port}`);
  console.error(
    `cold recovery: recovered=${recovery.recovered.length} failed=${recovery.failed.length} skipped=${recovery.skipped.length}`,
  );
  console.error(
    `live surface recovery: projected=${surfaceRecovery.projected_events} failed=${surfaceRecovery.failed.length}`,
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
  const forcedExit = setTimeout(() => process.exit(1), 5_000);
  forcedExit.unref();
  void shutdownHostShellManagerAgents().finally(() => {
    server.close(() => process.exit(0));
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
