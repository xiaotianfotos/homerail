import { randomUUID } from "node:crypto";
import { getNode, type NodeState } from "./registry.js";
import type { LifecycleRequestMessage } from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface LifecycleRequestOptions {
  timeoutMs?: number;
}

export interface LifecycleResult {
  status: string;
  resource_data?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export function sendLifecycleRequest(
  nodeId: string,
  resourceType: string,
  operation: string,
  spec: Record<string, unknown> = {},
  options: LifecycleRequestOptions = {},
): Promise<LifecycleResult> {
  const node = getNode(nodeId);
  if (!node) {
    return Promise.reject(new Error(`node ${nodeId} not found`));
  }

  if (node.socket.readyState !== 1 /* WebSocket.OPEN */) {
    return Promise.reject(new Error(`node ${nodeId} socket not open`));
  }

  const requestId = randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return new Promise<LifecycleResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      node.pending_requests.delete(requestId);
      reject(new Error(`lifecycle request ${requestId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    node.pending_requests.set(requestId, { request_id: requestId, resolve, reject, timer });

    const msg: LifecycleRequestMessage = {
      type: "lifecycle_request",
      request_id: requestId,
      resource_type: resourceType,
      operation,
      spec,
    };

    try {
      node.socket.send(JSON.stringify(msg));
    } catch (err) {
      clearTimeout(timer);
      node.pending_requests.delete(requestId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function resolveLifecycleResponse(
  node: NodeState,
  requestId: string,
  status: string,
  resourceData?: Record<string, unknown>,
  error?: Record<string, unknown>,
): boolean {
  const pending = node.pending_requests.get(requestId);
  if (!pending) return false;

  clearTimeout(pending.timer);
  node.pending_requests.delete(requestId);
  pending.resolve({ status, resource_data: resourceData, error });
  return true;
}

export function rejectAllPendingRequests(node: NodeState, reason: string): void {
  for (const [id, pending] of node.pending_requests) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  node.pending_requests.clear();
}

export interface WorkerCreateOptions {
  env?: Record<string, string>;
  labels?: Record<string, string>;
  image?: string;
  extraHosts?: string[];
  workspace?: Record<string, unknown>;
  workspaceReadOnly?: boolean;
  timeoutMs?: number;
}

export function sendWorkerCreateRequest(
  nodeId: string,
  workspaceId: string,
  options: WorkerCreateOptions = {},
): Promise<LifecycleResult> {
  return sendLifecycleRequest(
    nodeId,
    "worker",
    "create",
    {
      workspace_id: workspaceId,
      env: options.env,
      labels: options.labels,
      image: options.image,
      extra_hosts: options.extraHosts,
      workspace: options.workspace,
      workspace_read_only: options.workspaceReadOnly === true,
    },
    { timeoutMs: options.timeoutMs },
  );
}

export function sendWorkerStartRequest(
  nodeId: string,
  containerId: string,
  options: LifecycleRequestOptions = {},
): Promise<LifecycleResult> {
  return sendLifecycleRequest(nodeId, "worker", "start", { container_id: containerId }, options);
}

export function sendWorkerStopRequest(
  nodeId: string,
  containerId: string,
  options: LifecycleRequestOptions = {},
): Promise<LifecycleResult> {
  return sendLifecycleRequest(nodeId, "worker", "stop", { container_id: containerId }, options);
}

export function sendWorkerLogsRequest(
  nodeId: string,
  containerId: string,
  options: LifecycleRequestOptions = {},
): Promise<LifecycleResult> {
  return sendLifecycleRequest(nodeId, "worker", "logs", { container_id: containerId }, options);
}

export function sendWorkerRemoveRequest(
  nodeId: string,
  containerId: string,
  options: LifecycleRequestOptions = {},
): Promise<LifecycleResult> {
  return sendLifecycleRequest(nodeId, "worker", "remove", { container_id: containerId }, options);
}
