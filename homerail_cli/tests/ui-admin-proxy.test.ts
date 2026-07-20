import { describe, expect, it } from "vitest";
import {
  authorizeUiAdminProxyMutation,
  isProtectedApiMutation,
} from "../src/ui-admin-proxy.js";

describe("Agent UI mutation proxy trust", () => {
  it("derives local and LAN self Origins from each request", () => {
    expect(authorizeUiAdminProxyMutation({
      protocol: "https",
      host: "localhost:19192",
      origin: "https://localhost:19192",
      secFetchSite: "same-origin",
    })).toEqual({ allowed: true });
    expect(authorizeUiAdminProxyMutation({
      protocol: "http",
      host: "homerail.lan:19193",
      origin: "http://homerail.lan:19193",
      secFetchSite: "same-origin",
    })).toEqual({ allowed: true });
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
    expect(isProtectedApiMutation("GET", "/api/plugins")).toBe(false);
    expect(isProtectedApiMutation("POST", "/health")).toBe(false);
  });
});
