const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface UiMutationRequestTrust {
  protocol: "http" | "https";
  host: string | string[] | undefined;
  origin: string | string[] | undefined;
  secFetchSite?: string | string[];
}

/** 额外的信任 Origin（如 FN Connect 域名、异地组网域名等）。
 * 通过环境变量 HOMERAIL_UI_TRUSTED_ORIGINS 配置，逗号分隔。
 * 命中时跳过 Host/Origin 匹配校验（Manager 层仍做最终鉴权）。 */
export function uiTrustedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.HOMERAIL_UI_TRUSTED_ORIGINS?.trim();
  if (!raw) return [];
  return raw.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
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

  // 命中信任 Origin 白名单（如 FN Connect 域名）直接放行，
  // 避免反向代理改写 Host 导致 origin !== selfOrigin 误拒绝。
  // Manager 层仍会做最终的 Origin/Token 鉴权。
  if (origin && uiTrustedOrigins().includes(origin)) {
    return { allowed: true };
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
