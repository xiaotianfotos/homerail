import type { ChangeOrchestrator } from "../orchestration/change-orchestrator.js";
import { emit } from "../events/bus.js";
import { expireActiveRunApprovals } from "./active-runs.js";
import {
  claimTriggerDelivery,
  completeTriggerDelivery,
  deferIntervalTrigger,
  dueIntervalTriggers,
  eventTriggers,
  releaseTriggerDelivery,
  type DagTriggerRecord,
} from "../persistence/dag-triggers.js";

let orchestrator: ChangeOrchestrator | undefined;

function dispatch(record: DagTriggerRecord, fireKey: string, payload: unknown): { dispatched: boolean; runId?: string; reason?: string } {
  if (!orchestrator) return { dispatched: false, reason: "trigger dispatcher is not initialized" };
  const claim = claimTriggerDelivery(record, fireKey, payload);
  if (!claim.claimed) {
    if (record.config.type === "interval") deferIntervalTrigger(record);
    emit("dag:trigger_skipped", { triggerKey: record.trigger_key, workflowId: record.workflow_id, fireKey, reason: claim.reason });
    return { dispatched: false, reason: claim.reason };
  }
  try {
    const result = orchestrator.createAndRun({
      workflowId: record.workflow_id,
      prompt: JSON.stringify({ trigger_id: record.trigger_id, trigger_type: record.config.type, fire_key: fireKey, payload }),
    });
    completeTriggerDelivery(record, fireKey, result.runId);
    emit("dag:trigger_dispatched", { triggerKey: record.trigger_key, workflowId: record.workflow_id, fireKey, runId: result.runId });
    return { dispatched: true, runId: result.runId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    releaseTriggerDelivery(record, fireKey, reason);
    if (record.config.type === "interval") deferIntervalTrigger(record);
    emit("dag:trigger_failed", { triggerKey: record.trigger_key, workflowId: record.workflow_id, fireKey, reason });
    return { dispatched: false, reason };
  }
}

export function startDagTriggerScheduler(changeOrchestrator: ChangeOrchestrator, intervalMs = 1_000): () => void {
  orchestrator = changeOrchestrator;
  const tick = () => {
    expireActiveRunApprovals();
    for (const record of dueIntervalTriggers()) {
      const fireAt = record.next_fire_at ?? Date.now();
      dispatch(record, `interval:${fireAt}`, { scheduled_at: fireAt });
    }
  };
  const timer = setInterval(tick, Math.max(100, intervalMs));
  timer.unref();
  return () => {
    clearInterval(timer);
    if (orchestrator === changeOrchestrator) orchestrator = undefined;
  };
}

export function fireDagEventTrigger(eventName: string, idempotencyKey: string, payload: unknown): Array<{
  trigger_key: string;
  dispatched: boolean;
  run_id?: string;
  reason?: string;
}> {
  return eventTriggers(eventName).map((record) => {
    const result = dispatch(record, `event:${idempotencyKey}`, payload);
    return {
      trigger_key: record.trigger_key,
      dispatched: result.dispatched,
      ...(result.runId ? { run_id: result.runId } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    };
  });
}
