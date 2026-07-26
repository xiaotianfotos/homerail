import { readFileSync } from "node:fs";

export function readManagerRuntimeVersion(
  moduleUrl: string | URL = import.meta.url,
): string {
  const packageJsonUrl = new URL("../package.json", moduleUrl);
  const metadata = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
    version?: unknown;
  };
  if (typeof metadata.version !== "string" || metadata.version.trim() === "") {
    throw new Error(`HomeRail Manager package metadata has no valid version: ${packageJsonUrl.href}`);
  }
  return metadata.version.trim();
}

export const MANAGER_RUNTIME_VERSION = readManagerRuntimeVersion();
