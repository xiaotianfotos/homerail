import type { ExecutionProvider, ContainerConfig, ContainerInfo } from "../providers/types.js";
import { lstatSync } from "node:fs";
import { validateMounts, allowedMounts, workerAllowedMounts } from "../storage/mount-policy.js";
import type { MountPolicyOptions } from "../storage/mount-policy.js";

export interface CreateOptions {
  config: ContainerConfig;
  provider: ExecutionProvider;
  volumeId?: string;
  mountPolicy?: MountPolicyOptions;
}

export async function createContainer(opts: CreateOptions): Promise<ContainerInfo> {
  const { config, provider, volumeId, mountPolicy } = opts;

  const mounts = [...(config.mounts ?? [])];

  if (volumeId) {
    const defaultMounts = allowedMounts(volumeId);
    for (const dm of defaultMounts) {
      if (!mounts.some((m) => m.container === dm.container)) {
        mounts.push({ host: dm.host, container: dm.container, mode: dm.mode });
      }
    }
  }

  if (mounts.length > 0) {
    validateMounts(
      mounts.map((m) => ({ host: m.host, container: m.container, mode: m.mode })),
      mountPolicy,
    );
  }

  const mergedConfig: ContainerConfig = {
    ...config,
    mounts: mounts.length > 0 ? mounts : undefined,
  };

  return provider.create(mergedConfig);
}

export interface CreateWorkerOptions {
  config: ContainerConfig;
  provider: ExecutionProvider;
  workspaceId: string;
  workspaceReadOnly?: boolean;
  workspaceWritableSubpath?: string;
  workspaceGitMetadataReadOnly?: boolean;
  workspaceInputsReadOnly?: boolean;
  mountPolicy?: MountPolicyOptions;
}

const DEFAULT_WORKER_IMAGE = "homerail-worker:latest";

export async function createWorkerContainer(opts: CreateWorkerOptions): Promise<ContainerInfo> {
  const {
    config,
    provider,
    workspaceId,
    workspaceReadOnly = false,
    workspaceWritableSubpath,
    workspaceGitMetadataReadOnly = false,
    workspaceInputsReadOnly = false,
    mountPolicy,
  } = opts;

  const image = config.image || DEFAULT_WORKER_IMAGE;

  if ((config.mounts ?? []).length > 0) {
    throw new Error("worker containers do not accept caller-supplied mounts; use workspaceId");
  }

  const mounts: NonNullable<ContainerConfig["mounts"]> = [];

  const defaultMounts = workerAllowedMounts(
    workspaceId,
    workspaceReadOnly,
    workspaceInputsReadOnly,
    workspaceWritableSubpath,
    workspaceGitMetadataReadOnly,
  );
  if (workspaceGitMetadataReadOnly) {
    const metadataMount = defaultMounts.find((mount) => mount.container.endsWith("/.git"));
    if (!metadataMount) throw new Error("read-only Git metadata requires a writable workspace subtree");
    const metadata = lstatSync(metadataMount.host);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
      throw new Error("workspace Git metadata must be a regular file or directory");
    }
  }
  for (const dm of defaultMounts) {
    if (!mounts.some((m) => m.container === dm.container)) {
      mounts.push({ host: dm.host, container: dm.container, mode: dm.mode });
    }
  }

  if (mounts.length > 0) {
    validateMounts(
      mounts.map((m) => ({ host: m.host, container: m.container, mode: m.mode })),
      mountPolicy,
    );
  }

  const mergedConfig: ContainerConfig = {
    ...config,
    image,
    mounts: mounts.length > 0 ? mounts : undefined,
    workdir: config.workdir ?? "/workspace",
  };

  return provider.create(mergedConfig);
}
