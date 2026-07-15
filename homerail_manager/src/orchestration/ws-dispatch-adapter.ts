import type {
  DAGDispatcher,
  DispatchEnvelope,
  DispatchResult,
} from "./dag-dispatcher.js";
import { randomUUID } from "node:crypto";
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
  deprovisionWorkerContainer,
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
import {
  deprovisionProvisionedWorker,
  registerProvisionedWorker,
  type ProvisionedWorkerEntry,
} from "./provisioned-cleanup.js";
import {
  acquireDagActorLease,
  getDagActorLease,
  listDagProvisionedWorkers,
  releaseDagActorLease,
  type DagActorLeaseRecord,
} from "../persistence/dag-actor-leases.js";
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
      if (hotWorker && this._hasCurrentProvisionedOwnership(envelope, hotWorker.worker_id)) return hotWorker;
    }

    const runScopedPrefix = `provisioned-${sanitizeProvisionedWorkerToken(envelope.runId)}-`;
    const exactRunScopedWorkerId = sanitizeProvisionedWorkerToken(
      `provisioned-${envelope.runId}-${envelope.nodeId}`,
    );
    const exactRunScopedWorker = workers.find((w) => w.worker_id === exactRunScopedWorkerId);
    if (
      exactRunScopedWorker
      && this._hasCurrentProvisionedOwnership(envelope, exactRunScopedWorker.worker_id)
    ) return exactRunScopedWorker;

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

  private _hasCurrentProvisionedOwnership(
    envelope: DispatchEnvelope,
    workerId: string,
  ): boolean {
    if (!workerId.startsWith("provisioned-")) return true;
    const actorId = envelope.activity?.actorId;
    if (!actorId) return false;
    const lease = getDagActorLease({ run_id: envelope.runId, actor_id: actorId });
    if (
      !lease
      || lease.state !== "leased"
      || (lease.target_type !== "worker" && lease.target_type !== "provisioned_worker")
      || lease.target_id !== workerId
    ) return false;
    return listDagProvisionedWorkers({
      run_id: envelope.runId,
      actor_id: actorId,
      lease_generation: lease.lease_generation,
      statuses: ["active"],
      limit: 1,
    }).some((worker) => worker.worker_id === workerId);
  }

  private _dispatchToNode(
    envelope: DispatchEnvelope,
    nodeId: string,
    socket: WebSocket,
  ): void {
    const bound = this._bindEnvelopeToTarget(envelope, "node", nodeId);
    try {
      socket.send(JSON.stringify({ type: "prompt", envelope: bound.envelope }));
    } catch (error) {
      this._releaseFailedDispatchLease(bound.lease);
      throw error;
    }
    this._recordPostSend(bound.envelope, "node", nodeId);
  }

  private _dispatchToWorker(
    envelope: DispatchEnvelope,
    workerId: string,
    socket: WebSocket,
    preboundLease?: DagActorLeaseRecord,
  ): DispatchEnvelope {
    const bound = preboundLease
      ? { envelope, lease: preboundLease }
      : this._bindEnvelopeToTarget(envelope, "worker", workerId);
    if (
      preboundLease
      && envelope.activity?.leaseGeneration !== preboundLease.lease_generation
    ) {
      throw new Error(`DAG dispatch ${envelope.runId}/${envelope.nodeId} has a mismatched prebound lease`);
    }
    if (!this._hasCurrentProvisionedOwnership(bound.envelope, workerId)) {
      this._releaseFailedDispatchLease(bound.lease);
      throw new Error(
        `Provisioned worker ${workerId} is not durably active for DAG actor ${bound.envelope.activity?.actorId ?? "unknown"}`,
      );
    }
    try {
      socket.send(JSON.stringify({ type: "prompt", envelope: bound.envelope }));
    } catch (error) {
      this._releaseFailedDispatchLease(bound.lease);
      throw error;
    }
    this._recordPostSend(bound.envelope, "worker", workerId);
    return bound.envelope;
  }

  private _recordPostSend(
    envelope: DispatchEnvelope,
    targetType: "worker" | "node",
    targetId: string,
  ): void {
    try {
      emit("dag:ws_dispatched", {
        runId: envelope.runId,
        nodeId: envelope.nodeId,
        targetType,
        targetId,
      });
    } catch (error) {
      this._warnPostSendFailure(envelope, "event emission", error);
    }
    try {
      appendChatEntry(envelope.runId, envelope.nodeId, {
        role: "manager",
        type: "prompt",
        targetId,
        content: redactDispatchEnvelope(envelope),
        timestamp: Date.now(),
      });
    } catch (error) {
      this._warnPostSendFailure(envelope, "chat persistence", error);
    }
    mirrorDispatchPrompt(envelope, targetType, targetId);
    try {
      recordDispatch(envelope.runId, envelope.nodeId, targetType, targetId);
    } catch (error) {
      this._warnPostSendFailure(envelope, "dispatch tracking", error);
    }
  }

  private _warnPostSendFailure(envelope: DispatchEnvelope, operation: string, error: unknown): void {
    console.warn(
      `[homerail_manager] DAG prompt was sent but ${operation} failed for ${envelope.runId}/${envelope.nodeId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private _bindEnvelopeToTarget(
    envelope: DispatchEnvelope,
    targetType: "worker" | "node",
    targetId: string,
  ): { envelope: DispatchEnvelope; lease: DagActorLeaseRecord } {
    if (!envelope.activity) {
      throw new Error(`DAG dispatch ${envelope.runId}/${envelope.nodeId} is missing actor activity identity`);
    }
    const lease = acquireDagActorLease({
      run_id: envelope.runId,
      actor_id: envelope.activity.actorId,
      target_type: targetType,
      target_id: targetId,
    });
    const boundEnvelope: DispatchEnvelope = {
      ...envelope,
      activity: {
        ...envelope.activity,
        leaseGeneration: lease.lease_generation,
      },
    };
    emit("dag:actor_lease_acquired", {
      runId: envelope.runId,
      nodeId: envelope.nodeId,
      actorId: envelope.activity.actorId,
      leaseGeneration: lease.lease_generation,
      targetType,
      targetId,
      idleDeadline: lease.idle_deadline,
    });
    return { envelope: boundEnvelope, lease };
  }

  private _releaseFailedDispatchLease(lease: DagActorLeaseRecord): void {
    if (lease.state !== "leased") return;
    try {
      const released = releaseDagActorLease({
        run_id: lease.run_id,
        actor_id: lease.actor_id,
        lease_generation: lease.lease_generation,
        target_type: lease.target_type!,
        target_id: lease.target_id!,
        expected_version: lease.version,
      });
      emit("dag:actor_lease_released", {
        runId: lease.run_id,
        actorId: lease.actor_id,
        leaseGeneration: lease.lease_generation,
        reason: "dispatch_send_failed",
        retainedUntil: released.retained_until,
      });
    } catch (error) {
      console.warn(
        `[homerail_manager] failed to release DAG actor lease after dispatch send failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    const workerId = sanitizeProvisionedWorkerToken(
      `provisioned-${envelope.runId}-${envelope.nodeId}-${randomUUID()}`,
    );
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
    const currentEnvelope = buildCurrentDispatchEnvelope(envelope.runId, envelope.nodeId);
    if (!currentEnvelope.ok) {
      recordDispatchFailed(envelope.runId, envelope.nodeId);
      this._cleanupUnregisteredProvisionedContainer(envelope, workerId, containerId, dockerNodeId);
      this._failProvisioning(envelope, currentEnvelope.reason);
      return;
    }
    let leasedEnvelope: DispatchEnvelope;
    let lease: DagActorLeaseRecord | undefined;
    let provisionedEntry: ProvisionedWorkerEntry | undefined;
    try {
      const bound = this._bindEnvelopeToTarget(currentEnvelope.envelope, "worker", workerId);
      leasedEnvelope = bound.envelope;
      lease = bound.lease;
      provisionedEntry = registerProvisionedWorker({
        runId: envelope.runId,
        nodeId: envelope.nodeId,
        actorId: bound.envelope.activity!.actorId,
        leaseGeneration: bound.lease.lease_generation,
        workerId,
        containerId,
        dockerNodeId,
      });
    } catch (error) {
      recordDispatchFailed(envelope.runId, envelope.nodeId);
      if (lease) this._releaseFailedDispatchLease(lease);
      this._cleanupUnregisteredProvisionedContainer(envelope, workerId, containerId, dockerNodeId);
      this._failProvisioning(envelope, error instanceof Error ? error.message : String(error));
      return;
    }
    emit("dag:provisioning_completed", {
      runId: envelope.runId,
      nodeId: envelope.nodeId,
      workerId,
      containerId,
    });

    // Find the newly registered worker and dispatch
    const workers = getAllWorkers();
    const newWorker = workers.find(
      (w) => w.worker_id === workerId && w.socket.readyState === WebSocket.OPEN,
    );
    if (newWorker) {
      if (!hasCapabilities(newWorker.capabilities, leasedEnvelope.requiredCapabilities)) {
        clearDispatchTarget(leasedEnvelope.runId, leasedEnvelope.nodeId);
        if (provisionedEntry) void deprovisionProvisionedWorker(provisionedEntry);
        if (lease) this._releaseFailedDispatchLease(lease);
        this._deferOfflineDispatch(
          leasedEnvelope,
          `provisioned worker ${workerId} does not satisfy required capabilities: ${requiredCapabilitiesText(leasedEnvelope.requiredCapabilities)}`,
        );
        return;
      }
      if (!recordProvisionedNodeDispatchAttempt(
        leasedEnvelope.runId,
        leasedEnvelope.nodeId,
      )) {
        if (provisionedEntry) void deprovisionProvisionedWorker(provisionedEntry);
        if (lease) this._releaseFailedDispatchLease(lease);
        return;
      }
      try {
        this._dispatchToWorker(leasedEnvelope, workerId, newWorker.socket, lease);
      } catch (error) {
        if (provisionedEntry) void deprovisionProvisionedWorker(provisionedEntry);
        this._failProvisioning(leasedEnvelope, error instanceof Error ? error.message : String(error));
        return;
      }
      if (!markNodeDispatched(leasedEnvelope.runId, leasedEnvelope.nodeId)) {
        recordDispatchFailed(leasedEnvelope.runId, leasedEnvelope.nodeId);
        this._failProvisioning(leasedEnvelope, `node ${leasedEnvelope.nodeId} was not READY after worker provisioning`);
        return;
      }
    } else {
      // Worker registered but socket not ready — mark failed
      recordDispatchFailed(envelope.runId, envelope.nodeId);
      if (provisionedEntry) void deprovisionProvisionedWorker(provisionedEntry);
      if (lease) this._releaseFailedDispatchLease(lease);
      this._failProvisioning(envelope, `worker ${workerId} registered but socket not open`);
    }
  }

  private _cleanupUnregisteredProvisionedContainer(
    envelope: DispatchEnvelope,
    workerId: string,
    containerId: string,
    dockerNodeId: string,
  ): void {
    emit("dag:cleanup_requested", { runId: envelope.runId, workerCount: 1 });
    void deprovisionWorkerContainer(dockerNodeId, containerId, this.provisionerOpts)
      .then((result) => {
        emit("dag:cleanup_completed", {
          runId: envelope.runId,
          workerId,
          nodeId: envelope.nodeId,
          containerId,
          stopped: result.stopped,
          removed: result.removed,
        });
      })
      .catch((error) => {
        emit("dag:cleanup_failed", {
          runId: envelope.runId,
          workerId,
          nodeId: envelope.nodeId,
          containerId,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
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
