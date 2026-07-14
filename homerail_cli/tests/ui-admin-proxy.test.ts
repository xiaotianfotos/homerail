import { describe, expect, it } from "vitest";
import { resolveUiAdminProxyProcessEnv } from "../src/commands/runtime.js";
import {
  authorizeUiAdminProxyMutation,
  createUiAdminProxyPolicy,
  isProtectedApiMutation,
} from "../src/ui-admin-proxy.js";

const TOKEN = "ui-proxy-admin-token-0123456789abcdef";

describe("Agent UI admin proxy trust", () => {
  it("enables a computed loopback-only proxy with an exact self Origin", () => {
    const env = resolveUiAdminProxyProcessEnv({
      uiBindHost: "127.0.0.1",
      uiPublicUrl: "https://localhost:19192",
      managerUrl: "http://localhost:19191",
      adminToken: TOKEN,
    });
    expect(env).toEqual({
      HOMERAIL_UI_ORIGIN: "https://localhost:19192",
      HOMERAIL_UI_ADMIN_PROXY_ENABLED: "1",
      HOMERAIL_MANAGER_ADMIN_TOKEN: TOKEN,
    });

    const policy = createUiAdminProxyPolicy({
      enabled: env.HOMERAIL_UI_ADMIN_PROXY_ENABLED === "1",
      uiOrigin: env.HOMERAIL_UI_ORIGIN!,
      uiBindHost: "127.0.0.1",
      managerUrl: "http://localhost:19191",
      adminToken: env.HOMERAIL_MANAGER_ADMIN_TOKEN,
    });
    expect(authorizeUiAdminProxyMutation(policy, "https://localhost:19192"))
      .toEqual({ allowed: true });
  });

  it("rejects no-Origin curl and cross-origin browser equivalents", () => {
    const policy = createUiAdminProxyPolicy({
      enabled: true,
      uiOrigin: "http://localhost:19193",
      uiBindHost: "127.0.0.1",
      managerUrl: "http://127.0.0.1:19191",
      adminToken: TOKEN,
    });
    expect(authorizeUiAdminProxyMutation(policy, undefined)).toMatchObject({ allowed: false });
    expect(authorizeUiAdminProxyMutation(policy, "https://evil.example"))
      .toMatchObject({ allowed: false });
    expect(authorizeUiAdminProxyMutation(policy, "http://localhost:19193", "cross-site"))
      .toMatchObject({ allowed: false });
  });

  it("fails LAN and public plaintext mutation proxy modes closed and erases the token", () => {
    expect(resolveUiAdminProxyProcessEnv({
      uiBindHost: "0.0.0.0",
      uiPublicUrl: "http://192.168.1.8:19193",
      managerUrl: "http://127.0.0.1:19191",
      adminToken: TOKEN,
    })).toEqual({
      HOMERAIL_UI_ORIGIN: "http://192.168.1.8:19193",
      HOMERAIL_UI_ADMIN_PROXY_ENABLED: "0",
      HOMERAIL_MANAGER_ADMIN_TOKEN: "",
    });
    expect(resolveUiAdminProxyProcessEnv({
      uiBindHost: "127.0.0.1",
      uiPublicUrl: "https://localhost:19192",
      managerUrl: "http://192.168.1.8:19191",
      adminToken: TOKEN,
    }).HOMERAIL_UI_ADMIN_PROXY_ENABLED).toBe("0");
  });

  it("enables an explicitly unsafe public test proxy without forwarding a token", () => {
    const env = resolveUiAdminProxyProcessEnv({
      uiBindHost: "192.168.1.8",
      uiPublicUrl: "http://192.168.1.8:19193",
      managerUrl: "http://127.0.0.1:19191",
      adminToken: TOKEN,
      unsafeNoAdminToken: true,
    });
    expect(env).toEqual({
      HOMERAIL_UI_ORIGIN: "http://192.168.1.8:19193",
      HOMERAIL_UI_ADMIN_PROXY_ENABLED: "1",
      HOMERAIL_MANAGER_ADMIN_TOKEN: "",
      HOMERAIL_UNSAFE_ALLOW_PUBLIC_MANAGER_WITHOUT_AUTH: "1",
    });
    const policy = createUiAdminProxyPolicy({
      enabled: true,
      uiOrigin: env.HOMERAIL_UI_ORIGIN!,
      uiBindHost: "192.168.1.8",
      managerUrl: "http://127.0.0.1:19191",
      unsafeAllowPublicNoAuth: true,
    });
    expect(authorizeUiAdminProxyMutation(policy, "http://192.168.1.8:19193", "same-origin"))
      .toEqual({ allowed: true });
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
