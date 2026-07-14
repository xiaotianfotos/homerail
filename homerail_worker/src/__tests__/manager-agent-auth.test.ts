import * as http from "node:http";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _requestManagerForTest,
  _withManagerTurnEnvelopeForTest,
} from "../manager-agent/server.js";
import { sanitizedAgentChildEnv } from "../agent/child-env.js";
import { startManagerAgentServer } from "../manager-agent/server.js";
import { ManagerAgentTurnEnvelopeVerifier } from "../manager-agent/turn-envelope.js";
import {
  managerAgentTurnClaimsSigningInput,
  managerAgentTurnPayloadDigestInput,
  managerAgentTurnScopeFromPayload,
  HOMERAIL_MANAGER_TURN_HEADER,
  type ManagerAgentTurnEnvelopeV1,
} from "homerail-protocol";

const TOKEN = "worker-manager-admin-token-0123456789abcdef";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("container Manager Agent REST authentication", () => {
  it("keeps the Manager credential out of shells and Agent backend environments", () => {
    const source = {
      HOMERAIL_MANAGER_ADMIN_TOKEN: TOKEN,
      HOMERAIL_PLUGIN_CAPABILITY_SECRET: "capability-secret",
      ANTHROPIC_API_KEY: "provider-key",
      PATH: "/usr/bin",
    };
    expect(sanitizedAgentChildEnv(source)).toEqual({
      ANTHROPIC_API_KEY: "provider-key",
      PATH: "/usr/bin",
    });
    expect(source.HOMERAIL_MANAGER_ADMIN_TOKEN).toBe(TOKEN);
    expect(source.HOMERAIL_PLUGIN_CAPABILITY_SECRET).toBe("capability-secret");
  });

  it("adds only the scoped turn credential to /api mutations and redacts Manager errors", async () => {
    const envelope = headerEnvelope();
    const credential = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
    const observed: Array<{ method?: string; authorization?: string; turn?: string }> = [];
    const server = http.createServer((req, res) => {
      observed.push({
        method: req.method,
        authorization: req.headers.authorization,
        turn: req.headers[HOMERAIL_MANAGER_TURN_HEADER] as string | undefined,
      });
      req.resume();
      if (req.url === "/api/error") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `bad credential=${credential}` }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
    const restUrl = await listen(server);
    vi.stubEnv("MANAGER_REST_URL", restUrl);

    try {
      await expect(_requestManagerForTest("/read")).resolves.toEqual({ success: true });
      await expect(_withManagerTurnEnvelopeForTest(envelope, () => _requestManagerForTest("/write", {
        method: "POST",
        headers: {
          Authorization: "Bearer caller-controlled",
          [HOMERAIL_MANAGER_TURN_HEADER]: "caller-controlled",
        },
        body: "{}",
      }))).resolves.toEqual({ success: true });
      expect(observed.slice(0, 2)).toEqual([
        { method: "GET", authorization: undefined, turn: undefined },
        { method: "POST", authorization: undefined, turn: credential },
      ]);

      let error = "";
      try {
        await _withManagerTurnEnvelopeForTest(envelope, () => (
          _requestManagerForTest("/error", { method: "PATCH" })
        ));
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      expect(error).toContain("REDACTED");
      expect(error).not.toContain(credential);
    } finally {
      await close(server);
    }
  });

  it("requires a valid scoped Manager signature and consumes each turn once", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const env: NodeJS.ProcessEnv = {
      HOMERAIL_MANAGER_TURN_PUBLIC_KEY: (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64url"),
      HOMERAIL_MANAGER_TURN_KEY_ID: "manager-test-key",
      HOMERAIL_MANAGER_TURN_ENVELOPE_REQUIRED: "1",
      HOMERAIL_MANAGER_AGENT_RUNTIME_PLACEMENT: "container",
      HOMERAIL_WORKER_ID: "worker-test",
      PROJECT_ID: "project-test",
    };
    const verifier = new ManagerAgentTurnEnvelopeVerifier(env);
    const payload = {
      message: "trusted turn",
      project_id: "project-test",
      session_id: "session-test",
      response_mode: "voice",
      generative_ui_mode: "prefer",
      manager_skills: [{ id: "skill-one" }],
      plugin_context: {
        registry_revision: 2,
        context_digest: "a".repeat(64),
        skills: [],
        tools: [{ capability_ids: ["plugin:tool"] }],
        actions: [],
      },
    };
    const now = new Date("2026-07-12T10:00:00.000Z");
    const envelope = signEnvelope(payload, privateKey, now);
    const sealed = { ...payload, turn_envelope: envelope };
    expect(verifier.authenticate(sealed, now)).toEqual(envelope);
    expect(() => verifier.authenticate(sealed, now)).toThrow(/already consumed/);
    const withinExpirySkew = new Date("2026-07-12T10:01:05.000Z");
    const skewVerifier = new ManagerAgentTurnEnvelopeVerifier(env);
    expect(skewVerifier.authenticate(sealed, withinExpirySkew)).toEqual(envelope);
    expect(() => skewVerifier.authenticate(sealed, withinExpirySkew)).toThrow(/already consumed/);

    const tampered = { ...sealed, message: "tampered" };
    expect(() => new ManagerAgentTurnEnvelopeVerifier(env).authenticate(tampered, now))
      .toThrow(/payload_digest/);
    const wrongProject = { ...payload, project_id: "other", turn_envelope: envelope };
    expect(() => new ManagerAgentTurnEnvelopeVerifier(env).authenticate(wrongProject, now))
      .toThrow(/project scope/);
    expect(() => new ManagerAgentTurnEnvelopeVerifier(env).authenticate(payload, now))
      .toThrow(/required/);

    function signEnvelope(
      request: Record<string, unknown>,
      key: typeof privateKey,
      issued: Date,
    ): ManagerAgentTurnEnvelopeV1 {
      const claims = {
        turn_envelope_version: 1 as const,
        issuer: "homerail-manager" as const,
        audience: "homerail-manager-agent-worker" as const,
        key_id: "manager-test-key",
        turn_id: "turn-test-one",
        issued_at: issued.toISOString(),
        expires_at: new Date(issued.getTime() + 60_000).toISOString(),
        payload_digest: createHash("sha256").update(managerAgentTurnPayloadDigestInput(request)).digest("hex"),
        scope: managerAgentTurnScopeFromPayload(request, {
          runtime_placement: "container",
          worker_id: "worker-test",
        }),
      };
      return {
        claims,
        signature: sign(null, Buffer.from(managerAgentTurnClaimsSigningInput(claims), "utf8"), key).toString("base64url"),
      };
    }
  });

  it("fails closed when Manager Agent mode starts without a verification key", () => {
    expect(() => new ManagerAgentTurnEnvelopeVerifier({ MANAGER_AGENT_MODE: "1" }))
      .toThrow(/public key/);
  });

  it("rejects unsigned /chat requests before invoking an Agent", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    vi.stubEnv("HOMERAIL_MANAGER_TURN_PUBLIC_KEY", (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64url"));
    vi.stubEnv("HOMERAIL_MANAGER_TURN_KEY_ID", "manager-route-key");
    vi.stubEnv("HOMERAIL_MANAGER_TURN_ENVELOPE_REQUIRED", "1");
    vi.stubEnv("HOMERAIL_MANAGER_AGENT_RUNTIME_PLACEMENT", "container");
    vi.stubEnv("HOMERAIL_WORKER_ID", "worker-route");
    vi.stubEnv("PROJECT_ID", "project-route");
    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("server did not bind");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "unsigned", project_id: "project-route" }),
      });
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/signed turn envelope/) });
    } finally {
      await close(server);
    }
  });
});

function headerEnvelope(): ManagerAgentTurnEnvelopeV1 {
  const payload = {
    project_id: "project-header",
    manager_api_scopes: ["POST:/api/write"],
  };
  return {
    claims: {
      turn_envelope_version: 1,
      issuer: "homerail-manager",
      audience: "homerail-manager-agent-worker",
      key_id: "manager-header-key",
      turn_id: "turn-header",
      issued_at: "2026-07-12T10:00:00.000Z",
      expires_at: "2026-07-12T10:05:00.000Z",
      payload_digest: "a".repeat(64),
      scope: managerAgentTurnScopeFromPayload(payload, {
        runtime_placement: "container",
        worker_id: "worker-header",
      }),
    },
    signature: "A".repeat(86),
  };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}/api`;
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
