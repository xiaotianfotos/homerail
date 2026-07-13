const LOCAL_WEBSOCKET_HOSTS = new Set([
  "localhost",
  "::1",
  "host.docker.internal",
]);

function isLocalWebSocketHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOCAL_WEBSOCKET_HOSTS.has(normalized) || normalized.startsWith("127.");
}

export function assertSecureControlPlaneUrl(
  rawUrl: string,
  allowInsecureRemote = false,
): void {
  const url = new URL(rawUrl);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Manager WebSocket URL must use ws:// or wss://: ${rawUrl}`);
  }
  if (url.protocol === "wss:" || isLocalWebSocketHost(url.hostname)) return;
  if (allowInsecureRemote) return;
  throw new Error(
    "Remote Manager WebSocket connections require wss://. "
      + "Set HOMERAIL_ALLOW_INSECURE_REMOTE_WS=1 only for an isolated trusted network.",
  );
}
