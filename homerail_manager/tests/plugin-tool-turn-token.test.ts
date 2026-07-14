import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHrpArchive,
  scaffoldPluginProject,
  scanPluginSource,
  sourceFilesForPack,
} from "homerail-plugin-sdk";
import {
  homerailPluginTurnContextDigestInput,
  type HomerailPluginTurnContextV1,
} from "homerail-protocol";
import { closeDb } from "../src/persistence/db.js";
import {
  setPluginEnabled,
  setPluginGrantStatus,
} from "../src/persistence/plugins.js";
import {
  assemblePluginTurnContext,
  selectPluginTurnContext,
} from "../src/plugins/context-assembler.js";
import { pluginJsonDigest } from "../src/plugins/descriptor.js";
import { installHrpArchive } from "../src/plugins/package-lifecycle.js";
import { syncBuiltinPlugins } from "../src/plugins/registry.js";
import { PluginToolTurnTokenAuthority } from "../src/plugins/tool-turn-token.js";

const CAPABILITY_ID = "com.homerail.topic-outline:compose-outline";

describe("Manager-issued Plugin Tool turn tokens", () => {
  let savedEnv: NodeJS.ProcessEnv;
  let home: string;
  let permissionSource: string;

  beforeEach(() => {
    savedEnv = { ...process.env };
    closeDb();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-tool-turn-home-"));
    permissionSource = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-tool-turn-plugin-"));
    process.env.HOMERAIL_HOME = home;
    syncBuiltinPlugins();

    scaffoldPluginProject(permissionSource, "com.example.turn-permission");
    const manifestFile = path.join(permissionSource, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      permissions: { required: unknown[]; optional: unknown[] };
    };
    manifest.permissions.optional = [{ permission: "artifact.read" }];
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const snapshot = scanPluginSource(permissionSource);
    expect(snapshot.valid).toBe(true);
    installHrpArchive(buildHrpArchive(sourceFilesForPack(snapshot)).archive);
  });

  afterEach(() => {
    closeDb();
    process.env = savedEnv;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(permissionSource, { recursive: true, force: true });
  });

  function selectedContext(): HomerailPluginTurnContextV1 {
    return selectPluginTurnContext(
      assemblePluginTurnContext(undefined, { modality: "voice" }),
      [CAPABILITY_ID],
    );
  }

  function issue(authority: PluginToolTurnTokenAuthority, now = new Date("2026-07-11T18:00:00.000Z")) {
    return authority.issue({
      context: selectedContext(),
      modality: "voice",
      scope: { type: "voice_session", id: "voice-turn-session" },
      generative_ui_mode: "prefer",
      now,
      ttl_ms: 60_000,
    });
  }

  it("binds the exact selected context, voice scope, modality, and canonical purpose", () => {
    const authority = new PluginToolTurnTokenAuthority(Buffer.alloc(32, 0x41));
    const issued = issue(authority);
    expect(issued.claims).toMatchObject({
      capability_ids: [CAPABILITY_ID],
      modality: "voice",
      scope: { type: "voice_session", id: "voice-turn-session" },
      generative_ui_mode: "prefer",
      document_purpose: "canonical",
    });
    expect(authority.verify({
      token: issued.token,
      now: new Date("2026-07-11T18:00:30.000Z"),
    })).toMatchObject({ claims: issued.claims, context: selectedContext() });

    expect(() => authority.issue({
      context: selectedContext(),
      modality: "voice",
      scope: { type: "project", id: "project-one" },
      generative_ui_mode: "prefer",
    })).toThrow(/voice session scope/);
  });

  it("rejects tampered and non-canonical encodings", () => {
    const authority = new PluginToolTurnTokenAuthority(Buffer.alloc(32, 0x42));
    const { token } = issue(authority);
    const parts = token.split(".");
    const signature = Buffer.from(parts[2]!, "base64url");
    signature[0] = signature[0]! ^ 0xff;
    expect(() => authority.verify({
      token: `${parts[0]}.${parts[1]}.${signature.toString("base64url")}`,
      now: new Date("2026-07-11T18:00:30.000Z"),
    })).toThrow(/signature/);
    expect(() => authority.verify({
      token: `${parts[0]}.${parts[1]}=.${parts[2]}`,
      now: new Date("2026-07-11T18:00:30.000Z"),
    })).toThrow(/encoding/);
  });

  it("rejects expired and not-yet-active tokens", () => {
    const authority = new PluginToolTurnTokenAuthority(Buffer.alloc(32, 0x43));
    const { token } = issue(authority);
    expect(() => authority.verify({
      token,
      now: new Date("2026-07-11T17:59:59.999Z"),
    })).toThrow(/expired or not active/);
    expect(() => authority.verify({
      token,
      now: new Date("2026-07-11T18:01:00.000Z"),
    })).toThrow(/expired or not active/);
  });

  it("invalidates tokens after registry or permission revision changes", () => {
    const registryAuthority = new PluginToolTurnTokenAuthority(Buffer.alloc(32, 0x44));
    const registryToken = issue(registryAuthority).token;
    setPluginEnabled("com.homerail.topic-outline", false);
    expect(() => registryAuthority.verify({
      token: registryToken,
      now: new Date("2026-07-11T18:00:30.000Z"),
    })).toThrow(/context is stale/);

    setPluginEnabled("com.homerail.topic-outline", true);
    const permissionAuthority = new PluginToolTurnTokenAuthority(Buffer.alloc(32, 0x45));
    const permissionToken = issue(permissionAuthority).token;
    setPluginGrantStatus({
      plugin_id: "com.example.turn-permission",
      plugin_version: "0.1.0",
      permission: "artifact.read",
      status: "granted",
      expected_revision: 1,
      actor_type: "operator",
      actor_id: "turn-token-test",
    });
    expect(() => permissionAuthority.verify({
      token: permissionToken,
      now: new Date("2026-07-11T18:00:30.000Z"),
    })).toThrow(/context is stale/);
  });

  it("refuses a caller-shaped context that omits an asset from the selected capability", () => {
    const authority = new PluginToolTurnTokenAuthority(Buffer.alloc(32, 0x46));
    const incomplete = structuredClone(selectedContext());
    incomplete.tools = [];
    incomplete.context_digest = pluginJsonDigest(homerailPluginTurnContextDigestInput(incomplete));
    expect(() => authority.issue({
      context: incomplete,
      modality: "voice",
      scope: { type: "voice_session", id: "voice-turn-session" },
      generative_ui_mode: "prefer",
    })).toThrow(/exact current routed selection/);
  });
});
