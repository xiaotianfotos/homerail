import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HomeRailClient } from "../src/client.js";
import { configuredManagerPort } from "../src/local-config.js";

// Save and restore env
const origEnv = { ...process.env };
let tempHome: string;

beforeEach(() => {
  vi.restoreAllMocks();
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-client-test-"));
  process.env.HOMERAIL_HOME = tempHome;
  delete process.env.HOMERAIL_CONFIG_PATH;
  delete process.env.HOMERAIL_SECRETS_PATH;
  delete process.env.HOMERAIL_MANAGER_URL;
  delete process.env.HOMERAIL_MANAGER_PORT;
});

afterEach(() => {
  process.env = { ...origEnv };
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("local manager port resolution", () => {
  it("uses HOMERAIL_MANAGER_URL for the Manager process port", () => {
    process.env.HOMERAIL_MANAGER_URL = "http://127.0.0.1:34567";
    expect(configuredManagerPort()).toBe(34567);
  });

  it("lets HOMERAIL_MANAGER_PORT override the URL port", () => {
    process.env.HOMERAIL_MANAGER_URL = "http://127.0.0.1:34567";
    process.env.HOMERAIL_MANAGER_PORT = "45678";
    expect(configuredManagerPort()).toBe(45678);
  });
});

describe("HomeRailClient.resolveBaseUrl", () => {
  it("uses override when provided", () => {
    const url = HomeRailClient.resolveBaseUrl("http://custom:4000");
    expect(url).toBe("http://custom:4000");
  });

  it("strips trailing slash from override", () => {
    const url = HomeRailClient.resolveBaseUrl("http://custom:4000/");
    expect(url).toBe("http://custom:4000");
  });

  it("uses HOMERAIL_MANAGER_URL env when no override", () => {
    process.env.HOMERAIL_MANAGER_URL = "http://env-host:5555";
    const url = HomeRailClient.resolveBaseUrl();
    expect(url).toBe("http://env-host:5555");
  });

  it("strips trailing slash from env", () => {
    process.env.HOMERAIL_MANAGER_URL = "http://env-host:5555/";
    const url = HomeRailClient.resolveBaseUrl();
    expect(url).toBe("http://env-host:5555");
  });

  it("defaults to http://localhost:19191", () => {
    const url = HomeRailClient.resolveBaseUrl();
    expect(url).toBe("http://localhost:19191");
  });

  it("ignores empty override", () => {
    process.env.HOMERAIL_MANAGER_URL = "http://from-env:7777";
    const url = HomeRailClient.resolveBaseUrl("  ");
    expect(url).toBe("http://from-env:7777");
  });

  it("ignores empty env", () => {
    process.env.HOMERAIL_MANAGER_URL = "   ";
    const url = HomeRailClient.resolveBaseUrl();
    expect(url).toBe("http://localhost:19191");
  });
});

describe("HomeRailClient.get", () => {
  it("calls fetch with correct URL and method", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ success: true, message: "ok", data: { runs: [] } }),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse as unknown as Response,
    );

    const client = new HomeRailClient({ baseUrl: "http://test:1234", mutationToken: "mutation-secret" });
    const result = await client.get("/api/runs");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://test:1234/api/runs",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toEqual({ success: true, message: "ok", data: { runs: [] } });
  });
});

describe("HomeRailClient.post", () => {
  it("sends JSON body", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ success: true, message: "created", data: { id: "abc" } }),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse as unknown as Response,
    );

    const client = new HomeRailClient({ baseUrl: "http://test:1234", mutationToken: "mutation-secret" });
    const result = await client.post("/api/runs", { yamlPath: "test.yaml" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://test:1234/api/runs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Homerail-Dag-Token": "mutation-secret" }),
        body: JSON.stringify({ yamlPath: "test.yaml" }),
      }),
    );
    expect(result).toEqual({ success: true, message: "created", data: { id: "abc" } });
  });

  it("sends checkpoint resume requests to the DAG node endpoint", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ success: true, message: "resumed", data: { dispatched: 1 } }),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse as unknown as Response,
    );

    const client = new HomeRailClient({ baseUrl: "http://test:1234" });
    const result = await client.checkpointResume("run 1", "node/a", {
      instruction: "resume here",
      uuid: "entry-1",
      last: 1,
      sessionId: "session-next",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://test:1234/api/runs/run%201/node/node%2Fa/checkpoint-resume",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          instruction: "resume here",
          uuid: "entry-1",
          last: 1,
          session_id: "session-next",
        }),
      }),
    );
    expect(result).toEqual({ success: true, message: "resumed", data: { dispatched: 1 } });
  });
});

describe("HomeRailClient error handling", () => {
  it("throws on non-ok response with message from body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ success: false, message: "Run not found" }),
    } as unknown as Response);

    const client = new HomeRailClient();
    await expect(client.get("/api/runs/missing/status")).rejects.toThrow(
      "Run not found",
    );
  });

  it("throws on non-ok response with fallback message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("bad json");
      },
    } as unknown as Response);

    const client = new HomeRailClient();
    await expect(client.get("/api/broken")).rejects.toThrow("HTTP 500");
  });

  it("throws on timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      return new Promise((_resolve, reject) => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });

    const client = new HomeRailClient({ timeoutMs: 50 });
    await expect(client.get("/api/slow")).rejects.toThrow(
      "Request timed out after 50ms",
    );
  });
});
