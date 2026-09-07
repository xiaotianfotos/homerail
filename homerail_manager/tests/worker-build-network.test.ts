import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKER_BUILD_NETWORK_SUMMARY,
  WorkerBuildNetworkError,
  normalizeWorkerBuildNetworkSummary,
  resolveWorkerBuildNetwork,
  workerBuildNetworkDockerArgs,
  workerBuildNetworkSummary,
} from "../src/server/worker-build-network.js";

describe("resolveWorkerBuildNetwork", () => {
  it("leaves every source default and proxies docker-managed without configuration", () => {
    const config = resolveWorkerBuildNetwork({});
    expect(config.aptMirror).toBeUndefined();
    expect(config.aptSecurityMirror).toBeUndefined();
    expect(config.npmRegistry).toBeUndefined();
    expect(config.dshGitRemote).toBeUndefined();
    expect(config.proxyVariableNames).toEqual([]);
    expect(workerBuildNetworkDockerArgs(config)).toEqual([]);
    expect(workerBuildNetworkSummary(config)).toEqual(DEFAULT_WORKER_BUILD_NETWORK_SUMMARY);
  });

  it("treats whitespace-only values as unset", () => {
    const config = resolveWorkerBuildNetwork({
      HOMERAIL_WORKER_BUILD_APT_MIRROR: "   ",
      HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR: "\t",
      HOMERAIL_WORKER_BUILD_NPM_REGISTRY: " \r\n ",
      HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE: "  ",
    });
    expect(workerBuildNetworkDockerArgs(config)).toEqual([]);
    expect(workerBuildNetworkSummary(config)).toEqual(DEFAULT_WORKER_BUILD_NETWORK_SUMMARY);
  });

  it("turns valid public source URLs into valued build arguments", () => {
    const config = resolveWorkerBuildNetwork({
      HOMERAIL_WORKER_BUILD_APT_MIRROR: "https://mirrors.example.com/debian",
      HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR: "https://mirrors.example.com/debian-security",
      HOMERAIL_WORKER_BUILD_NPM_REGISTRY: "https://registry.example.com",
      HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE: "https://git.example.com/deepseek-harness.git",
    });
    expect(workerBuildNetworkDockerArgs(config)).toEqual([
      "--build-arg", "HOMERAIL_WORKER_BUILD_APT_MIRROR=https://mirrors.example.com/debian",
      "--build-arg", "HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR=https://mirrors.example.com/debian-security",
      "--build-arg", "NPM_CONFIG_REGISTRY=https://registry.example.com",
      "--build-arg", "HOMERAIL_DSH_FORK_REPOSITORY=https://git.example.com/deepseek-harness.git",
    ]);
    expect(workerBuildNetworkSummary(config)).toEqual({
      apt_main: "custom",
      apt_security: "custom",
      npm: "custom",
      dsh_git: "custom",
      proxy: "docker-managed",
    });
  });

  it("keeps main and security APT overrides independent", () => {
    const mainOnly = resolveWorkerBuildNetwork({
      HOMERAIL_WORKER_BUILD_APT_MIRROR: "https://main.example.com/debian",
    });
    expect(workerBuildNetworkDockerArgs(mainOnly)).toEqual([
      "--build-arg", "HOMERAIL_WORKER_BUILD_APT_MIRROR=https://main.example.com/debian",
    ]);
    expect(workerBuildNetworkSummary(mainOnly)).toMatchObject({
      apt_main: "custom",
      apt_security: "default",
    });

    const securityOnly = resolveWorkerBuildNetwork({
      HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR: "https://security.example.com/debian-security",
    });
    expect(workerBuildNetworkDockerArgs(securityOnly)).toEqual([
      "--build-arg", "HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR=https://security.example.com/debian-security",
    ]);
    expect(workerBuildNetworkSummary(securityOnly)).toMatchObject({
      apt_main: "default",
      apt_security: "custom",
    });
  });

  it("normalizes harmless trailing slash differences consistently", () => {
    const bare = resolveWorkerBuildNetwork({
      HOMERAIL_WORKER_BUILD_NPM_REGISTRY: "https://registry.example.com",
    });
    const slashed = resolveWorkerBuildNetwork({
      HOMERAIL_WORKER_BUILD_NPM_REGISTRY: "https://registry.example.com/",
    });
    expect(slashed.npmRegistry).toBe(bare.npmRegistry);
    expect(slashed.npmRegistry).toBe("https://registry.example.com");

    const pathBare = resolveWorkerBuildNetwork({
      HOMERAIL_WORKER_BUILD_APT_MIRROR: "https://mirrors.example.com/debian",
    });
    const pathSlashed = resolveWorkerBuildNetwork({
      HOMERAIL_WORKER_BUILD_APT_MIRROR: "https://mirrors.example.com/debian/",
    });
    expect(pathSlashed.aptMirror).toBe(pathBare.aptMirror);
    expect(pathSlashed.aptMirror).toBe("https://mirrors.example.com/debian");
  });

  it("normalizes default ports, scheme/host case, and bracketed IPv6 consistently", () => {
    const defaultPorts = resolveWorkerBuildNetwork({
      HOMERAIL_WORKER_BUILD_APT_MIRROR: "http://mirrors.example.com:80/debian",
      HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR: "https://mirrors.example.com:443/debian-security",
      HOMERAIL_WORKER_BUILD_NPM_REGISTRY: "HTTPS://REGISTRY.EXAMPLE.COM/",
    });
    expect(workerBuildNetworkDockerArgs(defaultPorts)).toEqual([
      "--build-arg", "HOMERAIL_WORKER_BUILD_APT_MIRROR=http://mirrors.example.com/debian",
      "--build-arg", "HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR=https://mirrors.example.com/debian-security",
      "--build-arg", "NPM_CONFIG_REGISTRY=https://registry.example.com",
    ]);

    const ipv6 = resolveWorkerBuildNetwork({
      HOMERAIL_WORKER_BUILD_APT_MIRROR: "http://[2001:DB8::1]:8080/debian",
    });
    expect(workerBuildNetworkDockerArgs(ipv6)).toEqual([
      "--build-arg", "HOMERAIL_WORKER_BUILD_APT_MIRROR=http://[2001:db8::1]:8080/debian",
    ]);
  });

  it("rejects port 99999 and non-numeric ports for every source key without echoing the value", () => {
    for (const value of [
      "http://mirrors.example.com:99999/debian",
      "https://mirrors.example.com:port/debian",
    ]) {
      for (const key of [
        "HOMERAIL_WORKER_BUILD_APT_MIRROR",
        "HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR",
        "HOMERAIL_WORKER_BUILD_NPM_REGISTRY",
        "HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE",
      ]) {
        let caught: unknown;
        try {
          resolveWorkerBuildNetwork({ [key]: value });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(WorkerBuildNetworkError);
        const message = (caught as Error).message;
        expect(message).toContain(key);
        expect(message).not.toContain(value);
      }
    }
  });

  const invalidValues = [
    "ftp://mirrors.example.com/debian",
    "file:///etc/passwd",
    "not a url",
    "https://",
    "https://user:secret@mirrors.example.com/debian",
    "https://user@mirrors.example.com/debian",
    "https://@mirrors.example.com/debian",
    "https://mirrors.example.com/debian?suite=stable",
    "https://mirrors.example.com/debian#fragment",
    "https://mirrors.example.com/deb ian",
    "https://mirrors.example.com/deb\tian",
    "https://mirrors.example.com/\u0000debian",
    "https://exämple.com/debian",
    "https://mirrors.example.com/<debian>",
    "https://mirrors.example.com/{debian}",
    "https://mirrors.example.com\\debian",
    "https://mirrors.example.com/deb%ian",
    "https://mirrors.example.com/deb|ian",
    "https://mirrors.example.com/deb^ian",
    "https://mirrors.example.com/deb$(touch)/ian",
    "https://mirrors.example.com/deb(ian)",
    "https://mirrors.example.com/deb[ian",
    "https://mirrors.example.com/deb]ian",
  ];

  for (const value of invalidValues) {
    it(`rejects ${JSON.stringify(value)} for every source key without echoing the value`, () => {
      for (const key of [
        "HOMERAIL_WORKER_BUILD_APT_MIRROR",
        "HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR",
        "HOMERAIL_WORKER_BUILD_NPM_REGISTRY",
        "HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE",
      ]) {
        let caught: unknown;
        try {
          resolveWorkerBuildNetwork({ [key]: value });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(WorkerBuildNetworkError);
        const message = (caught as Error).message;
        expect(message).toContain(key);
        expect(message).not.toContain(value);
      }
    });
  }

  it("allows an at-sign in the path when the authority has no userinfo", () => {
    const config = resolveWorkerBuildNetwork({
      HOMERAIL_WORKER_BUILD_NPM_REGISTRY: "https://registry.example.com/scope/@package",
    });
    expect(config.npmRegistry).toBe("https://registry.example.com/scope/@package");
  });

  it("forwards only non-empty proxy variable names without values", () => {
    const config = resolveWorkerBuildNetwork({
      HTTP_PROXY: "http://proxy.example.com:3128",
      http_proxy: "",
      HTTPS_PROXY: "   ",
      https_proxy: "http://proxy.example.com:3129",
      NO_PROXY: "localhost,127.0.0.1",
    });
    expect(config.proxyVariableNames).toEqual(["HTTP_PROXY", "https_proxy", "NO_PROXY"]);
    const args = workerBuildNetworkDockerArgs(config);
    expect(args).toEqual([
      "--build-arg", "HTTP_PROXY",
      "--build-arg", "https_proxy",
      "--build-arg", "NO_PROXY",
    ]);
    expect(args.join("\u0000")).not.toContain("proxy.example.com");
    expect(workerBuildNetworkSummary(config)).toMatchObject({ proxy: "environment" });
  });

  it("places valued source arguments before value-less proxy arguments", () => {
    const config = resolveWorkerBuildNetwork({
      HOMERAIL_WORKER_BUILD_NPM_REGISTRY: "https://registry.example.com",
      HTTP_PROXY: "http://proxy.example.com:3128",
    });
    expect(workerBuildNetworkDockerArgs(config)).toEqual([
      "--build-arg", "NPM_CONFIG_REGISTRY=https://registry.example.com",
      "--build-arg", "HTTP_PROXY",
    ]);
  });
});

describe("normalizeWorkerBuildNetworkSummary", () => {
  it("returns undefined for missing or non-object persisted values", () => {
    expect(normalizeWorkerBuildNetworkSummary(undefined)).toBeUndefined();
    expect(normalizeWorkerBuildNetworkSummary(null)).toBeUndefined();
    expect(normalizeWorkerBuildNetworkSummary("custom")).toBeUndefined();
    expect(normalizeWorkerBuildNetworkSummary(["custom"])).toBeUndefined();
    expect(normalizeWorkerBuildNetworkSummary(42)).toBeUndefined();
  });

  it("keeps valid persisted summaries intact", () => {
    const summary = {
      apt_main: "custom",
      apt_security: "default",
      npm: "custom",
      dsh_git: "custom",
      proxy: "environment",
    };
    expect(normalizeWorkerBuildNetworkSummary(summary)).toEqual(summary);
    expect(normalizeWorkerBuildNetworkSummary(DEFAULT_WORKER_BUILD_NETWORK_SUMMARY))
      .toEqual(DEFAULT_WORKER_BUILD_NETWORK_SUMMARY);
  });

  it("falls back field by field for unknown or malformed persisted values", () => {
    expect(normalizeWorkerBuildNetworkSummary({})).toEqual(DEFAULT_WORKER_BUILD_NETWORK_SUMMARY);
    expect(normalizeWorkerBuildNetworkSummary({
      apt_main: "weird",
      apt_security: ["custom"],
      npm: 1,
      dsh_git: ["custom"],
      proxy: "none",
    })).toEqual(DEFAULT_WORKER_BUILD_NETWORK_SUMMARY);
    expect(normalizeWorkerBuildNetworkSummary({
      apt_main: "custom",
      proxy: "environment",
    })).toEqual({
      apt_main: "custom",
      apt_security: "default",
      npm: "default",
      dsh_git: "default",
      proxy: "environment",
    });
  });
});
