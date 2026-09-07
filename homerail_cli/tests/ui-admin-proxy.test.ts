import { describe, expect, it } from "vitest";
import {
  authorizeUiAdminProxyMutation,
  isProtectedApiMutation,
  normalizeExactHttpOrigin,
} from "../src/ui-admin-proxy.js";

describe("Agent UI mutation proxy trust", () => {
  it("derives localhost and literal LAN-IP self Origins from each request", () => {
    expect(authorizeUiAdminProxyMutation({
      protocol: "https",
      host: "localhost:19192",
      origin: "https://localhost:19192",
      secFetchSite: "same-origin",
    })).toEqual({ allowed: true });
    expect(authorizeUiAdminProxyMutation({
      protocol: "http",
      host: "192.168.1.25:19193",
      origin: "http://192.168.1.25:19193",
      secFetchSite: "same-origin",
    })).toEqual({ allowed: true });
  });

  it("rejects an unpinned named Host even when Host and Origin match", () => {
    expect(authorizeUiAdminProxyMutation({
      protocol: "http",
      host: "attacker-rebind.example:19193",
      origin: "http://attacker-rebind.example:19193",
      secFetchSite: "same-origin",
    })).toEqual({
      allowed: false,
      reason: "Cross-origin UI mutation requests are forbidden",
    });
  });

  it("rejects missing and cross-origin browser mutations", () => {
    expect(authorizeUiAdminProxyMutation({
      protocol: "http",
      host: "localhost:19193",
      origin: undefined,
    })).toMatchObject({ allowed: false });
    expect(authorizeUiAdminProxyMutation({
      protocol: "http",
      host: "localhost:19193",
      origin: "https://evil.example",
    })).toMatchObject({ allowed: false });
    expect(authorizeUiAdminProxyMutation({
      protocol: "http",
      host: "localhost:19193",
      origin: "http://localhost:19193",
      secFetchSite: "cross-site",
    })).toMatchObject({ allowed: false });
  });

  it("covers every protected API mutation while leaving reads and non-API routes alone", () => {
    expect(isProtectedApiMutation("POST", "/api/runs")).toBe(true);
    expect(isProtectedApiMutation("PUT", "/api/manager-agent/config")).toBe(true);
    expect(isProtectedApiMutation("PATCH", "/api/future-route")).toBe(true);
    expect(isProtectedApiMutation("DELETE", "/api/plugins/demo")).toBe(true);
    expect(isProtectedApiMutation("POST", "/api/browser-tools/renderer-ticket")).toBe(true);
    expect(isProtectedApiMutation("GET", "/api/plugins")).toBe(false);
    expect(isProtectedApiMutation("POST", "/health")).toBe(false);
  });
});

describe("exact HTTP(S) Origin normalization", () => {
  it("accepts exact http(s) Origins and canonicalizes case and default ports", () => {
    expect(normalizeExactHttpOrigin("https://external.example")).toBe("https://external.example");
    expect(normalizeExactHttpOrigin("http://192.168.1.10:19193")).toBe("http://192.168.1.10:19193");
    expect(normalizeExactHttpOrigin("https://[::1]:19192")).toBe("https://[::1]:19192");
    expect(normalizeExactHttpOrigin("https://External.Example:443")).toBe("https://external.example");
    expect(normalizeExactHttpOrigin("http://localhost:80")).toBe("http://localhost");
    expect(normalizeExactHttpOrigin("https://external.example/")).toBe("https://external.example");
  });

  it("rejects wildcards, paths, queries, fragments, credentials, and non-http(s) values", () => {
    for (const value of [
      "",
      "not-a-url",
      "null",
      "https://*.example.com",
      "https://external.example/ui",
      "https://external.example?token=1",
      "https://external.example#fragment",
      "https://user:pass@external.example",
      "ftp://external.example",
      "ws://external.example",
    ]) {
      expect(normalizeExactHttpOrigin(value), value).toBeUndefined();
    }
  });
});

describe("configured external UI Origin", () => {
  const publicOrigin = "https://external.example";
  const rewrittenHost = { protocol: "http" as const, host: "127.0.0.1:19192" };

  it("accepts the configured public Origin despite an internally rewritten Host", () => {
    expect(authorizeUiAdminProxyMutation({
      ...rewrittenHost,
      origin: publicOrigin,
      secFetchSite: "same-origin",
    }, publicOrigin)).toEqual({ allowed: true });
  });

  it("still accepts the request-derived self Origin for direct local access", () => {
    expect(authorizeUiAdminProxyMutation({
      ...rewrittenHost,
      origin: "http://127.0.0.1:19192",
      secFetchSite: "same-origin",
    }, publicOrigin)).toEqual({ allowed: true });
  });

  it("rejects other matching named Origins once the public Origin is pinned", () => {
    expect(authorizeUiAdminProxyMutation({
      protocol: "http",
      host: "attacker-rebind.example:19192",
      origin: "http://attacker-rebind.example:19192",
      secFetchSite: "same-origin",
    }, publicOrigin)).toMatchObject({ allowed: false });
  });

  it("compares canonical Origins for case and default ports", () => {
    expect(authorizeUiAdminProxyMutation({
      ...rewrittenHost,
      origin: "https://External.Example:443",
      secFetchSite: "same-origin",
    }, publicOrigin)).toEqual({ allowed: true });
    expect(authorizeUiAdminProxyMutation({
      ...rewrittenHost,
      origin: publicOrigin,
      secFetchSite: "same-origin",
    }, "https://External.Example:443")).toEqual({ allowed: true });
  });

  it("rejects missing, malformed, and unrelated Origins even with a configured Origin", () => {
    for (const origin of [
      undefined,
      "null",
      "not-a-url",
      "https://external.example.evil",
      "https://evil.example",
      "https://user:pass@external.example",
      "http://external.example",
    ]) {
      expect(authorizeUiAdminProxyMutation({
        ...rewrittenHost,
        origin,
        secFetchSite: "same-origin",
      }, publicOrigin), String(origin)).toMatchObject({ allowed: false });
    }
  });

  it("rejects a present non-same-origin Sec-Fetch-Site even when the Origin matches", () => {
    for (const secFetchSite of ["cross-site", "same-site", "none"]) {
      expect(authorizeUiAdminProxyMutation({
        ...rewrittenHost,
        origin: publicOrigin,
        secFetchSite,
      }, publicOrigin), secFetchSite).toMatchObject({ allowed: false });
    }
  });

  it("ignores configured values that are not exact http(s) Origins", () => {
    for (const configured of ["https://evil.example/path", "https://*.example.com", "null"]) {
      expect(authorizeUiAdminProxyMutation({
        ...rewrittenHost,
        origin: "https://evil.example",
        secFetchSite: "same-origin",
      }, configured), configured).toMatchObject({ allowed: false });
    }
  });
});
