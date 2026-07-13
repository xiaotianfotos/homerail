export const HOMERAIL_UI_ADMIN_PROXY_ENABLED = "HOMERAIL_UI_ADMIN_PROXY_ENABLED";
export const HOMERAIL_UI_ORIGIN = "HOMERAIL_UI_ORIGIN";
export const HOMERAIL_UNSAFE_ALLOW_PUBLIC_MANAGER_WITHOUT_AUTH = "HOMERAIL_UNSAFE_ALLOW_PUBLIC_MANAGER_WITHOUT_AUTH";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface UiAdminProxyPolicyOptions {
  enabled: boolean;
  uiOrigin: string;
  uiBindHost: string;
  managerUrl: string;
  adminToken?: string;
  unsafeAllowPublicNoAuth?: boolean;
}

export interface UiAdminProxyPolicy {
  readonly enabled: boolean;
  readonly uiOrigin?: string;
  readonly adminToken?: string;
  readonly unsafeAllowPublicNoAuth?: boolean;
  readonly disabledReason?: string;
}

/**
 * A UI process may hold the Manager credential only when both hops and the
 * advertised browser origin are loopback-only. Public/LAN UI stays useful for
 * reads, but its mutation proxy is deliberately disabled.
 */
export function createUiAdminProxyPolicy(options: UiAdminProxyPolicyOptions): UiAdminProxyPolicy {
  if (!options.enabled) return disabled("loopback-safe admin proxy switch is disabled");

  const uiOrigin = parseExactOrigin(options.uiOrigin);
  if (!uiOrigin) return disabled("UI Origin is not an exact http(s) Origin");
  const unsafeAllowPublicNoAuth = Boolean(options.unsafeAllowPublicNoAuth && !options.adminToken);
  if (
    (!isLoopbackHost(options.uiBindHost) || !isLoopbackHost(new URL(uiOrigin).hostname))
    && !unsafeAllowPublicNoAuth
  ) {
    return disabled("UI is reachable beyond loopback");
  }

  let manager: URL;
  try {
    manager = new URL(options.managerUrl);
  } catch {
    return disabled("Manager URL is invalid");
  }
  if (
    (manager.protocol !== "http:" && manager.protocol !== "https:")
    || !isLoopbackHost(manager.hostname)
    || manager.username
    || manager.password
  ) {
    return disabled("Manager target is reachable beyond the loopback trust boundary");
  }

  return Object.freeze({
    enabled: true,
    uiOrigin,
    adminToken: options.adminToken || undefined,
    unsafeAllowPublicNoAuth,
  });
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

export function authorizeUiAdminProxyMutation(
  policy: UiAdminProxyPolicy,
  originHeader: string | string[] | undefined,
  secFetchSiteHeader?: string | string[],
): { allowed: true } | { allowed: false; reason: string } {
  if (!policy.enabled || !policy.uiOrigin) {
    return { allowed: false, reason: policy.disabledReason || "UI mutation proxy is disabled" };
  }
  if (typeof originHeader !== "string" || originHeader !== policy.uiOrigin) {
    return { allowed: false, reason: "UI mutation Origin is missing or not self-origin" };
  }
  if (
    secFetchSiteHeader !== undefined
    && (typeof secFetchSiteHeader !== "string" || secFetchSiteHeader.toLowerCase() !== "same-origin")
  ) {
    return { allowed: false, reason: "Cross-origin UI mutation proxy requests are forbidden" };
  }
  return { allowed: true };
}

export function isLoopbackHost(value: string): boolean {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone);
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("::ffff:")) host = host.slice("::ffff:".length);
  const octets = host.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

function parseExactOrigin(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.origin !== value
  ) return undefined;
  return parsed.origin;
}

function disabled(reason: string): UiAdminProxyPolicy {
  return Object.freeze({ enabled: false, disabledReason: reason });
}
