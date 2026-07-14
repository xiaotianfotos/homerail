import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSignedHrpArchive,
  buildSignedPluginRegistryIndex,
  scaffoldPluginProject,
  scanPluginSource,
  sourceFilesForPack,
} from "homerail-plugin-sdk";
import { closeDb } from "../src/persistence/db.js";
import { setPluginPublisherTrust } from "../src/persistence/plugin-distribution.js";
import { createServer } from "../src/server/http.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

describe("remote plugin registry routes", () => {
  let server: http.Server;
  let baseUrl: string;
  let home: string;
  let source: string;
  let previousHome: string | undefined;
  let previousAutostart: string | undefined;

  beforeEach(async () => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    previousAutostart = process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-registry-route-home-"));
    source = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-registry-route-source-"));
    process.env.HOMERAIL_HOME = home;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    server = createServer(0, undefined, undefined, false);
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
  });

  afterEach(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    if (previousAutostart === undefined) delete process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    else process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = previousAutostart;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  });

  it("configures, synchronizes, installs, and explicitly activates a signed release", async () => {
    scaffoldPluginProject(source, "com.example.registry-route", { version: "1.0.0" });
    const publisher = generateKeyPairSync("ed25519");
    const signed = buildSignedHrpArchive(sourceFilesForPack(scanPluginSource(source)), {
      publisher: "com.example",
      private_key: publisher.privateKey,
    });
    setPluginPublisherTrust({
      entry: {
        publisher: signed.signature.publisher,
        key_id: signed.signature.key_id,
        public_key_spki: signed.signature.public_key_spki,
        state: "trusted",
      },
      actor: "route-test",
    });
    const root = generateKeyPairSync("ed25519");
    const now = Date.now();
    const index = buildSignedPluginRegistryIndex({
      registry_id: "stable.route",
      sequence: 1,
      issued_at: new Date(now - 60_000).toISOString(),
      expires_at: new Date(now + 86_400_000).toISOString(),
      releases: [{
        plugin_id: signed.lock.plugin.id,
        plugin_version: signed.lock.plugin.version,
        archive_path: "releases/registry-route-1.0.0.hrp",
        archive_digest: signed.archive_digest,
        payload_digest: signed.lock.payload_digest,
        publisher_key_id: signed.signature.key_id,
      }],
    }, { private_key: root.privateKey });

    const configured = await fetch(`${baseUrl}/api/plugins/registries/stable.route/source`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_url: "https://registry.example/index.json",
        root_key_id: index.root_pin,
      }),
    });
    expect(configured.status).toBe(200);
    expect(await configured.json()).toMatchObject({
      data: { source: { registry_id: "stable.route", last_sequence: 0, root_key_id: index.root_pin } },
    });

    const synced = await fetch(`${baseUrl}/api/plugins/registries/stable.route/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index_base64: index.bytes.toString("base64url") }),
    });
    expect(synced.status).toBe(200);
    expect(await synced.json()).toMatchObject({
      data: {
        source: { last_sequence: 1, last_index_digest: index.index_digest },
        releases: [{ plugin_id: "com.example.registry-route", plugin_version: "1.0.0" }],
      },
    });

    const installed = await fetch(
      `${baseUrl}/api/plugins/registries/stable.route/releases/com.example.registry-route/1.0.0/install`,
      {
        method: "POST",
        headers: { "Content-Type": "application/vnd.homerail.plugin+zip" },
        body: signed.archive,
      },
    );
    expect(installed.status).toBe(201);
    const installedBody = await installed.json() as {
      data: { staged: boolean; installed: { activation: { revision: number; enabled: boolean } } };
    };
    expect(installedBody).toMatchObject({
      data: {
        staged: true,
        installed: {
          installation: { channel: "registry", signature_state: "verified" },
          activation: { active_version: "1.0.0", enabled: false },
        },
      },
    });

    const activated = await fetch(
      `${baseUrl}/api/plugins/registries/stable.route/releases/com.example.registry-route/1.0.0/activate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_revision: installedBody.data.installed.activation.revision }),
      },
    );
    expect(activated.status).toBe(200);
    const activatedBody = await activated.json() as {
      data: { activation: { revision: number; active_version: string } };
    };
    const genericEnable = await fetch(`${baseUrl}/api/plugins/com.example.registry-route/enabled`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        expected_revision: activatedBody.data.activation.revision,
        expected_active_version: activatedBody.data.activation.active_version,
      }),
    });
    expect(genericEnable.status).toBe(400);
    const enabled = await fetch(
      `${baseUrl}/api/plugins/registries/stable.route/plugins/com.example.registry-route/enabled`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          expected_revision: activatedBody.data.activation.revision,
          expected_active_version: activatedBody.data.activation.active_version,
        }),
      },
    );
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ data: { activation: { enabled: true } } });
    const state = await fetch(`${baseUrl}/api/plugins/registries/stable.route`);
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      data: {
        attempts: expect.arrayContaining([
          expect.objectContaining({ operation: "sync", status: "succeeded" }),
          expect.objectContaining({ operation: "install", status: "succeeded" }),
          expect.objectContaining({ operation: "activate", status: "succeeded" }),
        ]),
      },
    });
  });
});
