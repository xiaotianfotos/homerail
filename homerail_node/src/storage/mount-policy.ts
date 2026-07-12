import { resolveHomerailHome } from "../platform/paths.js";
import { homerailWorkerWorkspacePath } from "./homerail-home.js";

const DENIED_PATHS = ["/etc", "/proc", "/sys", "/dev"];

export interface MountPolicyOptions {
  allowDockerSocket?: boolean;
  allowedHostRoots?: string[];
}

export interface MountEntry {
  host: string;
  container: string;
  mode?: string;
}

export class MountPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MountPolicyError";
  }
}

export function validateMounts(
  mounts: MountEntry[],
  options: MountPolicyOptions = {},
): void {
  const homerailHome = resolveHomerailHome();
  const allowedHostRoots = (options.allowedHostRoots ?? [])
    .map((root) => root.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((root) => root && root !== "/" && !DENIED_PATHS.some((denied) => root === denied || root.startsWith(`${denied}/`)));

  for (const mount of mounts) {
    const host = mount.host.replace(/\\/g, "/");

    if (DENIED_PATHS.includes(host)) {
      throw new MountPolicyError(
        `Mount denied: "${host}" is a protected system directory`,
      );
    }

    if (host === "/var/run/docker.sock") {
      if (options.allowDockerSocket) {
        continue;
      }
      throw new MountPolicyError(
        `Mount denied: Docker socket mount requires allowDockerSocket: true`,
      );
    }

    const insideHomerailHome = host === homerailHome || host.startsWith(homerailHome + "/");
    const insideAllowedRoot = allowedHostRoots.some((root) => host === root || host.startsWith(root + "/"));
    if (!insideHomerailHome && !insideAllowedRoot) {
      throw new MountPolicyError(
        `Mount denied: "${mount.host}" is outside .homerail tree (${homerailHome})`,
      );
    }
  }
}

export function allowedMounts(volumeId: string): MountEntry[] {
  const homerailHome = resolveHomerailHome();
  return [
    {
      host: `${homerailHome}/node/volumes/${volumeId}`,
      container: "/workspace",
      mode: "rw",
    },
    {
      host: `${homerailHome}/home`,
      container: "/home/node",
      mode: "rw",
    },
  ];
}

export function workerAllowedMounts(workspaceId: string, readOnly = false): MountEntry[] {
  return [
    {
      host: homerailWorkerWorkspacePath(workspaceId),
      container: "/workspace",
      mode: readOnly ? "ro" : "rw",
    },
  ];
}
