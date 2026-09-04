import { describe, expect, it } from "vitest";
import { dagCredentialBrokerCallIdentity } from "homerail-protocol";

import { CredentialBrokerRequestRegistry } from "../credential-broker-requests.js";

function request(id: string) {
  return {
    request_id: id,
    idempotency_key: id,
    transport_kind: "worker_actor" as const,
    run_id: "run",
    node_id: "aggregate",
    session_id: "session",
    round_id: "round",
    actor_id: "actor",
    generation: 1,
    lease_generation: 1,
    credential_ref: "github-autofix",
    broker: "github_pr",
    action: "commit_workspace",
    input: {},
  };
}

describe("CredentialBrokerRequestRegistry", () => {
  it("waits for the Manager result without a local action timeout", async () => {
    const registry = new CredentialBrokerRequestRegistry();
    const sent: string[] = [];
    const pending = registry.call(request("request-1"), (payload) => sent.push(payload));

    expect(registry.size).toBe(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({
      type: "credential_broker_call",
      data: { request_id: "request-1", action: "commit_workspace" },
    });
    expect(registry.settle({
      request_id: "request-1",
      identity: dagCredentialBrokerCallIdentity(request("request-1")),
      ok: true,
      outcome: "completed",
      result: { head_sha: "a".repeat(40), manifest_sha256: "b".repeat(64) },
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({
      request_id: "request-1",
      ok: true,
      result: { manifest_sha256: "b".repeat(64) },
    });
    expect(registry.size).toBe(0);
  });

  it("settles outstanding requests only when the Worker connection closes", async () => {
    const registry = new CredentialBrokerRequestRegistry();
    const pending = registry.call(request("request-2"), () => {});

    registry.close("connection closed");

    await expect(pending).resolves.toEqual({
      request_id: "request-2",
      identity: dagCredentialBrokerCallIdentity(request("request-2")),
      ok: false,
      outcome: "indeterminate",
      error: "connection closed",
    });
    expect(registry.size).toBe(0);
  });

  it("forwards the complete transport fence when an in-flight turn is cancelled", async () => {
    const registry = new CredentialBrokerRequestRegistry();
    const controller = new AbortController();
    const sent: string[] = [];
    const pending = registry.call(
      request("request-3"),
      (payload) => sent.push(payload),
      controller.signal,
    );

    controller.abort();

    expect(sent.map((payload) => JSON.parse(payload))).toEqual([
      expect.objectContaining({ type: "credential_broker_call" }),
      {
        type: "credential_broker_cancel",
        data: {
          request_id: "request-3",
          idempotency_key: "request-3",
          transport_kind: "worker_actor",
          run_id: "run",
          node_id: "aggregate",
          session_id: "session",
          round_id: "round",
          actor_id: "actor",
          generation: 1,
          lease_generation: 1,
        },
      },
    ]);
    expect(registry.settle({
      request_id: "request-3",
      identity: dagCredentialBrokerCallIdentity(request("request-3")),
      ok: false,
      outcome: "cancelled",
      error: "cancelled by Manager",
    })).toBe(false);
    await expect(pending).resolves.toMatchObject({ outcome: "indeterminate" });
    expect(registry.size).toBe(0);
  });

  it("does not dispatch when the turn was already cancelled", async () => {
    const registry = new CredentialBrokerRequestRegistry();
    const controller = new AbortController();
    const sent: string[] = [];
    controller.abort();

    await expect(registry.call(
      request("request-4"),
      (payload) => sent.push(payload),
      controller.signal,
    )).resolves.toMatchObject({ outcome: "cancelled" });
    expect(sent).toEqual([]);
  });

  it("rejects a result whose echoed immutable identity does not match", async () => {
    const registry = new CredentialBrokerRequestRegistry();
    const pending = registry.call(request("request-5"), () => {});
    const mismatchedIdentity = dagCredentialBrokerCallIdentity(request("request-5"));
    if (mismatchedIdentity.transport_kind !== "worker_actor") throw new Error("expected Worker identity");

    expect(registry.settle({
      request_id: "request-5",
      identity: {
        ...mismatchedIdentity,
        generation: 2,
      },
      ok: true,
      outcome: "completed",
      result: {},
    })).toBe(false);
    expect(registry.size).toBe(1);
    registry.close("connection closed");
    await expect(pending).resolves.toMatchObject({ outcome: "indeterminate" });
  });
});
