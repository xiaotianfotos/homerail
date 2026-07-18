/**
 * Artifact references are passive identifiers or locations. They are never
 * executable URLs, data URLs, protocol-relative URLs, or network share paths.
 */

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const HTTP_URI = /^https?:\/\/[^\s\\]+$/i;
const ARTIFACT_URI = /^artifact:[A-Za-z0-9][A-Za-z0-9._~/%-]*$/i;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/](?![\\/])[^\u0000-\u001f\u007f]*$/;
const DAG_ACTOR_MEDIA_PREVIEW_URI = /^\/api\/runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}\/artifacts\/actor-media-[a-f0-9]{64}\.(?:avif|gif|jpg|png|webp|mp4|webm|mp3|m4a|ogg|wav|weba)\/content$/i;

/** Navigable external references are limited to credential-free HTTP(S). */
export function isSafeGenerativeUiExternalUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) return false;
  if (value !== value.trim() || CONTROL_CHARACTER.test(value) || !HTTP_URI.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

export function isSafeGenerativeUiArtifactUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) return false;
  if (value !== value.trim() || CONTROL_CHARACTER.test(value)) return false;

  // Browsers normalize every slash/backslash pair here into a network URL.
  if (/^[\\/]{2}/.test(value) || value.startsWith("\\")) return false;

  if (HTTP_URI.test(value)) return isSafeGenerativeUiExternalUri(value);
  if (/^https?:/i.test(value)) return false;
  if (ARTIFACT_URI.test(value)) return true;
  if (/^artifact:/i.test(value)) return false;
  if (WINDOWS_DRIVE_PATH.test(value)) return true;

  // A colon would introduce an unrecognized scheme. A single leading slash is
  // a local absolute path; a leading backslash is rejected above.
  return !value.includes(":");
}

/** Browser-renderable Artifact URLs are narrower than passive file refs. */
export function isSafeGenerativeUiPreviewUri(value: unknown): value is string {
  if (!isSafeGenerativeUiArtifactUri(value)) return false;
  if (value.startsWith("/")) {
    const pathOnly = value.split(/[?#]/, 1)[0];
    try {
      if (pathOnly.split("/").some((segment) => {
        const decoded = decodeURIComponent(segment);
        return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
      })) return false;
    } catch {
      return false;
    }
  }
  return /^https?:\/\//i.test(value)
    || /^\/api\/voice-agent\/sessions\/[^/?#]+\/artifacts\/(?:preview|[^/?#]+|by-id\/[^/?#]+\/preview)(?:[?#].*)?$/i.test(value)
    || /^\/artifacts\/[^/]+\/[^/]+\/preview(?:[?#].*)?$/i.test(value)
    || /^\/api\/plugins\/artifacts\/[^/]+\/[^/]+\/[a-f0-9]{64}$/i.test(value)
    || DAG_ACTOR_MEDIA_PREVIEW_URI.test(value);
}
