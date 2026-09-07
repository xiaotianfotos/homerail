import net from "node:net";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface UiMutationRequestTrust {
  protocol: "http" | "https";
  host: string | string[] | undefined;
  origin: string | string[] | undefined;
  secFetchSite?: string | string[];
}

export function isProtectedApiMutation(methodValue: string | undefined, urlValue: string | undefined): boolean {
  const method = (methodValue || "GET").toUpperCase();
  if (!MUTATION_METHODS.has(method)) return false;
  try {
    const pathname = new URL(urlValue || "/", "http://localhost").pathname;
    return pathname === "/api" || pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/**
 * Canonical exact HTTP(S) Origin normalization shared by the Manager admin
 * Origin allowlist and the static UI mutation proxy. Accepts only `http:` or
 * `https:` URLs without wildcard hosts, username, password, path other than
 * `/`, query, or fragment, and returns the canonical serialized Origin
 * (lowercased scheme/host, default ports omitted). Returns `undefined` for
 * anything else so every caller fails closed on the same rule.
 */
export function normalizeExactHttpOrigin(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.hostname.includes("*")) return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
  return parsed.origin;
}

/**
 * The request-derived Origin is accepted without configuration only for a
 * literal IP address or the special-use localhost domain. Named LAN/public
 * hosts must be explicitly pinned with `--ui-public-url` /
 * `HOMERAIL_UI_PUBLIC_URL`. Otherwise a DNS-rebinding origin could choose an
 * arbitrary matching Host+Origin pair and be promoted to the Manager's trusted
 * loopback proxy hop. `Forwarded`/`X-Forwarded-*` are never consulted here.
 */
export function authorizeUiAdminProxyMutation(
  request: UiMutationRequestTrust,
  configuredPublicOrigin?: string,
): { allowed: true } | { allowed: false; reason: string } {
  const host = singleHeader(request.host);
  const origin = singleHeader(request.origin);
  if (!host || !origin) {
    return { allowed: false, reason: "UI mutation Origin is required" };
  }

  let selfOrigin: string;
  try {
    selfOrigin = new URL(`${request.protocol}://${host}`).origin;
  } catch {
    return { allowed: false, reason: "UI request Host is invalid" };
  }

  const requestOrigin = normalizeExactHttpOrigin(origin);
  if (!requestOrigin) {
    return { allowed: false, reason: "UI mutation Origin is invalid" };
  }
  const publicOrigin = configuredPublicOrigin
    ? normalizeExactHttpOrigin(configuredPublicOrigin)
    : undefined;
  const safeDirectOrigin = requestOrigin === selfOrigin && isSafeDirectUiOrigin(selfOrigin);
  if (!safeDirectOrigin && requestOrigin !== publicOrigin) {
    return { allowed: false, reason: "Cross-origin UI mutation requests are forbidden" };
  }

  const secFetchSite = singleHeader(request.secFetchSite)?.toLowerCase();
  if (secFetchSite !== undefined && secFetchSite !== "same-origin") {
    return { allowed: false, reason: "Cross-origin UI mutation requests are forbidden" };
  }
  return { allowed: true };
}

function isSafeDirectUiOrigin(origin: string): boolean {
  const parsed = new URL(origin);
  const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || net.isIP(hostname) !== 0;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) return undefined;
  return value;
}
