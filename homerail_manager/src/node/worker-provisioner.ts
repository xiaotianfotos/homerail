/**
 * Reusable worker container provisioning module.
 *
 * Extracts the create → start → wait-registration / stop → remove sequence
 * from so normal dispatch and future slices can reuse it.
 */

import {
  sendWorkerCreateRequest,
  sendWorkerStartRequest,
  sendWorkerStopRequest,
  sendWorkerRemoveRequest,
  type LifecycleResult,
} from "./lifecycle-request.js";

/* -------------------------------------------------------------------------- */
/*  Public interfaces                                                         */
/* -------------------------------------------------------------------------- */

export interface ProvisionerOptions {
  image?: string;
  workspace?: Record<string, unknown>;
  workspaceReadOnly?: boolean;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  extraHosts?: string[];
  createTimeoutMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  removeTimeoutMs?: number;
  registrationTimeoutMs?: number;
  cleanupOnProvisionFailure?: boolean;
  /** Injectable deps for testing */
  createFn?: (
    nodeId: string,
    workspaceId: string,
    opts: {
      image?: string;
      workspace?: Record<string, unknown>;
      workspaceReadOnly?: boolean;
      env?: Record<string, string>;
      labels?: Record<string, string>;
      extraHosts?: string[];
      timeoutMs?: number;
    },
  ) => Promise<LifecycleResult>;
  startFn?: (
    nodeId: string,
    containerId: string,
    opts?: { timeoutMs?: number },
  ) => Promise<LifecycleResult>;
  stopFn?: (
    nodeId: string,
    containerId: string,
    opts?: { timeoutMs?: number },
  ) => Promise<LifecycleResult>;
  removeFn?: (
    nodeId: string,
    containerId: string,
    opts?: { timeoutMs?: number },
  ) => Promise<LifecycleResult>;
  runtimeStatusFn?: (baseUrl: string) => Promise<Record<string, unknown>>;
}

export interface ProvisionResult {
  containerId: string;
  registered: boolean;
}

export interface DeprovisionResult {
  stopped: boolean;
  removed: boolean;
  dockerCleanupVerified: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

async function defaultRuntimeStatusFn(baseUrl: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/runtime/status`);
  if (!res.ok) throw new Error(`runtime/status returned ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Core API                                                                  */
/* -------------------------------------------------------------------------- */

export async function waitForWorkerRegistration(
  managerBaseUrl: string,
  workerId: string,
  timeoutMs = 30_000,
  runtimeStatusFn?: (baseUrl: string) => Promise<Record<string, unknown>>,
): Promise<boolean> {
  const fetchStatus = runtimeStatusFn ?? defaultRuntimeStatusFn;
  return pollUntil(async () => {
    try {
      const status = await fetchStatus(managerBaseUrl);
      const ids = status.worker_ids;
      return Array.isArray(ids) && ids.includes(workerId);
    } catch {
      return false;
    }
  }, timeoutMs);
}

export async function provisionWorkerContainer(
  nodeId: string,
  workspaceId: string,
  workerId: string,
  managerBaseUrl: string,
  options?: ProvisionerOptions,
): Promise<ProvisionResult> {
  const createFn = options?.createFn ?? sendWorkerCreateRequest;
  const startFn = options?.startFn ?? sendWorkerStartRequest;
  const runtimeStatusFn = options?.runtimeStatusFn ?? defaultRuntimeStatusFn;

  const createResult = await createFn(nodeId, workspaceId, {
    image: options?.image,
    workspace: options?.workspace,
    workspaceReadOnly: options?.workspaceReadOnly,
    env: options?.env,
    labels: options?.labels,
    extraHosts: options?.extraHosts,
    timeoutMs: options?.createTimeoutMs,
  });

  if (createResult.status !== "success") {
    throw new Error(`Worker container create failed: ${JSON.stringify(createResult.error)}`);
  }

  const containerId = (createResult.resource_data?.id as string) ?? "";
  if (!containerId) {
    throw new Error("Worker container create did not return container id");
  }

  try {
    const startResult = await startFn(nodeId, containerId, {
      timeoutMs: options?.startTimeoutMs,
    });

    if (startResult.status !== "success") {
      throw new Error(`Worker container start failed: ${JSON.stringify(startResult.error)}`);
    }

    const registered = await waitForWorkerRegistration(
      managerBaseUrl,
      workerId,
      options?.registrationTimeoutMs ?? 30_000,
      runtimeStatusFn,
    );

    if (!registered) {
      throw new Error(`Worker ${workerId} failed to register within timeout`);
    }
  } catch (err) {
    if (options?.cleanupOnProvisionFailure !== false) {
      await deprovisionWorkerContainer(nodeId, containerId, options);
    }
    throw err;
  }

  return { containerId, registered: true };
}

export async function deprovisionWorkerContainer(
  nodeId: string,
  containerId: string,
  options?: ProvisionerOptions & {
    verifyDockerCleanup?: boolean;
    labelKey?: string;
    labelValue?: string;
  },
): Promise<DeprovisionResult> {
  const stopFn = options?.stopFn ?? sendWorkerStopRequest;
  const removeFn = options?.removeFn ?? sendWorkerRemoveRequest;

  let stopped = false;
  try {
    const stopResult = await stopFn(nodeId, containerId, {
      timeoutMs: options?.stopTimeoutMs,
    });
    stopped = stopResult.status === "success";
  } catch {
    // stop failure — still attempt remove
  }

  let removed = false;
  try {
    const removeResult = await removeFn(nodeId, containerId, {
      timeoutMs: options?.removeTimeoutMs,
    });
    removed = removeResult.status === "success";
  } catch {
    // remove failure
  }

  let dockerCleanupVerified = false;
  if (options?.verifyDockerCleanup && options.labelKey && options.labelValue) {
    try {
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync("docker", [
        "ps", "-a", "--filter", `label=${options.labelKey}=${options.labelValue}`, "-q",
      ], { encoding: "utf-8", timeout: 10_000, windowsHide: true });
      dockerCleanupVerified = (result.stdout ?? "").trim() === "";
    } catch {
      dockerCleanupVerified = false;
    }
  }

  return { stopped, removed, dockerCleanupVerified };
}
