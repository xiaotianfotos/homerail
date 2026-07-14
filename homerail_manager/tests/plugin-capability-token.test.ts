import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  homerailPluginToolInvocationDigestInput,
  type HomerailPluginToolInvocationV1,
} from "homerail-protocol";
import { buildHrpArchive, scaffoldPluginProject, scanPluginSource, sourceFilesForPack } from "homerail-plugin-sdk";
import { closeDb } from "../src/persistence/db.js";
import { createPluginToolRequest } from "../src/persistence/plugin-actions.js";
import {
  PluginToolCapabilityTokenAuthority,
  loadPluginCapabilitySecret,
} from "../src/plugins/capability-token.js";
import { pluginJsonDigest } from "../src/plugins/descriptor.js";
import { installHrpArchive } from "../src/plugins/package-lifecycle.js";

describe("plugin Tool capability tokens", () => {
  let savedEnv: NodeJS.ProcessEnv;
  let home: string;
  const sources: string[] = [];

  beforeEach(() => {
    savedEnv = { ...process.env };
    closeDb();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-capability-home-"));
    process.env.HOMERAIL_HOME = home;
    delete process.env.HOMERAIL_PLUGIN_CAPABILITY_SECRET;
    const source = project("com.example.capability");
    install(source);
  });

  afterEach(() => {
    closeDb();
    process.env = savedEnv;
    fs.rmSync(home, { recursive: true, force: true });
    for (const source of sources.splice(0)) fs.rmSync(source, { recursive: true, force: true });
  });

  function project(id: string): string {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-capability-source-"));
    sources.push(source);
    scaffoldPluginProject(source, id);
    return source;
  }

  function install(source: string): void {
    installHrpArchive(buildHrpArchive(sourceFilesForPack(scanPluginSource(source))).archive);
  }

  function invocation(suffix: string, permissionRevision = 0): HomerailPluginToolInvocationV1 {
    const value: HomerailPluginToolInvocationV1 = {
      tool_bus_version: 1,
      request_id: `request_${suffix}`,
      idempotency_key: `idempotency_${suffix}`,
      request_digest: "0".repeat(64),
      invoked_at: "2026-07-11T17:00:00.000Z",
      deadline_at: "2026-07-11T17:10:00.000Z",
      source: {
        type: "ui_action",
        target: {
          document_id: "document-one",
          document_revision: 1,
          node_id: "com.example.capability:node-one",
          node_revision: 1,
          action_id: "inspect",
          action_intent: "com.example.capability.inspect",
        },
        action: { local_id: "inspect", qualified_id: "com.example.capability:inspect" },
        input_digest: pluginJsonDigest({}),
      },
      tool: {
        local_id: "upsert_card",
        qualified_id: "com.example.capability:upsert_card",
        wire_id: "p_0123456789_upsert_card",
        handler: { type: "projection", digest: "e".repeat(64) },
      },
      binding: {
        plugin_id: "com.example.capability",
        plugin_version: "0.1.0",
        manifest_digest: "a".repeat(64),
        package_digest: "b".repeat(64),
        context_digest: "c".repeat(64),
        registry_revision: 2,
        permission_revision: permissionRevision,
      },
      policy: {
        effect: "read",
        permissions: [],
        effective_grants: [],
        confirmation: "never",
        confirmation_required: false,
      },
      arguments: { query: "status" },
    };
    value.request_digest = pluginJsonDigest(homerailPluginToolInvocationDigestInput(value));
    createPluginToolRequest({ invocation: value, policy_digest: "d".repeat(64), status: "authorized" });
    return value;
  }

  it("issues, verifies, and consumes a short-lived capability exactly once", () => {
    const request = invocation("one");
    const authority = new PluginToolCapabilityTokenAuthority(Buffer.alloc(32, 0x42));
    const issued = authority.issue({
      invocation: request,
      now: new Date("2026-07-11T17:01:00.000Z"),
      ttl_ms: 60_000,
    });
    expect(issued.token).toMatch(/^hrcap1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(issued.claims).toMatchObject({
      request_id: request.request_id,
      request_digest: request.request_digest,
      single_use: true,
      audience: "homerail.plugin-runtime",
    });
    expect(authority.verifyAndConsume({
      token: issued.token,
      invocation: request,
      now: new Date("2026-07-11T17:01:10.000Z"),
    })).toEqual(issued.claims);
    expect(() => authority.verifyAndConsume({
      token: issued.token,
      invocation: request,
      now: new Date("2026-07-11T17:01:11.000Z"),
    })).toThrow(/already consumed/);
  });

  it("rejects signature tampering and a permission revision changed after issue", () => {
    const authority = new PluginToolCapabilityTokenAuthority(Buffer.alloc(32, 0x43));
    const tamperRequest = invocation("tamper");
    const tamper = authority.issue({
      invocation: tamperRequest,
      now: new Date("2026-07-11T17:01:00.000Z"),
    });
    const tokenParts = tamper.token.split(".");
    const corruptedSignature = Buffer.from(tokenParts[2]!, "base64url");
    corruptedSignature[0] = corruptedSignature[0]! ^ 0xff;
    const corrupted = `${tokenParts[0]}.${tokenParts[1]}.${corruptedSignature.toString("base64url")}`;
    expect(() => authority.verifyAndConsume({
      token: corrupted,
      invocation: tamperRequest,
      now: new Date("2026-07-11T17:01:01.000Z"),
    })).toThrow(/signature/);

    const staleRequest = invocation("stale");
    const stale = authority.issue({
      invocation: staleRequest,
      now: new Date("2026-07-11T17:01:00.000Z"),
    });
    const permissionSource = project("com.example.permission-bump");
    const manifestFile = path.join(permissionSource, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      permissions: { required: unknown[]; optional: Array<Record<string, unknown>> };
    };
    manifest.permissions.optional = [{ permission: "artifact.read" }];
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    install(permissionSource);

    expect(() => authority.verifyAndConsume({
      token: stale.token,
      invocation: staleRequest,
      now: new Date("2026-07-11T17:01:01.000Z"),
    })).toThrow(/permission snapshot is stale/);
  });

  it("creates and reloads a private Manager-only secret", () => {
    const filePath = path.join(home, "manager", "test-capability.key");
    const first = loadPluginCapabilitySecret(filePath);
    const second = loadPluginCapabilitySecret(filePath);
    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
    if (process.platform !== "win32") expect(fs.statSync(filePath).mode & 0o077).toBe(0);
    fs.chmodSync(filePath, 0o644);
    if (process.platform !== "win32") expect(() => loadPluginCapabilitySecret(filePath)).toThrow(/group\/world/);
  });

  it.runIf(process.platform !== "win32")("refuses a secret path with a symlinked parent", () => {
    const realParent = path.join(home, "real-parent");
    const linkedParent = path.join(home, "linked-parent");
    fs.mkdirSync(realParent);
    fs.symlinkSync(realParent, linkedParent, "dir");
    expect(() => loadPluginCapabilitySecret(path.join(linkedParent, "capability.key")))
      .toThrow(/real directories/);
    expect(fs.existsSync(path.join(realParent, "capability.key"))).toBe(false);
  });
});
