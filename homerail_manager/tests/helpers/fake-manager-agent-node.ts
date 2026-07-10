import * as http from "node:http";
import { createHash } from "node:crypto";
import { registerNode, type NodeState } from "../../src/node/registry.js";
import { resolveLifecycleResponse } from "../../src/node/lifecycle-request.js";

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function findAvailableManagerAgentPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    await close(server);
    throw new Error("failed to allocate Manager Agent test port");
  }
  const port = address.port;
  await close(server);
  return port;
}

export function managerAgentHostPort(projectId?: string): number {
  const fixed = process.env.HOMERAIL_MANAGER_AGENT_PORT;
  if (fixed) return Number(fixed);
  const canonical = (projectId ?? "").trim().replace(/[^A-Za-z0-9_.-]/g, "-") || "__default__";
  const digest = createHash("sha256").update(canonical).digest("hex");
  return 39000 + (Number.parseInt(digest.slice(0, 8), 16) % 20000);
}

function startStubManagerAgent(port: number, onChat: (body: Record<string, unknown>) => Record<string, unknown>): http.Server {
  const stub = http.createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "running", service: "manager-agent" }));
      return;
    }
    if (req.method === "POST" && pathname === "/chat") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(onChat(body)));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  stub.listen(port, "127.0.0.1");
  return stub;
}

export function registerFakeDockerNode(
  projectId: string,
  onChat: (body: Record<string, unknown>) => Record<string, unknown>,
  options: { existingContainer?: Record<string, unknown> } = {},
): {
  node: NodeState;
  close: () => Promise<void>;
  requests: Array<{ resource_type: string; operation: string; spec: Record<string, unknown> }>;
} {
  let containerServer: http.Server | undefined;
  let createdContainer: Record<string, unknown> | null = options.existingContainer ?? null;
  const requests: Array<{ resource_type: string; operation: string; spec: Record<string, unknown> }> = [];
  const node = {
    node_id: `fake-docker-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    project_id: projectId,
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
              id: "manager-agent-container-test",
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
            containerServer = startStubManagerAgent(managerAgentHostPort(projectId), onChat);
            containerServer.once("listening", () => {
              resolveLifecycleResponse(node, msg.request_id, "success", {});
            });
            containerServer.once("error", (err) => {
              resolveLifecycleResponse(node, msg.request_id, "error", undefined, {
                message: err instanceof Error ? err.message : String(err),
              });
            });
            return;
          }
          if (msg.operation === "stop" || msg.operation === "remove") {
            if (containerServer?.listening) {
              containerServer.close(() => {
                if (msg.operation === "remove") createdContainer = null;
                resolveLifecycleResponse(node, msg.request_id, "success", {});
              });
            } else {
              if (msg.operation === "remove") createdContainer = null;
              resolveLifecycleResponse(node, msg.request_id, "success", {});
            }
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
    close: async () => {
      if (containerServer?.listening) await close(containerServer);
    },
  };
}
