import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  managerAgentTurnPayloadDigestInput,
  managerAgentTurnScopeFromPayload,
  validateManagerAgentTurnEnvelope,
  type ManagerAgentTurnEnvelopeV1,
} from "../src/index.js";

describe("Manager Agent turn envelope protocol", () => {
  const now = Date.parse("2026-07-12T10:00:00.000Z");
  const payload = {
    message: "compose",
    project_id: "project-one",
    session_id: "session-one",
    response_mode: "voice",
    generative_ui_mode: "prefer",
    manager_skills: [{ id: "local" }, { id: "plugin-skill" }],
    manager_api_scopes: ["POST:/api/plugins/tools/invoke", "GET:/api/projects"],
    plugin_context: {
      registry_revision: 7,
      context_digest: "a".repeat(64),
      skills: [{ capability_ids: ["plugin:compose"] }],
      tools: [{ capability_ids: ["plugin:compose", "plugin:commit"] }],
      actions: [],
    },
  };
  const scope = managerAgentTurnScopeFromPayload(payload, {
    runtime_placement: "container",
    worker_id: "worker-one",
  });
  const payloadDigest = createHash("sha256")
    .update(managerAgentTurnPayloadDigestInput(payload))
    .digest("hex");

  function envelope(): ManagerAgentTurnEnvelopeV1 {
    return {
      claims: {
        turn_envelope_version: 1,
        issuer: "homerail-manager",
        audience: "homerail-manager-agent-worker",
        key_id: "manager-key-one",
        turn_id: "turn-one",
        issued_at: "2026-07-12T10:00:00.000Z",
        expires_at: "2026-07-12T10:01:00.000Z",
        payload_digest: payloadDigest,
        scope,
      },
      signature: "A".repeat(86),
    };
  }

  it("binds exact payload and canonical scoped assets", () => {
    expect(scope).toMatchObject({
      project_id: "project-one",
      response_mode: "voice",
      generative_ui_mode: "prefer",
      plugin_registry_revision: 7,
      capability_ids: ["plugin:commit", "plugin:compose"],
      manager_skill_ids: ["local", "plugin-skill"],
      manager_api_scopes: ["GET:/api/projects", "POST:/api/plugins/tools/invoke"],
    });
    expect(validateManagerAgentTurnEnvelope(envelope(), {
      payload,
      payload_digest: payloadDigest,
      expected_scope: scope,
      now_ms: now,
    })).toMatchObject({ valid: true, errors: [] });
  });

  it("rejects payload, Worker scope, expiry, and unknown fields", () => {
    expect(validateManagerAgentTurnEnvelope(envelope(), {
      payload: { ...payload, message: "tampered" },
      payload_digest: createHash("sha256")
        .update(managerAgentTurnPayloadDigestInput({ ...payload, message: "tampered" }))
        .digest("hex"),
      expected_scope: scope,
      now_ms: now,
    }).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/claims/payload_digest" }),
    ]));
    expect(validateManagerAgentTurnEnvelope(envelope(), {
      payload,
      payload_digest: payloadDigest,
      expected_scope: { ...scope, worker_id: "other-worker" },
      now_ms: now,
    }).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/claims/scope" }),
    ]));
    expect(validateManagerAgentTurnEnvelope(envelope(), {
      payload,
      payload_digest: payloadDigest,
      expected_scope: scope,
      now_ms: Date.parse("2026-07-12T10:03:00.000Z"),
      clock_skew_ms: 0,
    }).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/claims/expires_at" }),
    ]));
    const extra = { ...envelope(), injected: true };
    expect(validateManagerAgentTurnEnvelope(extra, {
      payload,
      payload_digest: payloadDigest,
      expected_scope: scope,
      now_ms: now,
    }).valid).toBe(false);
  });
});
