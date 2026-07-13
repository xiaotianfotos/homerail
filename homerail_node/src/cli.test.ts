import { describe, it, expect } from "vitest";
import { WebSocketServer } from "ws";
import { parseArgs, resolveProvider } from "./cli.js";
import { createNodeClient } from "./control-plane/ws-client.js";
import { MockProvider } from "./providers/mock-provider.js";
import { DockerCliProvider } from "./providers/docker-cli-provider.js";
import { DockerApiProvider } from "./providers/docker-api-provider.js";

async function listenWebSocket(server: WebSocketServer): Promise<number> {
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("websocket server did not bind");
  return addr.port;
}

async function closeWebSocket(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met before timeout");
}

// --- resolveProvider ---

describe("resolveProvider", () => {
  it("returns MockProvider for 'mock'", () => {
    expect(resolveProvider("mock")).toBeInstanceOf(MockProvider);
  });

  it("returns DockerCliProvider for 'docker-cli'", () => {
    expect(resolveProvider("docker-cli")).toBeInstanceOf(DockerCliProvider);
  });

  it("returns DockerApiProvider for 'docker-api'", () => {
    expect(resolveProvider("docker-api")).toBeInstanceOf(DockerApiProvider);
  });

  it("throws on unknown provider", () => {
    expect(() => resolveProvider("unknown")).toThrow("Unknown provider: unknown");
  });
});

// --- parseArgs ---

describe("cli arg parsing logic", () => {
  it("uses defaults when no args and no env", () => {
    const args = parseArgs([], {});
    expect(args.managerUrl).toBe("ws://localhost:19191");
    expect(args.projectId).toBe("");
    expect(args.nodeId).toBe("");
    expect(args.provider).toBe("docker-cli");
    expect(args.capabilities).toEqual(["docker-cli", "workspace-artifacts"]);
    expect(args.token).toBe("");
    expect(args.allowInsecureRemoteWs).toBe(false);
  });

  it("derives default manager URL from HOMERAIL_MANAGER_PORT", () => {
    const args = parseArgs([], { HOMERAIL_MANAGER_PORT: "19222" });
    expect(args.managerUrl).toBe("ws://localhost:19222");
  });

  it("parses all flags", () => {
    const args = parseArgs(
      [
        "--manager-url", "ws://host:1234",
        "--project-id", "proj1",
        "--node-id", "node1",
        "--provider", "mock",
        "--capability", "a,b,c",
      ],
      {},
    );
    expect(args.managerUrl).toBe("ws://host:1234");
    expect(args.projectId).toBe("proj1");
    expect(args.nodeId).toBe("node1");
    expect(args.provider).toBe("mock");
    expect(args.capabilities).toEqual(["a", "b", "c", "workspace-artifacts"]);
  });

  it("accumulates multiple --capability flags", () => {
    const args = parseArgs(["--capability", "x", "--capability", "y,z"], {});
    expect(args.capabilities).toEqual(["x", "y", "z", "docker-cli", "workspace-artifacts"]);
  });

  it("falls back to env vars", () => {
    const args = parseArgs([], {
      HOMERAIL_MANAGER_WS_URL: "ws://env-host:5555",
      HOMERAIL_PROJECT_ID: "env-proj",
      HOMERAIL_NODE_ID: "env-node",
      HOMERAIL_NODE_PROVIDER: "docker-api",
      HOMERAIL_NODE_CAPABILITIES: "cap1,cap2",
      HOMERAIL_NODE_TOKEN: " node-token ",
      HOMERAIL_ALLOW_INSECURE_REMOTE_WS: "1",
    });
    expect(args.managerUrl).toBe("ws://env-host:5555");
    expect(args.projectId).toBe("env-proj");
    expect(args.nodeId).toBe("env-node");
    expect(args.provider).toBe("docker-api");
    expect(args.capabilities).toEqual(["cap1", "cap2", "docker-api", "workspace-artifacts"]);
    expect(args.token).toBe("node-token");
    expect(args.allowInsecureRemoteWs).toBe(true);
  });

  it("args override env vars", () => {
    const args = parseArgs(
      ["--project-id", "cli-proj", "--provider", "mock"],
      { HOMERAIL_PROJECT_ID: "env-proj", HOMERAIL_NODE_PROVIDER: "docker-api" },
    );
    expect(args.projectId).toBe("cli-proj");
    expect(args.provider).toBe("mock");
  });

  it("deduplicates provider capability when explicitly provided", () => {
    const args = parseArgs(["--capability", "docker-cli,custom"], {});
    expect(args.capabilities).toEqual(["docker-cli", "custom", "workspace-artifacts"]);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--unknown", "value", "--project-id", "p1"], {})).toThrow(
      "Unknown option: --unknown",
    );
  });

  it("rejects missing flag values", () => {
    expect(() => parseArgs(["--project-id"], {})).toThrow("Missing value for --project-id");
    expect(() => parseArgs(["--project-id", "--node-id"], {})).toThrow(
      "Missing value for --project-id",
    );
  });
});

describe("node control-plane WebSocket client", () => {
  it("reconnects and re-registers capabilities after the manager socket closes", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const port = await listenWebSocket(server);
    const messages: unknown[] = [];
    const authorizationHeaders: Array<string | undefined> = [];
    server.on("connection", (socket, request) => {
      authorizationHeaders.push(request.headers.authorization);
      socket.on("message", (raw) => {
        messages.push(JSON.parse(raw.toString()));
      });
    });

    const client = createNodeClient({
      managerUrl: `ws://127.0.0.1:${port}`,
      projectId: "p1",
      nodeId: "local-docker-node",
      provider: new MockProvider(),
      capabilities: ["docker-cli"],
      token: " node-secret ",
      reconnectInitialDelayMs: 50,
      reconnectMaxDelayMs: 50,
    });

    try {
      await client.connect();
      await waitFor(() => messages.length >= 2);
      for (const socket of server.clients) socket.close();
      await waitFor(() => messages.length >= 4, 2_000);

      expect(messages.filter((msg) => (msg as { type?: string }).type === "register")).toHaveLength(2);
      expect(messages.filter((msg) => (msg as { type?: string }).type === "capabilities")).toHaveLength(2);
      expect(authorizationHeaders).toEqual(["Bearer node-secret", "Bearer node-secret"]);
    } finally {
      client.close();
      await closeWebSocket(server);
    }
  });
});
