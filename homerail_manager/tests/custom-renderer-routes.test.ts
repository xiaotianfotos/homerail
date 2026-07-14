import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffoldPluginProject } from "homerail-plugin-sdk";
import { closeDb } from "../src/persistence/db.js";
import { syncPluginPackage, setPluginEnabled } from "../src/persistence/plugins.js";
import { loadPluginPackage } from "../src/plugins/manifest-loader.js";
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

describe("isolated custom Renderer source route", () => {
  let server: http.Server | undefined;
  let baseUrl: string;
  let home: string;
  let previousHome: string | undefined;
  let previousAutostart: string | undefined;

  beforeEach(async () => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    previousAutostart = process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-custom-renderer-"));
    process.env.HOMERAIL_HOME = home;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    server = createServer(0, undefined, undefined, false);
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
  });

  afterEach(async () => {
    if (server?.listening) await close(server);
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    if (previousAutostart === undefined) delete process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    else process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = previousAutostart;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("projects a digest and reads only the enabled exact immutable source as inert data", async () => {
    const pluginId = "com.example.custom-renderer";
    const root = path.join(home, "source");
    scaffoldPluginProject(root, pluginId, { version: "1.0.0", name: "Custom Renderer" });
    const manifestFile = path.join(root, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      renderers: Array<Record<string, unknown>>;
    };
    manifest.renderers[0] = {
      ...manifest.renderers[0],
      id: "card-custom",
      mode: "custom",
      source: { type: "custom", file: "ui/views/card.mjs" },
    };
    const rendererSource = [
      "export function render(payload) {",
      "  const title = typeof payload.node?.fallback?.title === 'string'",
      "    ? payload.node.fallback.title.slice(0, 120)",
      "    : 'Custom Renderer';",
      "  return {",
      "    version: 'v1.0',",
      "    catalogId: 'https://homerail.dev/a2ui/catalogs/core/v1',",
      "    components: [{ id: 'root', component: 'Text', text: title }],",
      "  };",
      "}",
    ].join("\n");
    fs.writeFileSync(path.join(root, "ui/views/card.mjs"), rendererSource);
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const descriptor = loadPluginPackage(root, { source: "development" });
    syncPluginPackage({ descriptor, source: "development", default_enabled: true });

    const projectedResponse = await fetch(`${baseUrl}/api/plugins/ui-registry`);
    const projected = await projectedResponse.json() as {
      data: { renderers: Array<{
        plugin_id: string;
        renderer_id: string;
        manifest_digest: string;
        source: { type: string; file: string; digest: string };
      }> };
    };
    const renderer = projected.data.renderers.find((entry) => entry.plugin_id === pluginId)!;
    expect(renderer).toMatchObject({
      renderer_id: "card-custom",
      source: { type: "custom", file: "ui/views/card.mjs", digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });

    const sourceUrl = `${baseUrl}/api/plugins/renderers/${pluginId}/card-custom/source`
      + `?plugin_version=1.0.0&digest=${renderer.source.digest}`;
    const sourceResponse = await fetch(sourceUrl);
    const etag = sourceResponse.headers.get("etag")!;
    const source = await sourceResponse.json() as { data: Record<string, unknown> };
    expect(sourceResponse.status).toBe(200);
    expect(sourceResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(sourceResponse.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(sourceResponse.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(source.data).toEqual({
      bridge_api: 1,
      renderer_api: 1,
      plugin_id: pluginId,
      plugin_version: "1.0.0",
      manifest_digest: renderer.manifest_digest,
      renderer_id: "card-custom",
      file: "ui/views/card.mjs",
      digest: renderer.source.digest,
      media_type: "text/javascript",
      content: rendererSource,
    });
    expect((await fetch(sourceUrl, { headers: { "If-None-Match": etag } })).status).toBe(304);

    expect((await fetch(
      `${baseUrl}/api/plugins/renderers/${pluginId}/card-custom/source?plugin_version=1.0.0&digest=${"0".repeat(64)}`,
    )).status).toBe(404);
    expect((await fetch(
      `${baseUrl}/api/plugins/renderers/${pluginId}/card-custom/source?plugin_version=1.0&digest=${renderer.source.digest}`,
    )).status).toBe(400);

    setPluginEnabled(pluginId, false);
    expect((await fetch(sourceUrl)).status).toBe(404);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it("rejects malformed or non-Worker custom Renderer sources before persistence", () => {
    const root = path.join(home, "invalid");
    scaffoldPluginProject(root, "com.example.invalid-custom");
    const manifestFile = path.join(root, "homerail.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      renderers: Array<Record<string, unknown>>;
    };
    manifest.renderers[0] = {
      ...manifest.renderers[0],
      mode: "custom",
      source: { type: "custom", file: "ui/views/empty.js" },
    };
    fs.writeFileSync(path.join(root, "ui/views/empty.js"), " \n");
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => loadPluginPackage(root, { source: "development" })).toThrow(/cannot be empty/);

    manifest.renderers[0] = {
      ...manifest.renderers[0],
      source: { type: "custom", file: "ui/views/not-a-module.html" },
    };
    fs.writeFileSync(path.join(root, "ui/views/not-a-module.html"), "export const render = () => {};\n");
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => loadPluginPackage(root, { source: "development" })).toThrow(/custom Renderer source must be an ES module/i);

    manifest.renderers[0] = {
      ...manifest.renderers[0],
      source: { type: "custom", file: "ui/views/invalid.mjs" },
    };
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    for (const [source, expected] of [
      [
        "export function render({ root }) { root.textContent = 'legacy'; }\n",
        /exactly one export/,
      ],
      [
        "import './remote.mjs';\nexport function render(payload) { return payload; }\n",
        /imports are forbidden/,
      ],
      [
        "export const extra = true;\nexport function render(payload) { return payload; }\n",
        /exactly one export/,
      ],
    ] as const) {
      fs.writeFileSync(path.join(root, "ui/views/invalid.mjs"), source);
      expect(() => loadPluginPackage(root, { source: "development" })).toThrow(expected);
    }
  });
});
