import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  NativeCodexSessionStore,
  nativeCodexArgs,
  nativeCodexEnvironment,
  nativeCodexRuntime,
  nativeCodexThreadConfig,
  type NativeCodexRuntime,
} from "../agent/codex-subscription.js";
import type { AgentRunContext } from "../agent/types.js";

describe("native Codex subscription boundary", () => {
  let root: string;
  let context: AgentRunContext;
  let env: NodeJS.ProcessEnv;
  let runtime: NativeCodexRuntime;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-native-codex-test-"));
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "native-home");
    const stateDir = path.join(root, "session-state");
    for (const directory of [workspace, home, stateDir]) fs.mkdirSync(directory, { mode: 0o700 });
    const bin = path.join(root, "codex");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    context = {
      provider: "openai",
      protocol: "codex_subscription",
      model: "gpt-6-astra",
      reasoningEffort: "low",
      apiKey: "",
      baseUrl: "",
      workspace,
      workspaceAccess: { writable_paths: [], readonly_paths: ["."] },
      codexSandbox: "read-only",
      sessionId: "run-123/agent-reader",
    };
    env = {
      HOMERAIL_CODEX_SUBSCRIPTION_ENABLED: "1",
      HOMERAIL_CODEX_SUBSCRIPTION_HOME: home,
      HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR: stateDir,
      HOMERAIL_CODEX_SUBSCRIPTION_BIN: bin,
    };
    runtime = nativeCodexRuntime(context, env);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function recordPath(): string {
    const key = createHash("sha256").update(runtime.sessionKey).digest("hex");
    return path.join(runtime.stateDir, `${key}.json`);
  }

  function anotherDirectory(name: string): string {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { mode: 0o700 });
    return directory;
  }

  it("requires explicit Worker opt-in even with valid native directories", () => {
    for (const enabled of [undefined, "0", "true"]) {
      expect(() => nativeCodexRuntime(context, { ...env, HOMERAIL_CODEX_SUBSCRIPTION_ENABLED: enabled }))
        .toThrow(/not enabled/);
    }
  });

  it.each<Partial<AgentRunContext>>([
    { provider: "deepseek" },
    { provider: undefined },
    { model: " " },
    { reasoningEffort: undefined },
    { reasoningEffort: " " },
  ])("rejects unspecified or incompatible model selection %j", (change) => {
    expect(() => nativeCodexRuntime({ ...context, ...change }, env)).toThrow(/exact OpenAI model/);
  });

  it.each<Partial<AgentRunContext>>([
    { apiKey: "synthetic-test-secret" },
    { baseUrl: "https://example.invalid/v1" },
    { environmentVariables: { OPENAI_API_KEY: "synthetic-test-secret" } },
    { environmentVariables: { LANG: "C" } },
    { serviceTier: "priority" },
  ])("rejects API billing or projected environment inputs %j", (change) => {
    expect(() => nativeCodexRuntime({ ...context, ...change }, env)).toThrow(/does not accept API credentials/);
  });

  it.each<Partial<AgentRunContext>>([
    { codexSandbox: undefined },
    { codexSandbox: "workspace-write" },
    { codexSandbox: "danger-full-access" },
    { workspaceAccess: undefined },
    { workspaceAccess: { writable_paths: ["output"] } },
  ])("requires read-only policy at both adapter boundaries %j", (change) => {
    expect(() => nativeCodexRuntime({ ...context, ...change }, env)).toThrow(/explicitly read-only/);
  });

  it("requires stable HomeRail session identity", () => {
    expect(() => nativeCodexRuntime({ ...context, sessionId: " " }, env)).toThrow(/stable HomeRail session/);
  });

  it.each([
    "HOMERAIL_CODEX_SUBSCRIPTION_HOME",
    "HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR",
    "HOMERAIL_CODEX_SUBSCRIPTION_BIN",
  ])("rejects a relative trusted path in %s", (name) => {
    expect(() => nativeCodexRuntime(context, { ...env, [name]: "relative/path" })).toThrow(/absolute/);
  });

  it("requires an existing absolute workspace directory", () => {
    expect(() => nativeCodexRuntime({ ...context, workspace: "workspace" }, env)).toThrow(/absolute directory/);
    expect(() => nativeCodexRuntime({ ...context, workspace: runtime.bin }, env)).toThrow(/must be a directory/);
    expect(() => nativeCodexRuntime({ ...context, workspace: path.join(root, "missing") }, env)).toThrow();
  });

  it("does not accept a directory as the native executable", () => {
    expect(() => nativeCodexRuntime(context, { ...env, HOMERAIL_CODEX_SUBSCRIPTION_BIN: root }))
      .toThrow(/binary path/);
  });

  it.each(["HOMERAIL_CODEX_SUBSCRIPTION_HOME", "HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR"])(
    "rejects %s beneath the workspace even through a symlink",
    (name) => {
      const nested = path.join(runtime.workspace, "private-state");
      fs.mkdirSync(nested);
      const alias = path.join(root, "private-state-alias");
      fs.symlinkSync(nested, alias, "dir");
      expect(() => nativeCodexRuntime(context, { ...env, [name]: alias })).toThrow(/outside the readable workspace/);
    },
  );

  it("rejects a workspace that includes or sits inside the native home", () => {
    expect(() => nativeCodexRuntime({ ...context, workspace: root }, env)).toThrow(/outside the readable workspace/);
    const nested = path.join(runtime.home, "project");
    fs.mkdirSync(nested);
    expect(() => nativeCodexRuntime({ ...context, workspace: nested }, env)).toThrow(/outside the readable workspace/);
  });

  it("accepts similarly prefixed sibling paths without conflating them with descendants", () => {
    const workspace = anotherDirectory("native-home-project");
    expect(nativeCodexRuntime({ ...context, workspace }, env).workspace).toBe(workspace);
  });

  it("does not forward ambient credentials, transport overrides, or process injection variables", () => {
    const source = {
      PATH: "/usr/bin:/bin", HOME: "/trusted-user", LANG: "C.UTF-8", TMPDIR: "/tmp",
      CODEX_HOME: "/unexpected-home",
      OPENAI_API_KEY: "synthetic-api-secret", OPENAI_BASE_URL: "https://example.invalid",
      CODEX_API_KEY: "synthetic-codex-secret", ANTHROPIC_API_KEY: "synthetic-other-secret",
      HOMERAIL_WORKER_TOKEN: "synthetic-worker-secret", GEMINI_API_KEY: "synthetic-router-secret",
      NODE_OPTIONS: "--require=untrusted", LD_PRELOAD: "/untrusted.so",
      HTTP_PROXY: "http://example.invalid", HTTPS_PROXY: "http://example.invalid",
    };
    const child = nativeCodexEnvironment(runtime, source);
    expect(child.CODEX_HOME).toBe(runtime.home);
    expect(child.PATH).toBe(source.PATH);
    expect(child.LANG).toBe(source.LANG);
    for (const key of Object.keys(source).filter(key => !["PATH", "HOME", "LANG", "TMPDIR", "CODEX_HOME"].includes(key))) {
      expect(child).not.toHaveProperty(key);
    }
    expect(JSON.stringify(child)).not.toContain("synthetic-");
    expect(source.CODEX_HOME).toBe("/unexpected-home");
  });

  it("overrides the process configuration without writing into native history or auth", () => {
    const config = path.join(runtime.home, "config.toml");
    const original = 'model = "keep-user-model"\n';
    fs.writeFileSync(config, original);
    const args = nativeCodexArgs();
    expect(args[0]).toBe("app-server");
    expect(args).toContain('forced_login_method="chatgpt"');
    expect(args).toContain('sandbox_mode="read-only"');
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain("features.hooks=false");
    expect(fs.readFileSync(config, "utf8")).toBe(original);
  });

  it("disables discovered extensions and supplies a credential-free shell environment", () => {
    const scratch = anotherDirectory("scratch");
    const resolved = {
      mcp_servers: { billing: { command: "untrusted" }, private: { url: "https://example.invalid" } },
      plugins: { enabled_plugin: { enabled: true } },
    };
    const config = nativeCodexThreadConfig(resolved, ["/user/skills/one", "/project/skills/two"], scratch, "low");
    expect(config.mcp_servers).toEqual({ billing: { enabled: false }, private: { enabled: false } });
    expect(config.plugins).toEqual({ enabled_plugin: { enabled: false } });
    expect(config.skills).toEqual({ config: [
      { path: "/user/skills/one", enabled: false }, { path: "/project/skills/two", enabled: false },
    ] });
    expect(config.shell_environment_policy).toEqual({
      inherit: "none", include_only: [],
      set: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: scratch, CODEX_HOME: scratch, TMPDIR: scratch },
    });
    expect(config.model_reasoning_effort).toBe("low");
    expect(resolved.plugins.enabled_plugin.enabled).toBe(true);
  });

  it("refuses a user-defined OpenAI provider even if it would silently change only billing", () => {
    expect(() => nativeCodexThreadConfig({ model_providers: { openai: { env_key: "OPENAI_API_KEY" } } }, [], root, "low"))
      .toThrow(/overridden OpenAI provider/);
    expect(() => nativeCodexThreadConfig({ model_providers: { openai: { base_url: "https://example.invalid" } } }, [], root, "low"))
      .toThrow(/overridden OpenAI provider/);
  });

  it.each(["model_instructions_file", "experimental_instructions_file", "responses_api_endpoint"])(
    "rejects inherited %s before loading unscoped instructions or changing transport",
    field => {
      expect(() => nativeCodexThreadConfig({ [field]: "/untrusted/setting" }, [], root, "low"))
        .toThrow(new RegExp(`refuses inherited ${field}`));
    },
  );

  it("rejects inherited notification commands and alternate ChatGPT endpoints", () => {
    expect(() => nativeCodexThreadConfig({ notify: ["sh", "-c", "unexpected-host-command"] }, [], root, "low"))
      .toThrow(/notifications to be disabled/);
    expect(() => nativeCodexThreadConfig({ chatgpt_base_url: "https://example.invalid/backend-api" }, [], root, "low"))
      .toThrow(/overridden ChatGPT endpoint/);
  });

  it("uses a fresh named permission profile with credential and history directories explicitly denied", () => {
    const scratch = anotherDirectory("restricted-scratch");
    const profileId = "homerail-native-test-profile";
    const config = nativeCodexThreadConfig({
      default_permissions: "user-profile", permissions: { "user-profile": { filesystem: { ":root": "write" } } },
    }, [], scratch, "low", runtime, profileId);
    expect(config.default_permissions).toBe(profileId);
    expect(config.permissions).toEqual({ [profileId]: {
      filesystem: {
        ":root": "deny", ":minimal": "read",
        [runtime.workspace]: "read", [scratch]: "read", [runtime.home]: "deny", [runtime.stateDir]: "deny",
      },
      network: { enabled: false },
    } });
  });

  it("persists the native thread association across Worker instances without storing credentials", () => {
    fs.writeFileSync(path.join(runtime.home, "auth.json"), '{"testOnly":"synthetic-native-secret"}');
    fs.mkdirSync(path.join(runtime.home, "sessions"));
    const transcript = path.join(runtime.home, "sessions", "native.jsonl");
    fs.writeFileSync(transcript, '{"type":"preserved-native-history"}\n');
    const first = new NativeCodexSessionStore(runtime, context, []);
    expect(first.read()).toBeUndefined();
    first.save("native-thread-123");
    first.release();
    const second = new NativeCodexSessionStore(runtime, context, []);
    expect(second.read()?.threadId).toBe("native-thread-123");
    second.release();
    const record = fs.readFileSync(recordPath(), "utf8");
    expect(Object.keys(JSON.parse(record)).sort()).toEqual(["binding", "threadId", "version"]);
    expect(record).not.toContain("synthetic-native-secret");
    if (process.platform === "win32") {
      // Windows file modes only model the write bit, so 0o600 is not representable.
      expect(fs.statSync(recordPath()).mode & 0o777).toBe(0o666);
    } else {
      expect(fs.statSync(recordPath()).mode & 0o777).toBe(0o600);
    }
    expect(fs.readFileSync(transcript, "utf8")).toBe('{"type":"preserved-native-history"}\n');
    expect(fs.readFileSync(path.join(runtime.home, "auth.json"), "utf8")).toContain("synthetic-native-secret");
    expect(fs.readdirSync(runtime.stateDir)).toEqual([path.basename(recordPath())]);
  });

  it.each(["model", "effort", "workspace", "home", "tools"])(
    "refuses to resume existing history after the %s binding changes",
    (field) => {
      const first = new NativeCodexSessionStore(runtime, context, []);
      first.save("original-native-thread");
      first.release();
      const changedContext = { ...context };
      const changedRuntime = { ...runtime };
      let tools: unknown[] = [];
      if (field === "model") changedContext.model = "different-model";
      if (field === "effort") changedContext.reasoningEffort = "high";
      if (field === "workspace") changedRuntime.workspace = anotherDirectory("different-workspace");
      if (field === "home") changedRuntime.home = anotherDirectory("different-home");
      if (field === "tools") tools = [{ name: "additional-tool" }];
      const next = new NativeCodexSessionStore(changedRuntime, changedContext, tools);
      try {
        expect(() => next.read()).toThrow(/binding changed/);
        expect(JSON.parse(fs.readFileSync(recordPath(), "utf8")).threadId).toBe("original-native-thread");
      } finally {
        next.release();
      }
    },
  );

  it("serializes writers for one session and permits independent sessions", () => {
    const first = new NativeCodexSessionStore(runtime, context, []);
    expect(() => new NativeCodexSessionStore(runtime, context, [])).toThrow(/already in use/);
    const independent = new NativeCodexSessionStore({ ...runtime, sessionKey: "other-run/agent-reader" }, context, []);
    independent.save("other-native-thread");
    independent.release();
    first.save("first-native-thread");
    first.release();
    const next = new NativeCodexSessionStore(runtime, context, []);
    expect(next.read()?.threadId).toBe("first-native-thread");
    next.release();
  });

  it("does not release a lease belonging to another owner", () => {
    const store = new NativeCodexSessionStore(runtime, context, []);
    const replacement = JSON.stringify({ pid: process.pid, owner: "another-owner" });
    fs.writeFileSync(`${recordPath()}.lock`, replacement);
    store.release();
    expect(fs.readFileSync(`${recordPath()}.lock`, "utf8")).toBe(replacement);
  });

  it("rejects malformed leases without deleting them", () => {
    const lock = `${recordPath()}.lock`;
    const invalid = JSON.stringify({ pid: -1, owner: "invalid-owner" });
    fs.writeFileSync(lock, invalid);
    expect(() => new NativeCodexSessionStore(runtime, context, [])).toThrow(/Invalid native Codex session lease/);
    expect(fs.readFileSync(lock, "utf8")).toBe(invalid);
  });

  it("preserves history and the lease after a crashed Worker until explicit recovery", () => {
    const first = new NativeCodexSessionStore(runtime, context, []);
    first.save("history-before-worker-crash");
    first.release();
    const original = fs.readFileSync(recordPath(), "utf8");
    const lock = `${recordPath()}.lock`;
    const stale = JSON.stringify({ pid: 2_000_000_000, owner: "crashed-worker" });
    fs.writeFileSync(lock, stale);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(() => new NativeCodexSessionStore(runtime, context, []))
      .toThrow(/Stale.*explicit recovery.*history was preserved/);
    expect(fs.readFileSync(lock, "utf8")).toBe(stale);
    expect(fs.readFileSync(recordPath(), "utf8")).toBe(original);
  });

  it("does not treat an inability to inspect a process as permission to replace its lease", () => {
    const lock = `${recordPath()}.lock`;
    const existing = JSON.stringify({ pid: 10_000, owner: "protected-worker" });
    fs.writeFileSync(lock, existing);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    expect(() => new NativeCodexSessionStore(runtime, context, [])).toThrow(/operation not permitted/);
    expect(fs.readFileSync(lock, "utf8")).toBe(existing);
  });

  it("does not reclaim a stale lease by deleting a concurrent owner's replacement", () => {
    const lock = `${recordPath()}.lock`;
    const previousPid = 2_000_000_000;
    const replacement = JSON.stringify({ pid: process.pid, owner: "concurrent-owner" });
    fs.writeFileSync(lock, JSON.stringify({ pid: previousPid, owner: "stale-owner" }));
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      expect(pid).toBe(previousPid);
      // Another process won reclamation after our stale record was read.
      fs.writeFileSync(lock, replacement);
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(() => new NativeCodexSessionStore(runtime, context, [])).toThrow();
    expect(fs.readFileSync(lock, "utf8")).toBe(replacement);
  });
});
