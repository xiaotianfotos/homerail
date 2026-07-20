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
 * Keep the UI proxy zero-config by deriving its self Origin from the request
 * that reached the server. Manager performs the canonical authorization after
 * this hop; this check only rejects obvious browser cross-origin mutations.
 */
export function authorizeUiAdminProxyMutation(
  request: UiMutationRequestTrust,
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
  if (origin !== selfOrigin) {
    return { allowed: false, reason: "Cross-origin UI mutation requests are forbidden" };
  }

  const secFetchSite = singleHeader(request.secFetchSite)?.toLowerCase();
  if (secFetchSite !== undefined && secFetchSite !== "same-origin") {
    return { allowed: false, reason: "Cross-origin UI mutation requests are forbidden" };
  }
  return { allowed: true };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) return undefined;
  return value;
}
