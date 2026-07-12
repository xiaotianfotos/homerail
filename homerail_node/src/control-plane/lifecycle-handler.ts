import type { ExecutionProvider, ContainerConfig } from "../providers/types.js";
import { createContainer, createWorkerContainer } from "../lifecycle/create.js";
import { prepareWorkerWorkspace } from "../storage/workspace-prepare.js";
import type { MountPolicyOptions } from "../storage/mount-policy.js";

export interface LifecycleRequest {
  type: "lifecycle_request";
  request_id: string;
  resource_type: string;
  operation: string;
  spec: Record<string, unknown>;
}

export interface LifecycleResponse {
  type: "lifecycle_response";
  request_id: string;
  status: string;
  resource_data?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export type SendFn = (msg: LifecycleResponse) => void;

const SUPPORTED_RESOURCE_TYPES = new Set(["container", "worker"]);

export async function handleLifecycleRequest(
  request: LifecycleRequest,
  provider: ExecutionProvider,
  send: SendFn,
): Promise<void> {
  const { request_id, resource_type, operation, spec } = request;

  if (!SUPPORTED_RESOURCE_TYPES.has(resource_type)) {
    send({
      type: "lifecycle_response",
      request_id,
      status: "error",
      error: { message: `unsupported resource_type: ${resource_type}` },
    });
    return;
  }

  try {
    const result = await dispatchOperation(provider, resource_type, operation, spec);
    send({
      type: "lifecycle_response",
      request_id,
      status: "success",
      resource_data: result,
    });
  } catch (err) {
    send({
      type: "lifecycle_response",
      request_id,
      status: "error",
      error: { message: err instanceof Error ? err.message : String(err) },
    });
  }
}

async function dispatchOperation(
  provider: ExecutionProvider,
  resource_type: string,
  operation: string,
  spec: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  switch (operation) {
    case "create": {
      if (resource_type === "worker") {
        const workspaceId = spec.workspace_id as string;
        if (!workspaceId) throw new Error("spec.workspace_id is required for worker create");
        const config: ContainerConfig = {
          image: (spec.image as string) || "homerail-worker:latest",
          env: (spec.env as Record<string, string>) || undefined,
          labels: {
            ...(spec.labels as Record<string, string> || {}),
            "homerail.resource_type": "worker",
          },
          extraHosts: Array.isArray(spec.extra_hosts)
            ? spec.extra_hosts.filter(
                (value): value is string => typeof value === "string" && value.length > 0,
              )
            : undefined,
          workdir: (spec.workdir as string) || "/workspace",
          name: (spec.name as string) || undefined,
        };
        await prepareWorkerWorkspace(workspaceId, spec.workspace);
        const info = await createWorkerContainer({
          config,
          provider,
          workspaceId,
          workspaceReadOnly: spec.workspace_read_only === true,
        });
        return info as unknown as Record<string, unknown>;
      }
      const config = spec as unknown as ContainerConfig;
      if (typeof config.image !== "string" || !config.image.trim()) {
        throw new Error("spec.image is required for container create");
      }
      const info = await createContainer({ config, provider, mountPolicy: mountPolicyFromSpec(spec) });
      return info as unknown as Record<string, unknown>;
    }
    case "start": {
      const id = spec.container_id as string;
      if (!id) throw new Error("spec.container_id is required for start");
      await provider.start(id);
      return undefined;
    }
    case "stop": {
      const id = spec.container_id as string;
      if (!id) throw new Error("spec.container_id is required for stop");
      await provider.stop(id);
      return undefined;
    }
    case "remove": {
      const id = spec.container_id as string;
      if (!id) throw new Error("spec.container_id is required for remove");
      await provider.remove(id);
      return undefined;
    }
    case "inspect": {
      const id = spec.container_id as string;
      if (!id) throw new Error("spec.container_id is required for inspect");
      const info = await provider.inspect(id);
      return info as unknown as Record<string, unknown>;
    }
    case "logs": {
      const id = spec.container_id as string;
      if (!id) throw new Error("spec.container_id is required for logs");
      const lines: string[] = [];
      for await (const line of provider.logs(id)) {
        lines.push(line);
      }
      return { lines };
    }
    case "exec": {
      const id = spec.container_id as string;
      if (!id) throw new Error("spec.container_id is required for exec");
      const cmd = spec.cmd as string[] | undefined;
      if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((part) => typeof part !== "string")) {
        throw new Error("spec.cmd (string[]) is required for exec");
      }
      const result = await provider.exec(id, cmd);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    }
    case "list": {
      const infos = await provider.list();
      return { containers: infos as unknown as Record<string, unknown>[] };
    }
    default:
      throw new Error(`unsupported operation: ${operation}`);
  }
}

function mountPolicyFromSpec(spec: Record<string, unknown>): MountPolicyOptions | undefined {
  const raw = spec.mount_policy ?? spec.mountPolicy;
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const allowedHostRoots = Array.isArray(value.allowedHostRoots)
    ? value.allowedHostRoots.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : Array.isArray(value.allowed_host_roots)
      ? value.allowed_host_roots.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : undefined;
  return {
    allowDockerSocket: value.allowDockerSocket === true || value.allow_docker_socket === true,
    allowedHostRoots,
  };
}
