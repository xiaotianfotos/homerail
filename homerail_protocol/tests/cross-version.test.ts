/**
 * Cross-version compatibility tests.
 * @version 0.1.0
 */

import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION } from "../src/index.js";
import { MessageClassMap } from "../src/codec.js";
import { allSchemas } from "../src/schemas.js";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

describe("Protocol version consistency", () => {
  it("PROTOCOL_VERSION matches package.json version", () => {
    const pkgPath = resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    expect(PROTOCOL_VERSION).toBe(pkg.version);
  });

  it("PROTOCOL_VERSION is a valid semver", () => {
    const semverRegex = /^\d+\.\d+\.\d+$/;
    expect(semverRegex.test(PROTOCOL_VERSION)).toBe(true);
  });

  it("source files reference the protocol version", () => {
    const srcDir = resolve(__dirname, "..", "src");
    const files = readdirSync(srcDir).filter((f: string) => f.endsWith(".ts"));

    for (const file of files) {
      const content = readFileSync(resolve(srcDir, file), "utf-8");
      expect(content).toContain("@version");
    }
  });

  it("MessageClassMap covers all known message types", () => {
    const knownTypes = [
      "request",
      "response",
      "event",
      "stream",
      "async_request",
      "async_response",
      "async_progress",
      "async_control",
    ];
    for (const t of knownTypes) {
      expect(MessageClassMap[t]).toBeDefined();
    }
  });

  it("allSchemas covers all fixture schemas", () => {
    const requiredSchemas = [
      "generative-ui-node", "generative-ui-stored-node", "generative-ui-document",
      "generative-ui-transaction", "generative-ui-user-override",
      "generative-ui-composition-context", "generative-ui-composition",
      "generative-ui-interaction-event",
      "homerail-plugin-manifest-v1",
      "homerail-plugin-turn-context-v1",
      "homerail-plugin-ui-projection-v1",
      "homerail-resolved-plugin-descriptor-v1",
      "homerail-direct-ui-projection-v1",
      "homerail-plugin-tool-execution-envelope-v1",
      "handoff-request", "handoff-response",
      "tool-call", "tool-result",
      "send-message", "receive-message",
      "graph-context",
      "agent-config", "dag-node-config",
      "message-base",
      "request", "response", "event", "stream-message",
      "async-request", "async-response",
      "async-progress", "async-control", "async-result",
    ];
    for (const s of requiredSchemas) {
      expect(allSchemas[s]).toBeDefined();
    }
  });
});
