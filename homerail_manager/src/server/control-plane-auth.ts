import { timingSafeEqual } from "node:crypto";

export function isLoopbackRemoteAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  if (normalized === "::1" || normalized === "localhost") return true;
  if (normalized.startsWith("127.")) return true;
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackRemoteAddress(normalized.slice("::ffff:".length));
  }
  return normalized === "0:0:0:0:0:ffff:7f00:1";
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  return token || undefined;
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

export function isControlPlaneUpgradeAuthorized(input: {
  remoteAddress: string | null | undefined;
  authorization: string | string[] | undefined;
  configuredToken?: string;
  allowLoopbackWithoutToken?: boolean;
}): boolean {
  const expected = input.configuredToken?.trim();
  const actual = bearerToken(input.authorization);
  if (expected && actual && tokensEqual(actual, expected)) return true;
  if (expected) {
    return input.allowLoopbackWithoutToken === true
      && isLoopbackRemoteAddress(input.remoteAddress);
  }
  return isLoopbackRemoteAddress(input.remoteAddress);
}

export function rejectWebSocketUpgrade(
  socket: { write(chunk: string): unknown; destroy(): void },
  statusCode: number,
  reason: string,
): void {
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${reason}\r\n`
        + `${statusCode === 401 ? "WWW-Authenticate: Bearer\r\n" : ""}`
        + "Connection: close\r\nContent-Length: 0\r\n\r\n",
    );
  } finally {
    socket.destroy();
  }
}
