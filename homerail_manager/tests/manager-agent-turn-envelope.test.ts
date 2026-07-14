import * as http from "node:http";
import { createHash, createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOMERAIL_MANAGER_TURN_KEY_ID_ENV,
  HOMERAIL_MANAGER_TURN_PUBLIC_KEY_ENV,
  managerAgentTurnClaimsSigningInput,
  managerAgentTurnPayloadDigestInput,
  managerAgentTurnScopeFromPayload,
  validateManagerAgentTurnEnvelope,
  type ManagerAgentTurnEnvelopeV1,
} from "homerail-protocol";
import { forwardChatToManagerAgentContainer } from "../src/server/manager-agent-container.js";
import { getManagerAgentTurnEnvelopeAuthority } from "../src/server/manager-agent-turn-envelope.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Manager Agent signed turn envelope", () => {
  it("forwards a signed, target-scoped payload while exposing only the public key", async () => {
    let observed: Record<string, unknown> | undefined;
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        observed = JSON.parse(raw) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "ok" }));
      });
    });
    servers.push(server);
    const port = await listen(server);
    const payload = {
      message: "compose",
      project_id: "project-one",
      session_id: "session-one",
      response_mode: "voice",
      generative_ui_mode: "prefer",
      manager_skills: [{ id: "skill-one" }],
      plugin_context: {
        registry_revision: 4,
        context_digest: "a".repeat(64),
        skills: [],
        tools: [{ capability_ids: ["plugin:compose"] }],
        actions: [],
      },
    };
    await expect(forwardChatToManagerAgentContainer({
      containerId: "container-one",
      nodeId: "node-one",
      baseUrl: `http://127.0.0.1:${port}`,
      containerName: "manager-agent-one",
      workerId: "worker-one",
    }, payload)).resolves.toEqual({ text: "ok" });

    expect(observed).toBeDefined();
    const envelope = observed!.turn_envelope as ManagerAgentTurnEnvelopeV1;
    const payloadDigest = createHash("sha256")
      .update(managerAgentTurnPayloadDigestInput(observed!))
      .digest("hex");
    const expectedScope = managerAgentTurnScopeFromPayload(observed!, {
      runtime_placement: "container",
      worker_id: "worker-one",
    });
    expect(validateManagerAgentTurnEnvelope(envelope, {
      payload: observed!,
      payload_digest: payloadDigest,
      expected_scope: expectedScope,
    })).toMatchObject({ valid: true, errors: [] });

    const environment = getManagerAgentTurnEnvelopeAuthority().workerEnvironment();
    expect(Object.keys(environment).sort()).toEqual([
      "HOMERAIL_MANAGER_TURN_ENVELOPE_REQUIRED",
      HOMERAIL_MANAGER_TURN_KEY_ID_ENV,
      HOMERAIL_MANAGER_TURN_PUBLIC_KEY_ENV,
    ].sort());
    expect(envelope.claims.key_id).toBe(environment[HOMERAIL_MANAGER_TURN_KEY_ID_ENV]);
    const publicKey = createPublicKey({
      key: Buffer.from(environment[HOMERAIL_MANAGER_TURN_PUBLIC_KEY_ENV]!, "base64url"),
      format: "der",
      type: "spki",
    });
    expect(verify(
      null,
      Buffer.from(managerAgentTurnClaimsSigningInput(envelope.claims), "utf8"),
      publicKey,
      Buffer.from(envelope.signature, "base64url"),
    )).toBe(true);
  });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}
