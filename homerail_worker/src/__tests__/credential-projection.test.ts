import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  containsCredentialValue,
  materializeCredentialProjections,
  redactCredentialValues,
} from "../credential-projection.js";
import { createDagToolsState } from "../dag-tools/index.js";
import { createCredentialBrokerCallTool } from "../dag-tools/credential-broker.js";

describe("turn-scoped credential projection", () => {
  it("projects env and tmpfs files, then removes every value", () => {
    const materialized = materializeCredentialProjections([
      {
        credential_ref: "bot",
        purpose: "publish",
        mode: "env",
        values: { LARK_APP_ID: "app-id", LARK_APP_SECRET: "app-secret" },
      },
      {
        credential_ref: "ssh",
        purpose: "remote smoke",
        mode: "file",
        field: "private_key",
        content: "PRIVATE KEY CONTENT",
        filename: "id_ed25519",
        env: "SSH_KEY_PATH",
      },
      {
        credential_ref: "ssh",
        purpose: "known hosts stdin",
        mode: "stdin",
        field: "known_hosts",
        content: "example ssh-ed25519 AAAA",
        filename: "known_hosts",
        env: "SSH_KNOWN_HOSTS_STDIN_PATH",
      },
    ]);
    const keyPath = materialized.env.SSH_KEY_PATH;
    const stdinPath = materialized.env.SSH_KNOWN_HOSTS_STDIN_PATH;
    expect(materialized.env).toMatchObject({ LARK_APP_ID: "app-id", LARK_APP_SECRET: "app-secret" });
    expect(fs.readFileSync(keyPath, "utf8")).toBe("PRIVATE KEY CONTENT");
    expect(fs.readFileSync(stdinPath, "utf8")).toBe("example ssh-ed25519 AAAA");
    expect(materialized.redaction_values).toEqual(expect.arrayContaining([
      "app-secret",
      "PRIVATE KEY CONTENT",
      "example ssh-ed25519 AAAA",
    ]));
    if (process.platform !== "win32") expect(fs.statSync(keyPath).mode & 0o077).toBe(0);
    expect(keyPath.startsWith("/dev/shm/") || keyPath.includes("homerail-credentials")).toBe(true);

    materialized.cleanup();
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(fs.existsSync(stdinPath)).toBe(false);
    expect(materialized.env).toEqual({});
    expect(materialized.redaction_values).toEqual([]);
  });

  it("redacts turn secrets and detects reflected handoff values", () => {
    expect(redactCredentialValues({ text: "prefix-secret-value-suffix" }, ["secret-value"]))
      .toEqual({ text: "prefix-***-suffix" });
    expect(containsCredentialValue({ result: "prefix-secret-value-suffix" }, ["secret-value"]))
      .toBe(true);
    expect(containsCredentialValue({ result: "safe" }, ["secret-value"]))
      .toBe(false);
  });

  it("keeps Manager broker bindings opaque", () => {
    const materialized = materializeCredentialProjections([{
      credential_ref: "lark-user",
      purpose: "write user document",
      mode: "manager_broker",
      broker: "lark-user",
      allowed_actions: ["document.create"],
    }]);
    expect(materialized.env).toEqual({});
    expect(materialized.broker_refs).toEqual([expect.objectContaining({ credential_ref: "lark-user" })]);
    materialized.cleanup();
  });

  it("only calls a Manager broker action declared for the node", async () => {
    const state = createDagToolsState({
      node_id: "worker",
      agent_type: "deterministic",
      model: "test",
      outgoing_edges: [],
      incoming_edges: [],
      graph_nodes: ["worker"],
      session_id: "session-1",
    }, "run-1", () => {});
    const calls: unknown[] = [];
    const tool = createCredentialBrokerCallTool(state, [{
      credential_ref: "lark-bot",
      purpose: "read bot info",
      mode: "manager_broker",
      broker: "lark_bot",
      allowed_actions: ["bot_info"],
    }], async (request) => {
      calls.push(request);
      return { request_id: request.request_id, ok: true, result: { bot_name: "Codex" } };
    });

    const accepted = await tool.handler({ credential_ref: "lark-bot", action: "bot_info", input: {} });
    expect(accepted.is_error).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      run_id: "run-1",
      node_id: "worker",
      session_id: "session-1",
      credential_ref: "lark-bot",
      broker: "lark_bot",
      action: "bot_info",
    });

    const denied = await tool.handler({ credential_ref: "lark-bot", action: "send_message", input: {} });
    expect(denied.is_error).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
