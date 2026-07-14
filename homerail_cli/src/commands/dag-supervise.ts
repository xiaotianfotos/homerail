/**
 * dag-supervise command — Tick mode and continuous supervision
 */

import type { HomeRailClient } from "../client.js";
import {
  superviseTickData,
  renderSuperviseTick,
  normalizedPollIntervalSecs,
} from "../dag.js";

/** Single cursor-based tick */
export async function cmdDagSuperviseTick(
  client: HomeRailClient,
  runId: string,
  cursor: string,
  events: number,
  tools: number,
  contentLimit: number,
  json: boolean,
): Promise<number> {
  const result = await superviseTickData(
    client,
    runId,
    cursor,
    events,
    tools,
    contentLimit,
  );

  if (json) {
    console.log(JSON.stringify(result.report));
  } else {
    console.log(renderSuperviseTick(runId, result));
  }
  return result.exit_code;
}

/** Continuous follow mode */
export async function cmdDagSuperviseContinuous(
  client: HomeRailClient,
  runId: string,
  interval: number,
  timeout: number,
  events: number,
  tools: number,
  contentLimit: number,
  reportEvery: number,
  json: boolean,
): Promise<number> {
  const deadline = Date.now() + Math.max(timeout, 1) * 1000;
  let cursor = "";
  let lastReport = Date.now();

  for (;;) {
    if (Date.now() >= deadline) {
      if (json) {
        console.log(JSON.stringify({ status: "timeout", run_id: runId }));
      } else {
        console.log(`Supervise timeout reached for ${runId}.`);
      }
      return 0;
    }

    const result = await superviseTickData(
      client,
      runId,
      cursor,
      events,
      tools,
      contentLimit,
    );

    if (result.terminal) {
      if (json) {
        console.log(JSON.stringify(result.report));
      } else {
        console.log(renderSuperviseTick(runId, result));
        console.log("Run reached terminal status.");
      }
      return result.exit_code;
    }

    if (result.waiting_for_command) {
      if (json) {
        console.log(JSON.stringify(result.report));
      } else {
        console.log(renderSuperviseTick(runId, result));
        console.log("Run is waiting for a command.");
      }
      return 0;
    }

    // Print if changed or heartbeat interval elapsed
    const elapsedSinceReport = (Date.now() - lastReport) / 1000;
    if (result.changed || elapsedSinceReport >= reportEvery) {
      if (json) {
        console.log(JSON.stringify(result.report));
      } else {
        console.log(renderSuperviseTick(runId, result));
      }
      lastReport = Date.now();
    }

    cursor = result.new_cursor;

    const sleepMs = normalizedPollIntervalSecs(interval) * 1000;
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}
