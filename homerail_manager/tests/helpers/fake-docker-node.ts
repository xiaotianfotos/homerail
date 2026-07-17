import { registerNode, type NodeState } from "../../src/node/registry.js";
import { resolveLifecycleResponse } from "../../src/node/lifecycle-request.js";

export function registerFakeDockerNode(
  options: { existingContainer?: Record<string, unknown> } = {},
): {
  node: NodeState;
  close: () => Promise<void>;
  requests: Array<{ resource_type: string; operation: string; spec: Record<string, unknown> }>;
} {
  let createdContainer: Record<string, unknown> | null = options.existingContainer ?? null;
  const requests: Array<{ resource_type: string; operation: string; spec: Record<string, unknown> }> = [];
  const node = {
    node_id: `fake-docker-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    project_id: "test-dag",
    socket: {
      readyState: 1,
      send(raw: string) {
        const msg = JSON.parse(raw) as {
          request_id: string;
          resource_type: string;
          operation: string;
          spec?: Record<string, unknown>;
        };
        const spec = msg.spec ?? {};
        requests.push({ resource_type: msg.resource_type, operation: msg.operation, spec });
        setImmediate(() => {
          if (msg.resource_type !== "container") {
            resolveLifecycleResponse(node, msg.request_id, "error", undefined, { message: "unsupported resource" });
            return;
          }
          if (msg.operation === "list") {
            resolveLifecycleResponse(node, msg.request_id, "success", {
              containers: createdContainer ? [createdContainer] : [],
            });
            return;
          }
          if (msg.operation === "create") {
            createdContainer = {
              id: "fake-docker-container-test",
              name: spec.name,
              status: "created",
              labels: spec.labels,
            };
            resolveLifecycleResponse(node, msg.request_id, "success", { id: createdContainer.id });
            return;
          }
          if (msg.operation === "inspect") {
            if (createdContainer && (!spec.container_id || spec.container_id === createdContainer.id)) {
              resolveLifecycleResponse(node, msg.request_id, "success", createdContainer);
            } else {
              resolveLifecycleResponse(node, msg.request_id, "error", undefined, { message: "not found" });
            }
            return;
          }
          if (msg.operation === "start") {
            if (createdContainer) createdContainer.status = "running";
            resolveLifecycleResponse(node, msg.request_id, "success", {});
            return;
          }
          if (msg.operation === "stop" || msg.operation === "remove") {
            if (msg.operation === "remove") createdContainer = null;
            resolveLifecycleResponse(node, msg.request_id, "success", {});
            return;
          }
          resolveLifecycleResponse(node, msg.request_id, "error", undefined, { message: "unsupported operation" });
        });
      },
    },
    status: "idle",
    capabilities: ["docker-cli"],
    registered_at: Date.now(),
    last_heartbeat: Date.now(),
    pending_requests: new Map(),
  } as unknown as NodeState;
  registerNode(node);
  return {
    node,
    requests,
    close: async () => undefined,
  };
}
