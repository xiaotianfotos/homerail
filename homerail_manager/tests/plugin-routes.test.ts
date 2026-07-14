import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHrpArchive,
  buildSignedHrpArchive,
  scaffoldPluginProject,
  scanPluginSource,
  sourceFilesForPack,
} from "homerail-plugin-sdk";
import { subscribe, type PluginRegistryChangedPayload } from "../src/events/bus.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { listPluginPackages } from "../src/persistence/plugins.js";
import { HomerailPluginRegistry } from "../src/plugins/registry.js";
import { createServer } from "../src/server/http.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function chunkedRequest(urlValue: string, body: Buffer): Promise<number> {
  const url = new URL(urlValue);
  return new Promise<number>((resolve, reject) => {
    const request = http.request({
      host: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end(body);
  });
}

describe("plugin registry routes", () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpHome: string;
  let previousHome: string | undefined;
  let previousAutostart: string | undefined;

  beforeEach(async () => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    previousAutostart = process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-plugin-routes-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    server = createServer(0, undefined, undefined, false);
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
  });

  afterEach(async () => {
    if (server.listening) await close(server);
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    if (previousAutostart === undefined) delete process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    else process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = previousAutostart;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("lists, caches, disables, persists, and re-enables an optional builtin", async () => {
    const first = await fetch(`${baseUrl}/api/plugins`);
    const firstEtag = first.headers.get("etag")!;
    const firstBody = await first.json() as { data: { registry_fingerprint: string; plugins: Array<Record<string, unknown>> } };
    expect(first.status).toBe(200);
    expect(firstBody.data.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "com.homerail.core", enabled: true, locked: true }),
      expect.objectContaining({ id: "com.homerail.topic-outline", enabled: true, locked: false }),
    ]));
    expect((await fetch(`${baseUrl}/api/plugins`, { headers: { "If-None-Match": firstEtag } })).status).toBe(304);

    const enabledContextResponse = await fetch(`${baseUrl}/api/plugins/context`);
    const enabledContext = await enabledContextResponse.json() as {
      data: { skills: Array<{ plugin_id: string; plugin_version: string; qualified_id: string; digest: string }> };
    };
    const topicSkill = enabledContext.data.skills.find((skill) => skill.plugin_id === "com.homerail.topic-outline")!;
    const localOnly = await (await fetch(`${baseUrl}/api/skills?local_only=1`)).json() as {
      data: { skills: Array<{ source: string }> };
    };
    expect(localOnly.data.skills.some((skill) => skill.source === "plugin")).toBe(false);

    const events: PluginRegistryChangedPayload[] = [];
    const unsubscribe = subscribe("plugin:registry_changed", (payload) => {
      events.push(payload as PluginRegistryChangedPayload);
    });
    const disabled = await fetch(`${baseUrl}/api/plugins/com.homerail.topic-outline/enabled`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, expected_revision: 1, expected_active_version: "1.0.0" }),
    });
    unsubscribe();
    expect(disabled.status).toBe(200);
    expect(events).toEqual([expect.objectContaining({
      plugin_id: "com.homerail.topic-outline",
      enabled: false,
    })]);

    const changed = await fetch(`${baseUrl}/api/plugins`, { headers: { "If-None-Match": firstEtag } });
    const changedEtag = changed.headers.get("etag")!;
    const changedBody = await changed.json() as { data: { registry_fingerprint: string; plugins: Array<Record<string, unknown>> } };
    expect(changed.status).toBe(200);
    expect(changedEtag).not.toBe(firstEtag);
    expect(changedBody.data.registry_fingerprint).not.toBe(firstBody.data.registry_fingerprint);
    expect(changedBody.data.plugins).toContainEqual(expect.objectContaining({
      id: "com.homerail.topic-outline",
      enabled: false,
      activation_revision: 2,
    }));
    expect((await fetch(`${baseUrl}/api/plugins`, { headers: { "If-None-Match": changedEtag } })).status).toBe(304);

    const context = await (await fetch(`${baseUrl}/api/plugins/context`)).json() as {
      data: { skills: Array<{ plugin_id: string }>; tools: Array<{ plugin_id: string }> };
    };
    expect(context.data.skills.some((skill) => skill.plugin_id === "com.homerail.topic-outline")).toBe(false);
    expect(context.data.tools.some((tool) => tool.plugin_id === "com.homerail.topic-outline")).toBe(false);
    expect((await fetch(`${baseUrl}/api/skills/${encodeURIComponent(topicSkill.qualified_id)}`)).status).toBe(404);
    const exactSkill = await fetch(
      `${baseUrl}/api/skills/${encodeURIComponent(topicSkill.qualified_id)}`
      + `?plugin_version=${encodeURIComponent(topicSkill.plugin_version)}&digest=${topicSkill.digest}`,
    );
    const exactSkillBody = await exactSkill.json() as { data: { content: string; digest: string } };
    expect(exactSkill.status).toBe(200);
    expect(exactSkillBody.data.digest).toBe(topicSkill.digest);
    expect(exactSkillBody.data.content).toContain("# Topic Outline");
    expect((await fetch(
      `${baseUrl}/api/skills/${encodeURIComponent(topicSkill.qualified_id)}`
      + `?plugin_version=1.0.0-beta.1&digest=${topicSkill.digest}`,
    )).status).toBe(404);
    expect((await fetch(
      `${baseUrl}/api/skills/${encodeURIComponent(topicSkill.qualified_id)}`
      + `?plugin_version=1.0&digest=${topicSkill.digest}`,
    )).status).toBe(400);

    const uiResponse = await fetch(`${baseUrl}/api/plugins/ui-registry`);
    const uiEtag = uiResponse.headers.get("etag")!;
    const ui = await uiResponse.json() as {
      data: { kinds: Array<Record<string, unknown>>; renderers: Array<Record<string, unknown>> };
    };
    expect(ui.data.kinds).toContainEqual(expect.objectContaining({
      kind: "com.homerail.topic-outline/outline",
      enabled: false,
    }));
    expect(ui.data.renderers).toContainEqual(expect.objectContaining({
      renderer_id: "topic-outline-main",
      enabled: false,
    }));
    expect((await fetch(`${baseUrl}/api/plugins/ui-registry`, { headers: { "If-None-Match": uiEtag } })).status)
      .toBe(304);

    closeDb();
    expect(new HomerailPluginRegistry().snapshot().plugins.find((plugin) => (
      plugin.plugin_id === "com.homerail.topic-outline"
    ))?.activation).toMatchObject({ enabled: false, revision: 2 });

    const enabled = await fetch(`${baseUrl}/api/plugins/com.homerail.topic-outline/enabled`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, expected_revision: 2, expected_active_version: "1.0.0" }),
    });
    expect(enabled.status).toBe(200);
  });

  it("rejects locked, unknown, malformed, and unsupported activation requests", async () => {
    expect((await fetch(`${baseUrl}/api/plugins/com.homerail.core/enabled`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, expected_revision: 1, expected_active_version: "0.1.0" }),
    })).status).toBe(409);
    expect((await fetch(`${baseUrl}/api/plugins/com.example.missing/enabled`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, expected_revision: 1, expected_active_version: "1.0.0" }),
    })).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/plugins/com.homerail.topic-outline/enabled`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "no", expected_revision: 1, expected_active_version: "1.0.0" }),
    })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/plugins/com.homerail.topic-outline/enabled`, {
      method: "POST",
    })).status).toBe(405);
  });

  it("commits activation and notifies later subscribers when one event listener fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const delivered: PluginRegistryChangedPayload[] = [];
    const unsubscribeThrowing = subscribe("plugin:registry_changed", () => {
      throw new Error("broken event sink");
    });
    const unsubscribeHealthy = subscribe("plugin:registry_changed", (payload) => {
      delivered.push(payload as PluginRegistryChangedPayload);
    });
    try {
      const response = await fetch(`${baseUrl}/api/plugins/com.homerail.topic-outline/enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false, expected_revision: 1, expected_active_version: "1.0.0" }),
      });
      expect(response.status).toBe(200);
      expect(delivered).toEqual([expect.objectContaining({
        plugin_id: "com.homerail.topic-outline",
        enabled: false,
      })]);
      expect(error).toHaveBeenCalledWith(
        "event listener failed for plugin:registry_changed",
        expect.any(Error),
      );
      expect(new HomerailPluginRegistry().snapshot().plugins.find((plugin) => (
        plugin.plugin_id === "com.homerail.topic-outline"
      ))?.activation.enabled).toBe(false);
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    } finally {
      unsubscribeThrowing();
      unsubscribeHealthy();
      error.mockRestore();
    }
  });

  it("returns a structured 500 for corrupted registry state without terminating the server", async () => {
    expect((await fetch(`${baseUrl}/api/plugins`)).status).toBe(200);
    getDb().prepare(`
      UPDATE plugin_packages SET resolved_descriptor_json = ? WHERE plugin_id = ?
    `).run("{}", "com.homerail.topic-outline");

    const failed = await fetch(`${baseUrl}/api/plugins`);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      success: false,
      error: "Plugin registry is unavailable",
    });
    expect((await fetch(`${baseUrl}/api/plugins/com.homerail.topic-outline/versions`)).status).toBe(500);
    expect((await fetch(`${baseUrl}/api/plugins/com.homerail.topic-outline/doctor`)).status).toBe(500);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it("installs a binary HRP, keeps upgrades inactive, rolls back, and uninstalls with history retained", async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-plugin-route-source-"));
    try {
      scaffoldPluginProject(source, "com.example.release-notes", { name: "Release Notes", version: "1.0.0" });
      const pack = (): Buffer => buildHrpArchive(sourceFilesForPack(scanPluginSource(source))).archive;
      const install = async (archive: Buffer) => fetch(`${baseUrl}/api/plugins/install?channel=staging`, {
        method: "POST",
        headers: { "Content-Type": "application/vnd.homerail.plugin+zip" },
        body: archive,
      });

      const initialArchive = pack();
      expect((await fetch(`${baseUrl}/api/plugins/install?channel=registry`, {
        method: "POST",
        headers: { "Content-Type": "application/vnd.homerail.plugin+zip" },
        body: initialArchive,
      })).status).toBe(400);
      expect(listPluginPackages().some((plugin) => plugin.plugin_id === "com.example.release-notes")).toBe(false);

      const first = await install(initialArchive);
      expect(first.status).toBe(201);
      expect(await first.json()).toMatchObject({
        data: {
          plugin_id: "com.example.release-notes",
          plugin_version: "1.0.0",
          data_only_eligible: true,
          m5_projection_action_eligible: false,
          m5_projection_action_eligibility_reasons: ["projection_action_required"],
          activation: { active_version: "1.0.0", enabled: false, revision: 1 },
          installation: { lifecycle_state: "installed", health_state: "healthy" },
        },
      });
      const repeated = await install(pack());
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toMatchObject({
        data: {
          idempotent: true,
          activation: { active_version: "1.0.0", enabled: false, revision: 1 },
        },
      });
      const versions = await (await fetch(`${baseUrl}/api/plugins/com.example.release-notes/versions`)).json() as {
        data: { version_set_digest: string; versions: Array<Record<string, unknown>> };
      };
      expect(versions.data.versions[0]).not.toHaveProperty("descriptor");
      expect(versions.data.versions[0]).not.toHaveProperty("package_path");

      expect((await fetch(`${baseUrl}/api/plugins/com.example.release-notes/enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, expected_revision: 1, expected_active_version: "1.0.0" }),
      })).status).toBe(200);
      const beforeUpgrade = await (await fetch(`${baseUrl}/api/plugins/com.example.release-notes/versions`)).json() as {
        data: { version_set_digest: string };
      };

      const manifestFile = path.join(source, "homerail.plugin.json");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
      manifest.version = "1.1.0";
      fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
      const second = await install(pack());
      expect(second.status).toBe(201);
      expect(await second.json()).toMatchObject({
        data: { activation: { active_version: "1.0.0", enabled: true, revision: 2 } },
      });
      expect((await fetch(`${baseUrl}/api/plugins/com.example.release-notes`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_version_set_digest: beforeUpgrade.data.version_set_digest }),
      })).status).toBe(409);
      expect(fs.existsSync(path.join(tmpHome, "plugins", ".trash"))).toBe(false);

      expect((await fetch(`${baseUrl}/api/plugins/com.example.release-notes/active-version`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "1.1.0", expected_revision: 2 }),
      })).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/plugins/com.example.release-notes/enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, expected_revision: 2, expected_active_version: "1.0.0" }),
      })).status).toBe(409);
      expect((await fetch(`${baseUrl}/api/plugins/com.example.release-notes/enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, expected_revision: 3, expected_active_version: "1.1.0" }),
      })).status).toBe(200);
      const rollback = await fetch(`${baseUrl}/api/plugins/com.example.release-notes/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "1.0.0", expected_revision: 4 }),
      });
      expect(rollback.status).toBe(200);
      expect(await rollback.json()).toMatchObject({
        data: { activation: { active_version: "1.0.0", enabled: true, revision: 5 } },
      });
      expect((await fetch(`${baseUrl}/api/plugins/com.example.release-notes/doctor`)).status).toBe(200);

      const beforeRemove = await (await fetch(`${baseUrl}/api/plugins/com.example.release-notes/versions`)).json() as {
        data: { version_set_digest: string };
      };
      const registryBeforeRemove = await (await fetch(`${baseUrl}/api/plugins`)).json() as {
        data: { registry_revision: number };
      };
      const removed = await fetch(`${baseUrl}/api/plugins/com.example.release-notes`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_version_set_digest: beforeRemove.data.version_set_digest }),
      });
      expect(removed.status).toBe(200);
      const removedBody = await removed.json() as {
        data: { registry: { registry_revision: number; plugins: Array<{ id: string }> } };
      };
      expect(removedBody.data.registry.registry_revision).toBeGreaterThan(
        registryBeforeRemove.data.registry_revision,
      );
      expect(removedBody.data.registry.plugins.some((plugin) => (
        plugin.id === "com.example.release-notes"
      ))).toBe(false);
      expect(new HomerailPluginRegistry().snapshot().plugins.some((plugin) => (
        plugin.plugin_id === "com.example.release-notes"
      ))).toBe(false);
      const historicalDoctor = await fetch(`${baseUrl}/api/plugins/com.example.release-notes/doctor`);
      expect(historicalDoctor.status).toBe(200);
      expect(await historicalDoctor.json()).toMatchObject({
        success: false,
        data: { installed: false, healthy: false },
      });
      expect(listPluginPackages()).toContainEqual(expect.objectContaining({
        plugin_id: "com.example.release-notes",
        plugin_version: "1.0.0",
      }));
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("trusts a publisher, installs a signed package, and revokes it fail-closed", async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-signed-registry-route-"));
    try {
      scaffoldPluginProject(source, "com.example.signed-registry", { version: "1.0.0" });
      const { privateKey } = generateKeyPairSync("ed25519");
      const signed = buildSignedHrpArchive(sourceFilesForPack(scanPluginSource(source)), {
        publisher: "com.example",
        private_key: privateKey,
      });
      const install = () => fetch(`${baseUrl}/api/plugins/install?channel=staging`, {
        method: "POST",
        headers: { "Content-Type": "application/vnd.homerail.plugin+zip" },
        body: signed.archive,
      });

      const publishers = await fetch(`${baseUrl}/api/plugins/publishers`);
      expect(publishers.status).toBe(200);
      expect(await publishers.json()).toMatchObject({ data: { revision: 0, publishers: [], events: [] } });
      const trusted = await fetch(
        `${baseUrl}/api/plugins/publishers/${encodeURIComponent(signed.signature.key_id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            publisher: signed.signature.publisher,
            public_key_spki: signed.signature.public_key_spki,
            state: "trusted",
            expected_revision: 0,
          }),
        },
      );
      expect(trusted.status).toBe(200);
      expect(await trusted.json()).toMatchObject({
        data: {
          trust: { record: { state: "trusted", revision: 1 }, distribution_revision: 1 },
          reconciliation: { checked: 0, failures: [] },
        },
      });

      const installed = await install();
      expect(installed.status).toBe(201);
      const installedBody = await installed.json() as {
        data: { activation: { revision: number; active_version: string } };
      };
      expect(installedBody).toMatchObject({
        data: { installation: { channel: "staging", signature_state: "verified", health_state: "healthy" } },
      });
      expect((await fetch(`${baseUrl}/api/plugins/com.example.signed-registry/enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          expected_revision: installedBody.data.activation.revision,
          expected_active_version: installedBody.data.activation.active_version,
        }),
      })).status).toBe(200);

      const revoked = await fetch(
        `${baseUrl}/api/plugins/publishers/${encodeURIComponent(signed.signature.key_id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            publisher: signed.signature.publisher,
            public_key_spki: signed.signature.public_key_spki,
            state: "revoked",
            expected_revision: 1,
            reason: "publisher key compromised",
          }),
        },
      );
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({
        data: {
          revoked_packages: [{
            plugin_id: "com.example.signed-registry",
            plugin_version: "1.0.0",
            disabled: true,
          }],
          reconciliation: { failures: [] },
        },
      });
      const versions = await (await fetch(
        `${baseUrl}/api/plugins/com.example.signed-registry/versions`,
      )).json() as { data: { activation: { revision: number; active_version: string }; versions: unknown[] } };
      expect(versions.data.versions).toEqual([
        expect.objectContaining({
          enabled: false,
          installation: expect.objectContaining({ signature_state: "revoked", health_state: "unhealthy" }),
        }),
      ]);
      expect((await fetch(`${baseUrl}/api/plugins/com.example.signed-registry/enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          expected_revision: versions.data.activation.revision,
          expected_active_version: versions.data.activation.active_version,
        }),
      })).status).toBe(409);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("installs, enables, selects, and resolves an immutable Workflow HRP without executing plugin content", async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workflow-route-source-"));
    const pluginId = "com.example.workflow-http";
    const version = "1.0.0";
    const capabilityId = `${pluginId}:compose-card`;
    const workflowUri = `plugin://${pluginId}/workflows/compose-card`;
    const workflowFile = path.join(source, "workflows/compose-card.yaml");
    const originalContent = "workflow_version: 1\nid: compose-card\nsteps:\n  - literal: never-execute-during-resolution\n";
    try {
      scaffoldPluginProject(source, pluginId, { name: "Workflow HTTP", version });
      const manifestFile = path.join(source, "homerail.plugin.json");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
        capabilities: Array<{ tools: string[]; workflows: string[] }>;
        tools: Array<Record<string, unknown>>;
        workflows: Array<Record<string, unknown>>;
      };
      manifest.capabilities[0].tools = [];
      manifest.capabilities[0].workflows = ["compose-card"];
      manifest.tools = [];
      manifest.workflows = [{
        id: "compose-card",
        uri: workflowUri,
        file: "workflows/compose-card.yaml",
        effect: "read",
        permissions: [],
        confirmation: "never",
      }];
      fs.mkdirSync(path.dirname(workflowFile), { recursive: true });
      fs.writeFileSync(workflowFile, originalContent);
      fs.rmSync(path.join(source, "ui/projectors/card.v1.json"));
      fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
      const snapshot = scanPluginSource(source);
      expect(snapshot).toMatchObject({
        valid: true,
        m4_data_only_eligible: false,
        m5_workflow_resolution_eligible: true,
        m5_workflow_resolution_eligibility_reasons: [],
      });
      const archive = buildHrpArchive(sourceFilesForPack(snapshot)).archive;

      const installedResponse = await fetch(`${baseUrl}/api/plugins/install?channel=staging`, {
        method: "POST",
        headers: { "Content-Type": "application/vnd.homerail.plugin+zip" },
        body: archive,
      });
      expect(installedResponse.status).toBe(201);
      const installedBody = await installedResponse.json() as {
        data: { package_digest: string; installation: Record<string, unknown> };
      };
      expect(installedBody).toMatchObject({
        data: {
          plugin_id: pluginId,
          plugin_version: version,
          data_only_eligible: false,
          m5_projection_action_eligible: false,
          m5_workflow_resolution_eligible: true,
          m5_workflow_resolution_eligibility_reasons: [],
          installation: { lifecycle_state: "installed", health_state: "healthy" },
          activation: { active_version: version, enabled: false, revision: 1 },
        },
      });
      const descriptorBefore = getDb().prepare(`
        SELECT resolved_descriptor_json FROM plugin_packages
        WHERE plugin_id = ? AND plugin_version = ?
      `).get(pluginId, version) as { resolved_descriptor_json: string };

      fs.writeFileSync(workflowFile, "id: source-mutated-after-install\n");
      const enabled = await fetch(`${baseUrl}/api/plugins/${pluginId}/enabled`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, expected_revision: 1, expected_active_version: version }),
      });
      expect(enabled.status).toBe(200);
      const listed = await (await fetch(`${baseUrl}/api/plugins`)).json() as {
        data: { registry_fingerprint: string; plugins: Array<{ id: string; workflows: string[] }> };
      };
      expect(listed.data.plugins.find((plugin) => plugin.id === pluginId)?.workflows)
        .toEqual(["compose-card"]);

      const selected = await fetch(`${baseUrl}/api/plugins/capabilities/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          utterance: "compose this workflow card",
          modality: "text",
          inputs: { title: "HTTP Workflow" },
          explicit_plugin_id: pluginId,
          explicit_capability_id: capabilityId,
          top_k: 1,
        }),
      });
      const selectedBody = await selected.json() as {
        data: {
          selected: Array<{ capability_id: string }>;
          selected_context: { tools: unknown[]; actions: unknown[] };
        };
      };
      expect(selected.status).toBe(200);
      expect(selectedBody.data.selected).toEqual([expect.objectContaining({ capability_id: capabilityId })]);
      expect(selectedBody.data.selected_context).toMatchObject({ tools: [], actions: [] });

      const rejectedCallerContext = await fetch(`${baseUrl}/api/plugins/workflows/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uri: workflowUri,
          capability_id: capabilityId,
          selection: {
            utterance: "compose this workflow card",
            inputs: { title: "HTTP Workflow" },
            selected_context: { caller_supplied: true },
          },
        }),
      });
      expect(rejectedCallerContext.status).toBe(400);

      const resolved = await fetch(`${baseUrl}/api/plugins/workflows/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uri: workflowUri,
          capability_id: capabilityId,
          selection: {
            utterance: "compose this workflow card",
            modality: "text",
            inputs: { title: "HTTP Workflow" },
          },
        }),
      });
      const resolvedBody = await resolved.json() as {
        data: {
          selection: { manager_owned: boolean; capability_id: string; selected_context_digest: string };
          resolution: {
            content: string;
            content_digest: string;
            package_digest: string;
            activation_revision: number;
          };
        };
      };
      expect(resolved.status).toBe(200);
      expect(resolvedBody.data.selection).toMatchObject({
        manager_owned: true,
        capability_id: capabilityId,
        selected_context_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(resolvedBody.data.selection).not.toHaveProperty("selected_context");
      expect(resolvedBody.data.resolution).toMatchObject({
        content: originalContent,
        content_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        package_digest: installedBody.data.package_digest,
        activation_revision: 2,
      });
      expect((await fetch(`${baseUrl}/api/plugins/${pluginId}/doctor`)).status).toBe(200);
      const descriptorAfter = getDb().prepare(`
        SELECT resolved_descriptor_json FROM plugin_packages
        WHERE plugin_id = ? AND plugin_version = ?
      `).get(pluginId, version) as { resolved_descriptor_json: string };
      expect(descriptorAfter).toEqual(descriptorBefore);
      const registryAfterResolution = await (await fetch(`${baseUrl}/api/plugins`)).json() as {
        data: { registry_fingerprint: string };
      };
      expect(registryAfterResolution.data.registry_fingerprint).toBe(listed.data.registry_fingerprint);
      expect(getDb().prepare("SELECT COUNT(*) AS count FROM dag_workflows").get()).toEqual({ count: 0 });
      expect(getDb().prepare("SELECT COUNT(*) AS count FROM plugin_action_requests").get()).toEqual({ count: 0 });
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("rejects malformed or non-binary plugin installs without persistent side effects", async () => {
    expect(await chunkedRequest(
      `${baseUrl}/api/plugins/com.homerail.topic-outline/enabled`,
      Buffer.alloc(9 * 1024, 0x61),
    )).toBe(413);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/plugins/invalid%2Fescape`, { method: "DELETE" })).status).toBe(400);
    expect(fs.existsSync(path.join(tmpHome, "plugins", ".trash"))).toBe(false);
    expect((await fetch(`${baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })).status).toBe(415);
    expect((await fetch(`${baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.homerail.plugin+zip" },
      body: Buffer.from("not-a-zip"),
    })).status).toBe(400);
    expect(listPluginPackages().some((plugin) => plugin.plugin_id.startsWith("com.example"))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, "plugins", ".staging"))
      ? fs.readdirSync(path.join(tmpHome, "plugins", ".staging"))
      : []).toEqual([]);
  });
});
