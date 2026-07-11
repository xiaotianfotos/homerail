import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";
import { startPluginDevServer } from "../src/plugin/dev-server.js";
import { packPluginProject } from "../src/plugin/workflows.js";
import { scaffoldPluginProject } from "homerail-plugin-sdk";

let temporaryRoot: string;
let previousHome: string | undefined;
let previousManagerUrl: string | undefined;

beforeEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-plugin-cli-"));
  previousHome = process.env.HOMERAIL_HOME;
  previousManagerUrl = process.env.HOMERAIL_MANAGER_URL;
  process.env.HOMERAIL_HOME = path.join(temporaryRoot, "home");
  delete process.env.HOMERAIL_MANAGER_URL;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
  else process.env.HOMERAIL_HOME = previousHome;
  if (previousManagerUrl === undefined) delete process.env.HOMERAIL_MANAGER_URL;
  else process.env.HOMERAIL_MANAGER_URL = previousManagerUrl;
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("plugin command registration", () => {
  it("exposes the complete M4 PDK and lifecycle command line", () => {
    const program = createProgram();
    const plugin = program.commands.find((command) => command.name() === "plugin");
    expect(plugin).toBeDefined();
    expect(plugin!.commands.map((command) => command.name())).toEqual([
      "init",
      "codegen",
      "validate",
      "dev",
      "test",
      "pack",
      "verify",
      "install",
      "permissions",
      "enable",
      "disable",
      "activate",
      "rollback",
      "uninstall",
      "doctor",
    ]);
  });
});

describe("plugin PDK workflow", () => {
  it("runs empty directory -> scaffold -> codegen -> validate -> dev/test matrix -> pack -> verify", async () => {
    const root = path.join(temporaryRoot, "release-notes");
    const archive = path.join(temporaryRoot, "release-notes.hrp");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runJson(
      "init",
      "com.example.release-notes",
      root,
      "--template",
      "scenario",
      "--plugin-version",
      "1.2.3",
    );
    expect(readLastJson(log)).toEqual(expect.objectContaining({ root }));
    expect(fs.existsSync(path.join(root, "homerail.plugin.json"))).toBe(true);

    await runJson("codegen", root);
    const codegen = readLastJson(log) as Record<string, unknown>;
    expect(codegen.changed).toBe(true);
    expect(fs.existsSync(path.join(root, ".homerail", "generated", "plugin-types.d.ts"))).toBe(true);

    await runJson("codegen", root, "--check");
    expect(readLastJson(log)).toEqual(expect.objectContaining({ checked: true, changed: false }));

    await runJson("validate", root);
    expect(readLastJson(log)).toEqual(expect.objectContaining({
      plugin_id: "com.example.release-notes",
      valid: true,
      data_only_eligible: true,
    }));

    await runJson("dev", root, "--once");
    const development = readLastJson(log) as Record<string, unknown>;
    expect(development.error).toBeUndefined();
    expect(development.fixtures).toEqual(expect.objectContaining({ valid: true }));

    await runJson("test", root, "--matrix");
    expect(readLastJson(log)).toEqual(expect.objectContaining({
      valid: true,
      fixtures: [expect.objectContaining({ file: "basic.json", passed: true })],
      renderer_matrix: expect.arrayContaining([
        expect.objectContaining({ device: "phone", state: "loading" }),
        expect.objectContaining({ device: "desktop", state: "error" }),
        expect.objectContaining({ device: "tv", state: "stale" }),
      ]),
    }));

    await runJson("pack", root, "--out", archive);
    const packed = readLastJson(log) as Record<string, unknown>;
    expect(packed).toEqual(expect.objectContaining({
      output: archive,
      plugin_id: "com.example.release-notes",
      plugin_version: "1.2.3",
    }));
    expect(fs.readFileSync(archive).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    await runJson("verify", archive);
    expect(readLastJson(log)).toEqual(expect.objectContaining({
      archive,
      plugin_id: "com.example.release-notes",
      plugin_version: "1.2.3",
      data_only_eligible: true,
      archive_digest: packed.archive_digest,
      payload_digest: packed.payload_digest,
    }));
    expect(process.exitCode).toBeUndefined();
  });

  it("produces byte-for-byte deterministic archives and refuses accidental overwrite", () => {
    const root = path.join(temporaryRoot, "deterministic");
    const first = path.join(temporaryRoot, "first.hrp");
    const second = path.join(temporaryRoot, "second.hrp");
    scaffoldPluginProject(root, "com.example.deterministic");

    const left = packPluginProject(root, { output: first });
    const right = packPluginProject(root, { output: second });
    expect(left.archive_digest).toBe(right.archive_digest);
    expect(fs.readFileSync(first)).toEqual(fs.readFileSync(second));
    expect(() => packPluginProject(root, { output: first })).toThrow(/EEXIST/);
    expect(() => packPluginProject(root, { output: first, force: true })).not.toThrow();
  });

  it("refuses to overwrite an output symlink even with force", () => {
    const root = path.join(temporaryRoot, "target-symlink");
    const outside = path.join(temporaryRoot, "outside-target.hrp");
    const output = path.join(temporaryRoot, "target-link.hrp");
    scaffoldPluginProject(root, "com.example.target-symlink");
    fs.writeFileSync(outside, "do not replace\n");
    fs.symlinkSync(outside, output);

    expect(() => packPluginProject(root, { output, force: true })).toThrow(/must not be a symlink/);
    expect(fs.lstatSync(output).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("do not replace\n");
  });

  it("refuses an output path whose parent chain contains a symlink", () => {
    const root = path.join(temporaryRoot, "parent-symlink");
    const outsideDirectory = path.join(temporaryRoot, "outside-directory");
    const linkedParent = path.join(temporaryRoot, "linked-parent");
    const output = path.join(linkedParent, "nested", "archive.hrp");
    scaffoldPluginProject(root, "com.example.parent-symlink");
    fs.mkdirSync(outsideDirectory);
    fs.symlinkSync(outsideDirectory, linkedParent, "dir");

    expect(() => packPluginProject(root, { output, force: true })).toThrow(/parent must not contain a symlink/);
    expect(fs.existsSync(path.join(outsideDirectory, "nested"))).toBe(false);
  });

  it("serves a live no-store development report", async () => {
    const root = path.join(temporaryRoot, "dev-server");
    scaffoldPluginProject(root, "com.example.dev-server");
    const development = await startPluginDevServer(root, { port: 0 });
    try {
      const response = await fetch(`${development.url}/api/report`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(expect.objectContaining({
        validation: expect.objectContaining({ valid: true }),
        fixtures: expect.objectContaining({
          valid: true,
          fixtures: [expect.objectContaining({
            renderer_models: [expect.objectContaining({
              model: expect.objectContaining({ title: "Server example" }),
            })],
          })],
        }),
      }));
      const page = await (await fetch(development.url)).text();
      expect(page).toContain("HomeRail Plugin Development Browser");
      expect(page).toContain('id="viewports"');
      expect(page).toContain("['phone','desktop','tv']");
    } finally {
      await development.close();
    }
  });
});

describe("plugin Manager lifecycle commands", () => {
  it("uploads the verified .hrp as raw binary with the selected channel", async () => {
    const root = path.join(temporaryRoot, "install");
    const archive = path.join(temporaryRoot, "install.hrp");
    scaffoldPluginProject(root, "com.example.install");
    packPluginProject(root, { output: archive });
    const archiveBytes = fs.readFileSync(archive);
    const fetchSpy = mockApi({
      success: true,
      data: {
        plugin_id: "com.example.install",
        plugin_version: "0.1.0",
        data_only_eligible: true,
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "node", "hr", "--json", "plugin", "install", archive, "--staging",
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:19191/api/plugins/install?channel=staging");
    expect(init).toEqual(expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "Content-Type": "application/vnd.homerail.plugin+zip",
      }),
    }));
    expect(typeof init?.body).not.toBe("string");
    expect(Buffer.from(init?.body as Uint8Array)).toEqual(archiveBytes);
    expect(Buffer.from(init?.body as Uint8Array).toString("base64"))
      .not.toBe(init?.body);
    expect(process.exitCode).toBeUndefined();
  });

  it("maps permissions, enablement, activation, rollback, uninstall, and doctor to version-safe APIs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const data = url.endsWith("/doctor")
        ? { healthy: true, versions: [{ plugin_version: "1.0.0", active: true, installation: { health_state: "healthy" } }] }
        : url.endsWith("/versions")
          ? { activation: { revision: 4, active_version: "1.0.0" }, version_set_digest: "f".repeat(64), versions: [] }
        : url.endsWith("/permissions") || url.includes("/permissions?")
          ? { grants: [{ permission: "artifact:read", status: "granted", revision: 2 }] }
          : url.match(/\/plugins\/[^/]+$/) && init?.method === "DELETE"
            ? { retained_versions: 2 }
            : { activation: { revision: 4 } };
      return response({ success: true, data });
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runJson("permissions", "com.example.a", "--plugin-version", "1.0.0");
    await runJson("permissions", "com.example.a", "--plugin-version", "1.0.0", "--grant", "artifact:read", "--expected-revision", "1");
    await runJson("enable", "com.example.a");
    await runJson("disable", "com.example.a");
    await runJson("activate", "com.example.a", "2.0.0", "--expected-revision", "3");
    await runJson("rollback", "com.example.a", "1.0.0", "--expected-revision", "4");
    await runJson("uninstall", "com.example.a");
    await runJson("doctor", "com.example.a");

    expect(fetchSpy.mock.calls.map(([url, init]) => [String(url), init?.method, init?.body])).toEqual([
      ["http://localhost:19191/api/plugins/com.example.a/permissions?version=1.0.0", "GET", undefined],
      ["http://localhost:19191/api/plugins/com.example.a/permissions", "PUT", JSON.stringify({
        version: "1.0.0",
        permission: "artifact:read",
        status: "granted",
        expected_revision: 1,
      })],
      ["http://localhost:19191/api/plugins/com.example.a/versions", "GET", undefined],
      ["http://localhost:19191/api/plugins/com.example.a/enabled", "PUT", JSON.stringify({
        enabled: true,
        expected_revision: 4,
        expected_active_version: "1.0.0",
      })],
      ["http://localhost:19191/api/plugins/com.example.a/versions", "GET", undefined],
      ["http://localhost:19191/api/plugins/com.example.a/enabled", "PUT", JSON.stringify({
        enabled: false,
        expected_revision: 4,
        expected_active_version: "1.0.0",
      })],
      ["http://localhost:19191/api/plugins/com.example.a/active-version", "PUT", JSON.stringify({ version: "2.0.0", expected_revision: 3 })],
      ["http://localhost:19191/api/plugins/com.example.a/rollback", "POST", JSON.stringify({ version: "1.0.0", expected_revision: 4 })],
      ["http://localhost:19191/api/plugins/com.example.a/versions", "GET", undefined],
      ["http://localhost:19191/api/plugins/com.example.a", "DELETE", JSON.stringify({ expected_version_set_digest: "f".repeat(64) })],
      ["http://localhost:19191/api/plugins/com.example.a/doctor", "GET", undefined],
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("sets a failing exit code for locally invalid input and Manager rejections", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node", "hr", "plugin", "verify", path.join(temporaryRoot, "missing.hrp"),
    ]);
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join(" ")).toContain("Error:");

    process.exitCode = undefined;
    mockApi({ success: false, error: "required permission is ungranted" });
    await createProgram().parseAsync([
      "node", "hr", "plugin", "enable", "com.example.rejected",
    ]);
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join(" ")).toContain("required permission is ungranted");
  });
});

async function runJson(...args: string[]): Promise<void> {
  await createProgram().parseAsync(["node", "hr", "--json", "plugin", ...args]);
}

function readLastJson(log: ReturnType<typeof vi.spyOn>): unknown {
  const call = log.mock.calls.at(-1);
  expect(call).toBeDefined();
  return JSON.parse(String(call![0]));
}

function mockApi(body: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(response(body, status));
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}
