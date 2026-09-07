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

function safeWorkerWritableSubpath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("writableSubpath must be a non-empty relative workspace path");
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error("writableSubpath contains an unsafe path segment");
    }
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new Error("writableSubpath contains unsupported characters");
    }
  }
  return segments.join("/");
}

export function workerAllowedMounts(
  workspaceId: string,
  readOnly = false,
  readOnlyInputs = false,
  writableSubpath?: string,
  gitMetadataReadOnly = false,
): MountEntry[] {
  if (writableSubpath !== undefined && !readOnly) {
    throw new Error("writableSubpath requires a read-only workspace root");
  }
  if (gitMetadataReadOnly && writableSubpath === undefined) {
    throw new Error("read-only Git metadata requires writableSubpath");
  }
  const normalizedWritableSubpath = writableSubpath === undefined
    ? undefined
    : safeWorkerWritableSubpath(writableSubpath);
  if (
    normalizedWritableSubpath === "input"
    || normalizedWritableSubpath?.startsWith("input/")
    || normalizedWritableSubpath === ".homerail-runtime"
    || normalizedWritableSubpath?.startsWith(".homerail-runtime/")
  ) {
    throw new Error("writableSubpath conflicts with a protected workspace mount");
  }
  const mounts: MountEntry[] = [
    {
      host: homerailWorkerWorkspacePath(workspaceId),
      container: "/workspace",
      mode: readOnly ? "ro" : "rw",
    },
  ];
  if (readOnly) {
    mounts.push({
      host: `${homerailWorkerWorkspacePath(workspaceId)}/.homerail-runtime`,
      container: "/workspace/.homerail-runtime",
      mode: "rw",
    });
  }
  if (readOnlyInputs) {
    mounts.push({
      host: `${homerailWorkerWorkspacePath(workspaceId)}/input`,
      container: "/workspace/input",
      mode: "ro",
    });
  }
  if (normalizedWritableSubpath) {
    mounts.push({
      host: homerailWorkerWorkspacePath(`${workspaceId}/${normalizedWritableSubpath}`),
      container: `/workspace/${normalizedWritableSubpath}`,
      mode: "rw",
    });
    if (gitMetadataReadOnly) {
      mounts.push({
        host: `${homerailWorkerWorkspacePath(`${workspaceId}/${normalizedWritableSubpath}`)}/.git`,
        container: `/workspace/${normalizedWritableSubpath}/.git`,
        mode: "ro",
      });
    }
  }
  return mounts;
}
