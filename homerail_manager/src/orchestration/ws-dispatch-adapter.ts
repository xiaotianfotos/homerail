import type {
  DAGDispatcher,
  DispatchEnvelope,
  DispatchResult,
} from "./dag-dispatcher.js";
import { getAllWorkers } from "../worker/registry.js";
import { getAllNodes, isDockerCapableNode } from "../node/registry.js";
import { emit } from "../events/bus.js";
import { appendChatEntry } from "../persistence/store.js";
import { appendSessionTranscriptEntry } from "../persistence/dag-session-files.js";
import {
  findDispatchTarget,
  clearDispatchTarget,
  recordDispatch,
  recordProvisioning,
  recordDispatchFailed,
  isProvisioning,
} from "./dispatch-tracker.js";
import {
  provisionWorkerContainer,
  type ProvisionerOptions,
} from "../node/worker-provisioner.js";
import {
  buildCurrentDispatchEnvelope,
  dispatchReadyNodes,
  failActiveRun,
  getActiveRun,
  markNodeDispatched,
  recordProvisionedNodeDispatchAttempt,
  recordNodeDispatchRetry,
} from "../runtime/active-runs.js";
import { getPort } from "../config/env.js";
import { registerProvisionedWorker } from "./provisioned-cleanup.js";
import { normalizeManagerAgentRuntimeAgentType, redactTelemetry } from "homerail-protocol";
import WebSocket from "ws";

const OFFLINE_RETRY_MIN_MS = 1_000;
const OFFLINE_RETRY_MAX_MS = 30_000;

interface DeferredOfflineDispatch {
  runId: string;
  nodeId: string;
  targetSignature: string;
  forceRetry?: boolean;
}

export interface WsDispatchAdapterOptions {
  provisioner?: ProvisionerOptions | false;
  managerBaseUrl?: string | (() => string);
  managerWorkerWsBaseUrl?: string | (() => string);
  projectId?: string;
}

function redactDispatchEnvelope(envelope: DispatchEnvelope): unknown {
  return redactTelemetry(envelope);
}

function mirrorDispatchPrompt(envelope: DispatchEnvelope, targetType: "worker" | "node", targetId: string): void {
  if (!envelope.sessionId) return;
  try {
    appendSessionTranscriptEntry({
      type: "prompt",
      runId: envelope.runId,
      nodeId: envelope.nodeId,
      sessionId: envelope.sessionId,
      content: redactDispatchEnvelope(envelope),
      metadata: { targetType, targetId },
    });
  } catch {
    // SessionStore mirroring is best-effort; DB run state remains authoritative.
  }
}

function sanitizeProvisionedWorkerToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function hasCapabilities(actual: string[], required: string[] | undefined): boolean {
  if (!required || required.length === 0) return true;
  const actualSet = new Set(actual.map((capability) => capability.trim()).filter(Boolean));
  return required
    .map((capability) => capability.trim())
    .filter(Boolean)
    .every((capability) => actualSet.has(capability));
}

function requiredCapabilitiesText(required: string[] | undefined): string {
  return required && required.length > 0 ? required.join(",") : "none";
}

function requiresIsolatedWorkspace(envelope: DispatchEnvelope): boolean {
  return envelope.workspace?.mode === "isolated";
}

export function normalizeAgentBackend(agentType: string | undefined): string | undefined {
  return normalizeManagerAgentRuntimeAgentType(agentType);
}

/**
 * WebSocket dispatch adapter: bridges DAG dispatch envelopes to the
 * existing worker/node WebSocket control-plane.
 *
 * Provisioning path (): when no worker exists and a connected node
 * advertises Docker access, fire async worker provisioning in background.
 * DAGDispatcher.dispatch stays synchronous — provisioning_in_progress
 * is returned as a skipped result.
 */
export class WsDispatchAdapter implements DAGDispatcher {
  private static offlineRetryAdapters = new Set<WsDispatchAdapter>();
  private static offlineRetryTimer?: ReturnType<typeof setTimeout>;
  private static offlineRetryDelayMs = OFFLINE_RETRY_MIN_MS;

  private provisionerOpts?: ProvisionerOptions;
  private managerBaseUrl: string | (() => string);
  private managerWorkerWsBaseUrl?: string | (() => string);
  private projectId: string;
  private inflightProvisioning = new Set<string>();
  private nextWorkerIndex = 0;
  private deferredOfflineDispatches = new Map<string, DeferredOfflineDispatch>();

  constructor(options?: WsDispatchAdapterOptions) {
    this.provisionerOpts = options?.provisioner === false ? undefined : options?.provisioner;
    this.managerBaseUrl = options?.managerBaseUrl ?? (() => `http://127.0.0.1:${getPort()}`);
    this.managerWorkerWsBaseUrl = options?.managerWorkerWsBaseUrl;
    this.projectId = options?.projectId ?? "p1";
  }

  private getManagerBaseUrl(): string {
    return typeof this.managerBaseUrl === "function"
      ? this.managerBaseUrl()
      : this.managerBaseUrl;
  }

  private getManagerWorkerWsUrl(workerId: string): string {
    const base = this.managerWorkerWsBaseUrl
      ? (typeof this.managerWorkerWsBaseUrl === "function"
          ? this.managerWorkerWsBaseUrl()
          : this.managerWorkerWsBaseUrl)
      : this.getManagerBaseUrl().replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    return `${base.replace(/\/$/, "")}/ws/projects/${this.projectId}/workers/${workerId}`;
  }

  private _dispatchKey(runId: string, nodeId: string): string {
    return `${runId}\0${nodeId}`;
  }

  private _targetSignature(): string {
    const workers = getAllWorkers()
      .filter((worker) => worker.socket.readyState === WebSocket.OPEN)
      .map((worker) => `worker:${worker.worker_id}:${worker.registered_at}:${worker.capabilities.slice().sort().join(",")}`);
    const nodes = getAllNodes()
      .filter((node) => node.socket.readyState === WebSocket.OPEN)
      .map((node) => `node:${node.node_id}:${node.registered_at}:${node.capabilities.slice().sort().join(",")}`);
    return [...workers, ...nodes].sort().join("|");
  }

  private static _ensureOfflineRetryTimer(resetDelay = false): void {
    if (resetDelay) {
      WsDispatchAdapter.offlineRetryDelayMs = OFFLINE_RETRY_MIN_MS;
      if (WsDispatchAdapter.offlineRetryTimer) {
        clearTimeout(WsDispatchAdapter.offlineRetryTimer);
        WsDispatchAdapter.offlineRetryTimer = undefined;
      }
    }
    if (WsDispatchAdapter.offlineRetryTimer || WsDispatchAdapter.offlineRetryAdapters.size === 0) return;
    WsDispatchAdapter.offlineRetryTimer = setTimeout(() => {
      WsDispatchAdapter.offlineRetryTimer = undefined;
      let targetChanged = false;
      for (const adapter of Array.from(WsDispatchAdapter.offlineRetryAdapters)) {
        try {
          targetChanged = adapter._retryDeferredOfflineDispatches() || targetChanged;
        } catch (error) {
          console.error(
            `[homerail_manager] deferred DAG dispatch retry failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (adapter.deferredOfflineDispatches.size === 0) {
          WsDispatchAdapter.offlineRetryAdapters.delete(adapter);
        }
      }
      if (WsDispatchAdapter.offlineRetryAdapters.size === 0) {
        WsDispatchAdapter.offlineRetryDelayMs = OFFLINE_RETRY_MIN_MS;
        return;
      }
      WsDispatchAdapter.offlineRetryDelayMs = targetChanged
        ? OFFLINE_RETRY_MIN_MS
        : Math.min(OFFLINE_RETRY_MAX_MS, WsDispatchAdapter.offlineRetryDelayMs * 2);
      WsDispatchAdapter._ensureOfflineRetryTimer();
    }, WsDispatchAdapter.offlineRetryDelayMs);
    WsDispatchAdapter.offlineRetryTimer.unref?.();
  }

  private static _removeOfflineRetryAdapter(adapter: WsDispatchAdapter): void {
    WsDispatchAdapter.offlineRetryAdapters.delete(adapter);
    if (WsDispatchAdapter.offlineRetryAdapters.size > 0) return;
    if (WsDispatchAdapter.offlineRetryTimer) clearTimeout(WsDispatchAdapter.offlineRetryTimer);
    WsDispatchAdapter.offlineRetryTimer = undefined;
    WsDispatchAdapter.offlineRetryDelayMs = OFFLINE_RETRY_MIN_MS;
  }

  private _scheduleOfflineRetry(): void {
    if (this.deferredOfflineDispatches.size === 0) return;
    WsDispatchAdapter.offlineRetryAdapters.add(this);
    WsDispatchAdapter._ensureOfflineRetryTimer(true);
  }

  private _forgetDeferredOfflineDispatch(runId: string, nodeId: string): void {
    this.deferredOfflineDispatches.delete(this._dispatchKey(runId, nodeId));
    if (this.deferredOfflineDispatches.size === 0) {
      WsDispatchAdapter._removeOfflineRetryAdapter(this);
    }
  }

  private _retryDeferredOfflineDispatches(): boolean {
    const targetSignature = this._targetSignature();
    const pendingByRun = new Map<string, DeferredOfflineDispatch[]>();
    let targetChanged = false;
    for (const [key, pending] of this.deferredOfflineDispatches) {
      const run = getActiveRun(pending.runId);
      if (!run || run.status !== "active" || run.dagRun.nodeStates.get(pending.nodeId) !== "READY") {
        this.deferredOfflineDispatches.delete(key);
        continue;
      }
      if (!pending.forceRetry && pending.targetSignature === targetSignature) continue;
      targetChanged = true;
      this.deferredOfflineDispatches.delete(key);
      const entries = pendingByRun.get(pending.runId) ?? [];
      entries.push(pending);
      pendingByRun.set(pending.runId, entries);
    }
    for (const [runId, pendingEntries] of pendingByRun) {
      try {
        dispatchReadyNodes(runId, this);
      } catch (error) {
        console.error(
          `[homerail_manager] deferred DAG dispatch failed for ${runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        for (const pending of pendingEntries) {
          const run = getActiveRun(pending.runId);
          if (!run || run.status !== "active" || run.dagRun.nodeStates.get(pending.nodeId) !== "READY") continue;
          this.deferredOfflineDispatches.set(this._dispatchKey(pending.runId, pending.nodeId), {
            ...pending,
            targetSignature,
            forceRetry: true,
          });
        }
      }
    }
    return targetChanged;
  }

  private _deferOfflineDispatch(
    envelope: DispatchEnvelope,
    reason = "no available worker or node",
  ): DispatchResult {
    const key = this._dispatchKey(envelope.runId, envelope.nodeId);
    this.deferredOfflineDispatches.set(key, {
      runId: envelope.runId,
      nodeId: envelope.nodeId,
      targetSignature: this._targetSignature(),
    });
    this._scheduleOfflineRetry();
    return { status: "skipped", reason };
  }

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    this._forgetDeferredOfflineDispatch(envelope.runId, envelope.nodeId);
    const requiredCapabilities = envelope.requiredCapabilities
      ?.map((capability) => capability.trim())
      .filter((capability) => capability.length > 0);

    const provisionKey = `${envelope.runId}:${envelope.nodeId}`;
    if (isProvisioning(envelope.runId, envelope.nodeId) || this.inflightProvisioning.has(provisionKey)) {
      return { status: "skipped", reason: "provisioning_in_progress" };
    }

    const worker = this._selectOpenWorker(envelope);
    if (worker) {
      try {
        this._dispatchToWorker(envelope, worker.worker_id, worker.socket);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        emit("dag:ws_dispatch_failed", {
          runId: envelope.runId,
          nodeId: envelope.nodeId,
          reason,
        });
        recordDispatchFailed(envelope.runId, envelope.nodeId);
        return { status: "failed", reason, retryable: true };
      }
      return {
        status: "dispatched",
        targetType: "worker",
        targetId: worker.worker_id,
      };
    }

    const openWorkers = getAllWorkers().filter((candidate) => candidate.socket.readyState === WebSocket.OPEN);
    const openNodes = getAllNodes().filter((candidate) => candidate.socket.readyState === WebSocket.OPEN);
    // Try to find a Docker-capable node for provisioning.
    if (this.provisionerOpts) {
      const dockerNode = openNodes.find(
        (n) =>
          isDockerCapableNode(n),
      );
      if (dockerNode) {
        this._startProvisioning(envelope, dockerNode.node_id);
        return { status: "skipped", reason: "provisioning_in_progress" };
      }
    }

    if (requiredCapabilities && requiredCapabilities.length > 0) {
      return this._deferOfflineDispatch(
        envelope,
        `no available worker satisfies required capabilities: ${requiredCapabilitiesText(requiredCapabilities)}`,
      );
    }

    // Fallback: dispatch directly to any connected node when the task has no
    // worker capability contract.
    const node = openNodes[0];
    if (node) {
      try {
        this._dispatchToNode(envelope, node.node_id, node.socket);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        emit("dag:ws_dispatch_failed", {
          runId: envelope.runId,
          nodeId: envelope.nodeId,
          reason,
        });
        recordDispatchFailed(envelope.runId, envelope.nodeId);
        return { status: "failed", reason, retryable: true };
      }
      return {
        status: "dispatched",
        targetType: "node",
        targetId: node.node_id,
      };
    }

    return this._deferOfflineDispatch(envelope);
  }

  private _selectOpenWorker(
    envelope: DispatchEnvelope,
  ):
    | { worker_id: string; socket: WebSocket }
    | undefined {
    const workers = getAllWorkers().filter(
      (w) =>
        w.socket.readyState === WebSocket.OPEN &&
        hasCapabilities(w.capabilities, envelope.requiredCapabilities),
    );
    if (workers.length === 0) return undefined;

    const previousTarget = findDispatchTarget(envelope.runId, envelope.nodeId);
    if (previousTarget?.state === "dispatched" && previousTarget.targetType === "worker") {
      const hotWorker = workers.find((worker) => worker.worker_id === previousTarget.targetId);
      if (hotWorker) return hotWorker;
    }

    const runScopedPrefix = `provisioned-${sanitizeProvisionedWorkerToken(envelope.runId)}-`;
    const exactRunScopedWorkerId = sanitizeProvisionedWorkerToken(
      `provisioned-${envelope.runId}-${envelope.nodeId}`,
    );
    const exactRunScopedWorker = workers.find((w) => w.worker_id === exactRunScopedWorkerId);
    if (exactRunScopedWorker) return exactRunScopedWorker;

    if (requiresIsolatedWorkspace(envelope)) return undefined;

    const genericWorkers = workers.filter((w) =>
      !w.worker_id.startsWith("provisioned-") &&
      !w.worker_id.startsWith(runScopedPrefix)
    );
    if (genericWorkers.length === 0) return undefined;

    const worker = genericWorkers[this.nextWorkerIndex % genericWorkers.length];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % genericWorkers.length;
    return worker;
  }

  private _dispatchToNode(
    envelope: DispatchEnvelope,
    nodeId: string,
    socket: WebSocket,
  ): void {
    const message = JSON.stringify({ type: "prompt", envelope });
    socket.send(message);
    emit("dag:ws_dispatched", {
      runId: envelope.runId,
      nodeId: envelope.nodeId,
      targetType: "node",
      targetId: nodeId,
    });
    appendChatEntry(envelope.runId, envelope.nodeId, {
      role: "manager",
      type: "prompt",
      targetId: nodeId,
      content: redactDispatchEnvelope(envelope),
      timestamp: Date.now(),
    });
    mirrorDispatchPrompt(envelope, "node", nodeId);
    recordDispatch(envelope.runId, envelope.nodeId, "node", nodeId);
  }

  private _dispatchToWorker(
    envelope: DispatchEnvelope,
    workerId: string,
    socket: WebSocket,
  ): void {
    const message = JSON.stringify({ type: "prompt", envelope });
    socket.send(message);
    emit("dag:ws_dispatched", {
      runId: envelope.runId,
      nodeId: envelope.nodeId,
      targetType: "worker",
      targetId: workerId,
    });
    appendChatEntry(envelope.runId, envelope.nodeId, {
      role: "manager",
      type: "prompt",
      targetId: workerId,
      content: redactDispatchEnvelope(envelope),
      timestamp: Date.now(),
    });
    mirrorDispatchPrompt(envelope, "worker", workerId);
    recordDispatch(envelope.runId, envelope.nodeId, "worker", workerId);
  }

  private _startProvisioning(
    envelope: DispatchEnvelope,
    dockerNodeId: string,
  ): void {
    const provisionKey = `${envelope.runId}:${envelope.nodeId}`;
    this.inflightProvisioning.add(provisionKey);
    recordProvisioning(envelope.runId, envelope.nodeId);
    emit("dag:provisioning_requested", {
      runId: envelope.runId,
      nodeId: envelope.nodeId,
      nodeIdForProvision: dockerNodeId,
    });

    const workspaceId = envelope.runId;
    const workerId = sanitizeProvisionedWorkerToken(`provisioned-${envelope.runId}-${envelope.nodeId}`);
    const agentBackend = normalizeAgentBackend(envelope.agentConfig.agent_type);
    const provisionerOpts: ProvisionerOptions = {
      ...this.provisionerOpts,
      image: envelope.image ?? this.provisionerOpts?.image,
      workspace: this.provisionerOpts?.workspace ?? envelope.workspace,
      workspaceReadOnly: Array.isArray(envelope.workspaceAccess?.writable_paths) &&
        envelope.workspaceAccess.writable_paths.length === 0,
      env: {
        ...(this.provisionerOpts?.env ?? {}),
        ...(agentBackend ? { AGENT_BACKEND: agentBackend } : {}),
        MANAGER_WORKER_WS_URL: this.getManagerWorkerWsUrl(workerId),
        HOMERAIL_WORKER_ID: workerId,
      },
    };

    // Fire-and-forget async provisioning
    provisionWorkerContainer(
      dockerNodeId,
      workspaceId,
      workerId,
      this.getManagerBaseUrl(),
      provisionerOpts,
    )
      .then((result) => {
        this._onProvisioningSuccess(
          envelope,
          workerId,
          result.containerId,
          dockerNodeId,
        );
      })
      .catch((err: Error) => {
        this._onProvisioningFailure(
          envelope,
          dockerNodeId,
          err.message ?? String(err),
        );
      })
      .finally(() => {
        this.inflightProvisioning.delete(provisionKey);
      });
  }

  private _onProvisioningSuccess(
    envelope: DispatchEnvelope,
    workerId: string,
    containerId: string,
    dockerNodeId: string,
  ): void {
    registerProvisionedWorker({
      runId: envelope.runId,
      nodeId: envelope.nodeId,
      workerId,
      containerId,
      dockerNodeId,
    });
    emit("dag:provisioning_completed", {
      runId: envelope.runId,
      nodeId: envelope.nodeId,
      workerId,
      containerId,
    });

    const currentEnvelope = buildCurrentDispatchEnvelope(envelope.runId, envelope.nodeId);
    if (!currentEnvelope.ok) {
      recordDispatchFailed(envelope.runId, envelope.nodeId);
      this._failProvisioning(envelope, currentEnvelope.reason);
      return;
    }

    // Find the newly registered worker and dispatch
    const workers = getAllWorkers();
    const newWorker = workers.find(
      (w) => w.worker_id === workerId && w.socket.readyState === WebSocket.OPEN,
    );
    if (newWorker) {
      if (!hasCapabilities(newWorker.capabilities, currentEnvelope.envelope.requiredCapabilities)) {
        clearDispatchTarget(currentEnvelope.envelope.runId, currentEnvelope.envelope.nodeId);
        this._deferOfflineDispatch(
          currentEnvelope.envelope,
          `provisioned worker ${workerId} does not satisfy required capabilities: ${requiredCapabilitiesText(currentEnvelope.envelope.requiredCapabilities)}`,
        );
        return;
      }
      if (!recordProvisionedNodeDispatchAttempt(
        currentEnvelope.envelope.runId,
        currentEnvelope.envelope.nodeId,
      )) {
        return;
      }
      this._dispatchToWorker(currentEnvelope.envelope, workerId, newWorker.socket);
      if (!markNodeDispatched(currentEnvelope.envelope.runId, currentEnvelope.envelope.nodeId)) {
        recordDispatchFailed(currentEnvelope.envelope.runId, currentEnvelope.envelope.nodeId);
        this._failProvisioning(currentEnvelope.envelope, `node ${currentEnvelope.envelope.nodeId} was not READY after worker provisioning`);
        return;
      }
    } else {
      // Worker registered but socket not ready — mark failed
      recordDispatchFailed(envelope.runId, envelope.nodeId);
      this._failProvisioning(envelope, `worker ${workerId} registered but socket not open`);
    }
  }

  private _onProvisioningFailure(
    envelope: DispatchEnvelope,
    dockerNodeId: string,
    reason: string,
  ): void {
    if (recordNodeDispatchRetry(envelope.runId, envelope.nodeId, `Worker provisioning failed: ${reason}`)) {
      emit("dag:provisioning_failed", {
        runId: envelope.runId,
        nodeId: envelope.nodeId,
        reason,
      });
      this._startProvisioning(envelope, dockerNodeId);
      return;
    }
    recordDispatchFailed(envelope.runId, envelope.nodeId);
    this._failProvisioning(envelope, reason);
    // Container cleanup is handled by provisionWorkerContainer's own
    // cleanupOnProvisionFailure option (default true)
  }

  private _failProvisioning(
    envelope: DispatchEnvelope,
    reason: string,
  ): void {
    emit("dag:provisioning_failed", {
      runId: envelope.runId,
      nodeId: envelope.nodeId,
      reason,
    });
    failActiveRun(envelope.runId, envelope.nodeId, `Worker provisioning failed: ${reason}`);
  }
}
