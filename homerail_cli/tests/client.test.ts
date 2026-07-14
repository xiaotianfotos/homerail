import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HomeRailClient } from "../src/client.js";
import {
  HOMERAIL_MANAGER_ADMIN_TOKEN,
  configuredManagerPort,
  getSecretsPath,
  saveLocalSecret,
} from "../src/local-config.js";

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
  delete process.env[HOMERAIL_MANAGER_ADMIN_TOKEN];
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

  it("sends plugin archives as exact binary bytes instead of JSON or base64", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ success: true, data: { plugin_id: "com.example.demo" } }),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse as unknown as Response,
    );
    const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);

    const client = new HomeRailClient({ baseUrl: "http://test:1234" });
    await client.postBinary("/api/plugins/install?channel=staging", archive);

    const [, init] = fetchSpy.mock.calls[0];
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "http://test:1234/api/plugins/install?channel=staging",
    );
    expect(init).toEqual(expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "Content-Type": "application/vnd.homerail.plugin+zip",
      }),
    }));
    expect(init?.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(init?.body as Uint8Array)).toEqual(archive);
    expect(typeof init?.body).not.toBe("string");
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

describe("HomeRailClient Manager admin token", () => {
  it("injects an environment token into every /api mutation and nowhere else", async () => {
    const token = "cli-env-admin-token-0123456789abcdef";
    process.env[HOMERAIL_MANAGER_ADMIN_TOKEN] = token;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as unknown as Response);
    const client = new HomeRailClient({ baseUrl: "http://test:1234" });

    await client.put("/api/plugins/com.example.demo/enabled", { enabled: true });
    await client.get("/api/plugins");
    await client.post("/api/runs", {});
    await client.patch("/api/future-route", {});
    await client.post("/health", {});

    expect(fetchSpy.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({
      Authorization: `Bearer ${token}`,
    }));
    expect(fetchSpy.mock.calls[1][1]?.headers).not.toEqual(expect.objectContaining({
      Authorization: expect.anything(),
    }));
    expect(fetchSpy.mock.calls[2][1]?.headers).toEqual(expect.objectContaining({
      Authorization: `Bearer ${token}`,
    }));
    expect(fetchSpy.mock.calls[3][1]?.headers).toEqual(expect.objectContaining({
      Authorization: `Bearer ${token}`,
    }));
    expect(fetchSpy.mock.calls[4][1]?.headers).not.toEqual(expect.objectContaining({
      Authorization: expect.anything(),
    }));
  });

  it("loads the token from the private local secrets file", async () => {
    const token = "cli-local-admin-token-0123456789abcdef";
    saveLocalSecret(HOMERAIL_MANAGER_ADMIN_TOKEN, token);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as unknown as Response);

    await new HomeRailClient({ baseUrl: "http://test:1234" })
      .delete("/api/not-yet-registered", {});

    expect(fetchSpy.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({
      Authorization: `Bearer ${token}`,
    }));
    if (process.platform !== "win32") {
      expect(fs.statSync(getSecretsPath()).mode & 0o077).toBe(0);
    }
  });

  it("keeps process environment precedence over the private secrets file", async () => {
    saveLocalSecret(HOMERAIL_MANAGER_ADMIN_TOKEN, "secret-admin-token-0123456789abcdef");
    const environmentToken = "environment-admin-token-0123456789abcdef";
    process.env[HOMERAIL_MANAGER_ADMIN_TOKEN] = environmentToken;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as unknown as Response);

    await new HomeRailClient({ baseUrl: "http://test:1234" }).post("/api/runs", {});
    expect(fetchSpy.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({
      Authorization: `Bearer ${environmentToken}`,
    }));
  });

  it("refuses an insecure local secrets file", () => {
    saveLocalSecret(HOMERAIL_MANAGER_ADMIN_TOKEN, "cli-local-admin-token-0123456789abcdef");
    if (process.platform === "win32") return;
    fs.chmodSync(getSecretsPath(), 0o644);
    expect(() => new HomeRailClient()).toThrow("group/world-accessible");
  });

  it.runIf(process.platform !== "win32")("refuses a symlinked local secrets file", () => {
    saveLocalSecret(HOMERAIL_MANAGER_ADMIN_TOKEN, "cli-local-admin-token-0123456789abcdef");
    const original = `${getSecretsPath()}.original`;
    fs.renameSync(getSecretsPath(), original);
    fs.symlinkSync(original, getSecretsPath());
    expect(() => new HomeRailClient()).toThrow("non-regular secrets file");
  });

  it("redacts the credential from Manager and transport errors", async () => {
    const token = "cli-redaction-token-0123456789abcdef";
    process.env[HOMERAIL_MANAGER_ADMIN_TOKEN] = token;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: `bad Bearer ${token}` }),
    } as unknown as Response);

    let message = "";
    try {
      await new HomeRailClient().post("/api/runs", {});
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toContain("REDACTED");
    expect(message).not.toContain(token);
  });
});

describe("HomeRailClient.delete", () => {
  it("sends a JSON compare-and-swap body for destructive requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, message: "removed" }),
    } as unknown as Response);
    const client = new HomeRailClient({ baseUrl: "http://test:1234" });
    await client.delete("/api/plugins/com.example.notes", {
      expected_version_set_digest: "f".repeat(64),
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://test:1234/api/plugins/com.example.notes",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ expected_version_set_digest: "f".repeat(64) }),
      }),
    );
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

  it("uses the Manager error field for plugin API failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ success: false, error: "Plugin is not healthy" }),
    } as unknown as Response);

    const client = new HomeRailClient();
    await expect(client.put("/api/plugins/demo/enabled", { enabled: true }))
      .rejects.toThrow("Plugin is not healthy");
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
