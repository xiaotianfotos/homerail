import { readFileSync } from "node:fs";
import { PROTOCOL_VERSION } from "homerail-protocol";

export interface WorkerRuntimeIdentity {
  worker_version: string;
  protocol_version: string;
  source_fingerprint?: string;
  image_revision?: string;
}

export function readWorkerRuntimeVersion(
  moduleUrl: string | URL = import.meta.url,
): string {
  const packageJsonUrl = new URL("../package.json", moduleUrl);
  const metadata = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
    version?: unknown;
  };
  if (typeof metadata.version !== "string" || metadata.version.trim() === "") {
    throw new Error(`HomeRail Worker package metadata has no valid version: ${packageJsonUrl.href}`);
  }
  return metadata.version.trim();
}

export const WORKER_RUNTIME_VERSION = readWorkerRuntimeVersion();

export function resolveWorkerRuntimeIdentity(
  env: NodeJS.ProcessEnv = process.env,
): WorkerRuntimeIdentity {
  return {
    worker_version: env.HOMERAIL_WORKER_VERSION?.trim() || WORKER_RUNTIME_VERSION,
    protocol_version: env.HOMERAIL_WORKER_PROTOCOL_VERSION?.trim() || PROTOCOL_VERSION,
    source_fingerprint: env.HOMERAIL_WORKER_SOURCE_FINGERPRINT?.trim() || undefined,
    image_revision: env.HOMERAIL_WORKER_IMAGE_REVISION?.trim() || undefined,
  };
}
