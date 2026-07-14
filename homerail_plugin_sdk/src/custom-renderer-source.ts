import { decodeHomerailPluginUtf8 } from "homerail-protocol";

export const HOMERAIL_CUSTOM_RENDERER_SOURCE_MAX_BYTES = 512 * 1024;

const FORBIDDEN_CONTROL_CHARACTERS = /[\u0000\u000b\u000c\u000e-\u001f\u007f]/;
const IMPORT_TOKEN = /\bimport\b/;
const EXPORT_TOKEN = /\bexport\b/g;
const RENDER_EXPORT = /\bexport\s+(?:async\s+)?function\s+render\s*\(\s*payload\s*\)\s*\{/;

/**
 * Validates the install-time half of the isolated Worker Renderer contract.
 *
 * Renderer modules are deliberately UTF-8, bounded, single-file modules.
 * Rejecting every import token closes both static/re-export loaders and
 * dynamic network imports. Requiring one exact named export keeps the PDK,
 * package verifier, Manager and browser bridge on the same entrypoint shape.
 * The returned source is inert text and is never evaluated by this validator.
 */
export function validatePluginCustomRendererSource(
  content: Uint8Array,
  label = "Custom Renderer ES module",
): string {
  if (content.byteLength > HOMERAIL_CUSTOM_RENDERER_SOURCE_MAX_BYTES) {
    throw new Error(`${label} exceeds ${HOMERAIL_CUSTOM_RENDERER_SOURCE_MAX_BYTES} bytes`);
  }
  const source = decodeHomerailPluginUtf8(content, label);
  if (!source.trim()) throw new Error(`${label} cannot be empty`);
  if (FORBIDDEN_CONTROL_CHARACTERS.test(source)) {
    throw new Error(`${label} contains forbidden control characters`);
  }
  if (IMPORT_TOKEN.test(source)) {
    throw new Error(`${label} imports are forbidden; Custom Renderers must be single-file modules`);
  }
  const exports = source.match(EXPORT_TOKEN) ?? [];
  if (exports.length !== 1 || !RENDER_EXPORT.test(source)) {
    throw new Error(
      `${label} must have exactly one export: export [async] function render(payload)`,
    );
  }
  return source;
}
