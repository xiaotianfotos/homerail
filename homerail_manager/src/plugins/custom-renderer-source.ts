import { createHash } from "node:crypto";
import { decodeHomerailPluginUtf8 } from "homerail-protocol";
import { getActivePlugin } from "../persistence/plugins.js";
import { ensureBuiltinPluginsSynced } from "./registry.js";

export interface HomerailCustomRendererSourceV1 {
  bridge_api: 1;
  renderer_api: 1;
  plugin_id: string;
  plugin_version: string;
  manifest_digest: string;
  renderer_id: string;
  file: string;
  digest: string;
  media_type: "text/javascript";
  content: string;
}

/**
 * Reads only an enabled, exact active Renderer from immutable descriptor bytes.
 * The returned source is data: Manager never evaluates or imports it.
 */
export function readActiveCustomRendererSource(input: {
  plugin_id: string;
  plugin_version: string;
  renderer_id: string;
  digest: string;
}): HomerailCustomRendererSourceV1 | undefined {
  ensureBuiltinPluginsSynced();
  const plugin = getActivePlugin(input.plugin_id);
  if (
    !plugin
    || !plugin.activation.enabled
    || plugin.plugin_version !== input.plugin_version
  ) return undefined;
  const renderer = plugin.descriptor.manifest.renderers.find((candidate) => (
    candidate.id === input.renderer_id
    && candidate.renderer_api === 1
    && candidate.mode === "custom"
    && candidate.source.type === "custom"
  ));
  if (!renderer || renderer.source.type !== "custom") return undefined;
  const rendererFile = renderer.source.file;
  const archived = plugin.descriptor.referenced_files.find((candidate) => (
    candidate.path === rendererFile
  ));
  if (!archived || archived.digest !== input.digest) return undefined;
  const bytes = Buffer.from(archived.content, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== archived.digest) {
    throw new Error(`Archived custom Renderer digest mismatch: ${input.plugin_id}:${input.renderer_id}`);
  }
  const content = decodeHomerailPluginUtf8(bytes, rendererFile);
  if (!content.trim()) throw new Error(`Archived custom Renderer is empty: ${input.plugin_id}:${input.renderer_id}`);
  return {
    bridge_api: 1,
    renderer_api: 1,
    plugin_id: plugin.plugin_id,
    plugin_version: plugin.plugin_version,
    manifest_digest: plugin.descriptor.manifest_digest,
    renderer_id: renderer.id,
    file: rendererFile,
    digest: archived.digest,
    media_type: "text/javascript",
    content,
  };
}
