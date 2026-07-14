/**
 * dag-watch command — Poll DAG status with bounded timeout
 */

import type { HomeRailClient } from "../client.js";
import {
  buildDagSnapshot,
  renderSnapshot,
  renderSnapshotJson,
  normalizedPollIntervalSecs,
} from "../dag.js";

export async function cmdDagWatch(
  client: HomeRailClient,
  runId: string,
  events: number,
  interval: number,
  timeoutSecs: number,
  json: boolean,
): Promise<number> {
  const deadline = Date.now() + Math.max(timeoutSecs, 1) * 1000;

  for (;;) {
    if (Date.now() >= deadline) {
      if (json) {
        console.log(JSON.stringify({ status: "timeout", run_id: runId }));
      } else {
        console.log(`Watch timeout reached for ${runId}.`);
      }
      return 0;
    }

    const snap = await buildDagSnapshot(
      client,
      runId,
      Math.max(events, 1),
    );

    if (json) {
      console.log(renderSnapshotJson(snap));
    } else {
      console.log(renderSnapshot(snap));
    }

    // Terminal status
    if (["completed", "failed", "cancelled"].includes(snap.run_status)) {
      if (!json) {
        console.log(`Run reached terminal status: ${snap.run_status}`);
      }
      return snap.run_status === "failed" ? 1 : 0;
    }

    if (snap.waiting_for_command) {
      if (!json) {
        const round = snap.current_round_id ? ` (${snap.current_round_id})` : "";
        console.log(`Run is waiting for a command${round}.`);
      }
      return 0;
    }

    // Sleep
    const sleepMs = normalizedPollIntervalSecs(interval) * 1000;
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}
