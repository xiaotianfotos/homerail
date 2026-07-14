import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  homerailPluginToolInvocationDigestInput,
  type HomerailPluginToolConfirmationChallengeV1,
  type HomerailPluginToolConfirmationDecisionV1,
  type HomerailPluginToolInvocationV1,
} from "homerail-protocol";
import { buildHrpArchive, scaffoldPluginProject, scanPluginSource, sourceFilesForPack } from "homerail-plugin-sdk";
import { closeDb } from "../src/persistence/db.js";
import {
  consumePluginToolConfirmation,
  consumePluginToolCapabilityNonce,
  createPluginToolRequest,
  decidePluginToolConfirmation,
  getPluginToolConfirmation,
  getPluginToolRequest,
  listPluginToolEvents,
  recordPluginToolCapabilityNonce,
  transitionPluginToolRequest,
} from "../src/persistence/plugin-actions.js";
import { installHrpArchive } from "../src/plugins/package-lifecycle.js";
import { pluginJsonDigest } from "../src/plugins/descriptor.js";

const invokedAt = "2026-07-11T17:00:00.000Z";
const deadlineAt = "2026-07-11T17:10:00.000Z";

describe("plugin Tool persistence", () => {
  let previousHome: string | undefined;
  let home: string;
  let source: string;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-action-home-"));
    source = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-action-source-"));
    process.env.HOMERAIL_HOME = home;
    scaffoldPluginProject(source, "com.example.actions");
    installHrpArchive(buildHrpArchive(sourceFilesForPack(scanPluginSource(source))).archive);
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  });

  function invocation(input: { requestId?: string; idempotencyKey?: string } = {}): HomerailPluginToolInvocationV1 {
    const value: HomerailPluginToolInvocationV1 = {
      tool_bus_version: 1,
      request_id: input.requestId ?? "action-request-one",
      idempotency_key: input.idempotencyKey ?? "action-idempotency-one",
      request_digest: "0".repeat(64),
      invoked_at: invokedAt,
      deadline_at: deadlineAt,
      source: {
        type: "ui_action",
        target: {
          document_id: "document-one",
          document_revision: 1,
          node_id: "com.example.actions:card-one",
          node_revision: 1,
          action_id: "complete",
          action_intent: "com.example.actions.complete",
        },
        action: {
          local_id: "complete",
          qualified_id: "com.example.actions:complete",
        },
        input_digest: pluginJsonDigest({}),
      },
      tool: {
        local_id: "upsert_card",
        qualified_id: "com.example.actions:upsert_card",
        wire_id: "p_0123456789_upsert_card",
        handler: { type: "projection", digest: "e".repeat(64) },
      },
      binding: {
        plugin_id: "com.example.actions",
        plugin_version: "0.1.0",
        manifest_digest: "a".repeat(64),
        package_digest: "b".repeat(64),
        context_digest: "c".repeat(64),
        registry_revision: 3,
        permission_revision: 0,
      },
      policy: {
        effect: "write",
        permissions: [],
        effective_grants: [],
        confirmation: "always",
        confirmation_required: true,
      },
      arguments: { status: "complete" },
    };
    value.request_digest = pluginJsonDigest(homerailPluginToolInvocationDigestInput(value));
    return value;
  }

  function confirmationChallenge(
    request: HomerailPluginToolInvocationV1,
    challengeId: string,
    expiresAt = "2026-07-11T17:05:00.000Z",
  ): HomerailPluginToolConfirmationChallengeV1 {
    return {
      confirmation_version: 1,
      challenge_id: challengeId,
      request_id: request.request_id,
      request_digest: request.request_digest,
      effect: request.policy.effect,
      permissions: [],
      effective_grants: [],
      message: "Complete this card?",
      issued_at: "2026-07-11T17:01:00.000Z",
      expires_at: expiresAt,
    };
  }

  it("persists idempotency, one-shot confirmation, capability nonce, and terminal result", () => {
    const request = invocation();
    const challenge = confirmationChallenge(request, "confirmation-one");
    const created = createPluginToolRequest({
      invocation: request,
      policy_digest: "d".repeat(64),
      status: "awaiting_confirmation",
      confirmation_challenge: challenge,
    });
    expect(created).toMatchObject({ idempotent: false, record: { status: "awaiting_confirmation" } });
    expect(createPluginToolRequest({
      invocation: structuredClone(request),
      policy_digest: "d".repeat(64),
      status: "awaiting_confirmation",
      confirmation_challenge: structuredClone(challenge),
    })).toMatchObject({ idempotent: true, record: { request_digest: request.request_digest } });
    const collision = invocation({ requestId: "action-request-collision" });
    expect(() => createPluginToolRequest({
      invocation: collision,
      policy_digest: "d".repeat(64),
      status: "awaiting_confirmation",
      confirmation_challenge: confirmationChallenge(collision, "confirmation-collision"),
    })).toThrow(/idempotency collision/);

    expect(getPluginToolConfirmation(challenge.challenge_id)).toMatchObject({ status: "pending" });
    const decision: HomerailPluginToolConfirmationDecisionV1 = {
      confirmation_version: 1,
      challenge_id: challenge.challenge_id,
      request_id: request.request_id,
      request_digest: request.request_digest,
      decision: "approved",
      actor: { type: "user", id: "local-user" },
      decided_at: "2026-07-11T17:02:00.000Z",
    };
    expect(decidePluginToolConfirmation({ decision })).toMatchObject({ status: "approved" });
    expect(getPluginToolRequest(request.request_id)).toMatchObject({ status: "authorized" });
    expect(consumePluginToolConfirmation(challenge.challenge_id, "2026-07-11T17:02:01.000Z"))
      .toMatchObject({ status: "consumed" });
    expect(() => consumePluginToolConfirmation(challenge.challenge_id)).toThrow(/already consumed/);

    recordPluginToolCapabilityNonce({
      nonce: "capability-nonce-one",
      capability_id: "capability-one",
      request_id: request.request_id,
      request_digest: request.request_digest,
      token_digest: "e".repeat(64),
      expires_at: "2026-07-11T17:04:00.000Z",
      created_at: "2026-07-11T17:02:02.000Z",
    });
    consumePluginToolCapabilityNonce({
      nonce: "capability-nonce-one",
      request_id: request.request_id,
      request_digest: request.request_digest,
      token_digest: "e".repeat(64),
      consumed_at: "2026-07-11T17:02:03.000Z",
    });
    expect(() => consumePluginToolCapabilityNonce({
      nonce: "capability-nonce-one",
      request_id: request.request_id,
      request_digest: request.request_digest,
      token_digest: "e".repeat(64),
      consumed_at: "2026-07-11T17:02:04.000Z",
    })).toThrow(/already consumed/);

    transitionPluginToolRequest({
      request_id: request.request_id,
      expected_status: "authorized",
      status: "running",
      updated_at: "2026-07-11T17:02:05.000Z",
    });
    const committed = transitionPluginToolRequest({
      request_id: request.request_id,
      expected_status: "running",
      status: "committed",
      updated_at: "2026-07-11T17:02:06.000Z",
      result: { document_revision: 2, transaction_id: "plugin-action-one" },
    });
    expect(committed).toMatchObject({
      status: "committed",
      result: { document_revision: 2, transaction_id: "plugin-action-one" },
    });
    expect(() => transitionPluginToolRequest({
      request_id: request.request_id,
      expected_status: "committed",
      status: "running",
    })).toThrow(/Invalid plugin Tool transition/);
    expect(listPluginToolEvents(request.request_id).map((event) => event.event_type))
      .toEqual(["requested", "confirmation_issued", "confirmed"]);
  });

  it("persists expiry and makes the waiting Action terminal", () => {
    const request = invocation({
      requestId: "action-request-expired",
      idempotencyKey: "action-idempotency-expired",
    });
    const challenge = confirmationChallenge(request, "confirmation-expired");
    createPluginToolRequest({
      invocation: request,
      policy_digest: "d".repeat(64),
      status: "awaiting_confirmation",
      confirmation_challenge: challenge,
    });
    const late: HomerailPluginToolConfirmationDecisionV1 = {
      confirmation_version: 1,
      challenge_id: challenge.challenge_id,
      request_id: request.request_id,
      request_digest: request.request_digest,
      decision: "approved",
      actor: { type: "user", id: "local-user" },
      decided_at: "2026-07-11T17:06:00.000Z",
    };
    expect(decidePluginToolConfirmation({ decision: late })).toMatchObject({ status: "expired" });
    expect(getPluginToolConfirmation(challenge.challenge_id)).toMatchObject({ status: "expired" });
    expect(getPluginToolRequest(request.request_id)).toMatchObject({
      status: "failed",
      error_code: "confirmation_expired",
    });
    expect(listPluginToolEvents(request.request_id).map((event) => event.event_type))
      .toEqual(["requested", "confirmation_issued", "failed"]);
    expect(() => decidePluginToolConfirmation({ decision: late })).toThrow(/no longer pending/);
  });

  it("rolls back the request and requested event if challenge persistence fails", () => {
    const first = invocation({
      requestId: "atomic-request-first",
      idempotencyKey: "atomic-idempotency-first",
    });
    createPluginToolRequest({
      invocation: first,
      policy_digest: "d".repeat(64),
      status: "awaiting_confirmation",
      confirmation_challenge: confirmationChallenge(first, "atomic-challenge-shared"),
    });

    const second = invocation({
      requestId: "atomic-request-second",
      idempotencyKey: "atomic-idempotency-second",
    });
    expect(() => createPluginToolRequest({
      invocation: second,
      policy_digest: "d".repeat(64),
      status: "awaiting_confirmation",
      // The duplicate primary key fails after the request INSERT. The outer
      // immediate transaction must roll the request and its event back too.
      confirmation_challenge: confirmationChallenge(second, "atomic-challenge-shared"),
    })).toThrow(/unique/i);
    expect(getPluginToolRequest(second.request_id)).toBeUndefined();
    expect(listPluginToolEvents(second.request_id)).toEqual([]);
    expect(getPluginToolConfirmation("atomic-challenge-shared")).toMatchObject({
      challenge: { request_id: first.request_id },
      status: "pending",
    });
  });
});
