import * as fs from "node:fs";
import * as path from "node:path";
import { getHomerailHome } from "../config/env.js";
import { getAllNodes } from "../node/registry.js";
import { NATIVE_CODEX_SUBSCRIPTION_CAPABILITY } from "homerail-protocol";

export type WorkerImageStatus = "unknown" | "checking" | "building" | "ready" | "error" | "skipped";

export interface DagResourceStatus {
  worker_image: {
    status: WorkerImageStatus;
    image: string;
    reason?: string;
    reason_code?: string;
    message: string;
    started_at?: number;
    updated_at?: number;
    error?: string;
    compatibility?: "current" | "stale" | "incompatible" | "unknown";
  };
}

export function dagResourceStatusPath(): string {
  return path.join(getHomerailHome(), "runtime", "dag-resources.json");
}

export function defaultDagResourceStatus(): DagResourceStatus {
  return {
    worker_image: {
      status: "unknown",
      image: process.env.HOMERAIL_WORKER_IMAGE || "homerail-worker:latest",
      message: "DAG worker image status has not been checked yet.",
    },
  };
}

export function readDagResourceStatus(): DagResourceStatus {
  try {
    const parsed = JSON.parse(fs.readFileSync(dagResourceStatusPath(), "utf-8")) as Partial<DagResourceStatus>;
    const worker = parsed.worker_image;
    if (!worker || typeof worker !== "object") return defaultDagResourceStatus();
    const status = worker.status;
    if (
      status !== "unknown" &&
      status !== "checking" &&
      status !== "building" &&
      status !== "ready" &&
      status !== "error" &&
      status !== "skipped"
    ) {
      return defaultDagResourceStatus();
    }
    // Preserve Manager-owned revisioned environment fields for readiness
    // consumers while normalizing the legacy worker_image admission shape.
    return {
      ...parsed,
      worker_image: {
        status,
        image: typeof worker.image === "string" && worker.image ? worker.image : process.env.HOMERAIL_WORKER_IMAGE || "homerail-worker:latest",
        reason: typeof worker.reason === "string" ? worker.reason : undefined,
        reason_code: typeof worker.reason_code === "string" ? worker.reason_code : undefined,
        message: typeof worker.message === "string" && worker.message ? worker.message : defaultDagResourceStatus().worker_image.message,
        started_at: typeof worker.started_at === "number" ? worker.started_at : undefined,
        updated_at: typeof worker.updated_at === "number" ? worker.updated_at : undefined,
        error: typeof worker.error === "string" ? worker.error : undefined,
        compatibility:
          worker.compatibility === "current"
          || worker.compatibility === "stale"
          || worker.compatibility === "incompatible"
          || worker.compatibility === "unknown"
            ? worker.compatibility
            : undefined,
      },
    };
  } catch {
    return defaultDagResourceStatus();
  }
}

export function dagResourcesUnavailableForRun(status = readDagResourceStatus()): { code: string; message: string; status: DagResourceStatus } | null {
  const worker = status.worker_image;
  if (worker.status === "unknown") {
    return {
      code: "dag_resources_unavailable",
      message: "尚未确认 DAG 资源是否就绪，暂时不可启动。请等待 Manager 完成环境检查后重试。",
      status,
    };
  }
  if (worker.status === "building" || worker.status === "checking") {
    return {
      code: "dag_resources_preparing",
      message: "DAG 资源正在准备，暂时不可启动。请等待 worker 镜像构建完成后重试。",
      status,
    };
  }
  if (
    worker.status === "error"
    || worker.reason === "stale"
    || worker.reason_code === "worker_image_stale"
    || worker.compatibility === "stale"
  ) {
    return {
      code: "dag_resources_unavailable",
      message: worker.error || worker.message || "DAG 资源暂时不可用：worker 镜像构建失败。",
      status,
    };
  }
  return null;
}

/** Native-only DAGs require the explicitly opted-in Node, not a Docker image. */
export function nativeSubscriptionResourcesUnavailableForRun(
  projectId = process.env.HOMERAIL_PROJECT_ID ?? "p1",
): { code: string; message: string } | null {
  const ready = getAllNodes().some((node) => node.socket.readyState === 1 && node.project_id === projectId
    && node.capabilities.includes(NATIVE_CODEX_SUBSCRIPTION_CAPABILITY));
  return ready ? null : {
    code: "native_subscription_node_unavailable",
    message: "No opted-in native-codex-subscription Node is connected. No API or Docker fallback is permitted.",
  };
}
