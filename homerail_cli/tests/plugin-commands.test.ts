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

function addProjectionAction(root: string): void {
  const manifestFile = path.join(root, "homerail.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
    id: string;
    capabilities: Array<{ actions: string[] }>;
    schemas: Array<{ id: string; file: string }>;
    kinds: Array<{ versions: Array<{ actions: string[] }> }>;
    tools: Array<Record<string, unknown>>;
    actions: Array<Record<string, unknown>>;
  };
  const contentSchema = JSON.parse(
    fs.readFileSync(path.join(root, "schemas/card-content.v1.schema.json"), "utf8"),
  ) as Record<string, unknown>;
  fs.writeFileSync(path.join(root, "schemas/card-action.v1.schema.json"), `${JSON.stringify({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      id: { type: "string", minLength: manifest.id.length + 2, maxLength: 256 },
      content: contentSchema,
    },
    required: ["id", "content"],
    additionalProperties: false,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "ui/projectors/card-action.v1.json"), `${JSON.stringify({
    projection_version: 1,
    type: "direct_ui_node",
    kind: `${manifest.id}/card`,
    kind_version: 1,
    node_id_pointer: "/id",
    content_pointer: "/content",
    omit_content_fields: [],
    fallback: { title_pointer: "/content/title", summary_pointer: "/content/summary" },
    defaults: { surface: "task", importance: "primary", density: "detail", persistence: "session" },
  }, null, 2)}\n`);
  manifest.schemas.push({ id: "card-action-v1", file: "schemas/card-action.v1.schema.json" });
  manifest.capabilities[0].actions.push("replace_card");
  manifest.kinds[0].versions[0].actions.push("replace_card");
  manifest.tools.push({
    id: "replace_card_tool",
    description: "Replace the selected card through an Action-bound Tool.",
    exposure: ["action"],
    input_schema: "card-action-v1",
    output_schema: "card-content-v1",
    effect: "write",
    permissions: [],
    confirmation: "never",
    handler: { type: "projection", file: "ui/projectors/card-action.v1.json" },
  });
  manifest.actions.push({
    id: "replace_card",
    intent: `${manifest.id}.replace_card`,
    tool: "replace_card_tool",
  });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

function convertProjectionActionToRuntime(root: string): void {
  const manifestFile = path.join(root, "homerail.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
    runtime: Record<string, unknown>;
    tools: Array<{ id: string; handler: Record<string, unknown> }>;
  };
  manifest.runtime = {
    trust: "sandboxed_runtime",
    plugin_api: 1,
    entrypoint: { file: "runtime/index.js", args: [] },
  };
  manifest.tools.find((tool) => tool.id === "replace_card_tool")!.handler = {
    type: "runtime",
    method: "replace_card",
  };
  fs.mkdirSync(path.join(root, "runtime"));
  fs.writeFileSync(path.join(root, "runtime/index.js"), "export {};\n");
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

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
      "publisher-keygen",
      "pack",
      "verify",
      "publisher-list",
      "publisher-trust",
      "publisher-revoke",
      "registry-source",
      "registry-sync",
      "registry-install",
      "registry-update",
      "registry-activate",
      "registry-enable",
      "install",
      "permissions",
      "enable",
      "disable",
      "activate",
      "rollback",
      "uninstall",
      "runtime-preflight",
      "doctor",
    ]);
  });
});

describe("plugin PDK workflow", () => {
  it("generates a private publisher key and deterministically signs an HRP", async () => {
    const root = path.join(temporaryRoot, "signed-plugin");
    const keys = path.join(temporaryRoot, "publisher");
    const archive = path.join(temporaryRoot, "signed-plugin.hrp");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    scaffoldPluginProject(root, "com.example.signed-plugin");

    await runJson("publisher-keygen", "com.example", keys);
    const generated = readLastJson(log) as Record<string, unknown>;
    expect(generated).toEqual(expect.objectContaining({
      publisher: "com.example",
      key_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    }));
    expect(fs.statSync(String(generated.private_key)).mode & 0o077).toBe(0);

    await runJson(
      "pack",
      root,
      "--out",
      archive,
      "--publisher",
      "com.example",
      "--sign-key",
      String(generated.private_key),
    );
    const packed = readLastJson(log) as Record<string, unknown>;
    expect(packed).toEqual(expect.objectContaining({
      signature_state: "signed",
      publisher: "com.example",
      key_id: generated.key_id,
    }));
    await runJson("verify", archive);
    expect(readLastJson(log)).toEqual(expect.objectContaining({
      signature_state: "untrusted",
      publisher: "com.example",
      key_id: generated.key_id,
      archive_digest: packed.archive_digest,
    }));
    expect(process.exitCode).toBeUndefined();
  });

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
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: ["projection_action_required"],
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
      data_only_eligible: true,
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: ["projection_action_required"],
    }));
    expect(fs.readFileSync(archive).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    await runJson("verify", archive);
    expect(readLastJson(log)).toEqual(expect.objectContaining({
      archive,
      plugin_id: "com.example.release-notes",
      plugin_version: "1.2.3",
      data_only_eligible: true,
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: ["projection_action_required"],
      archive_digest: packed.archive_digest,
      payload_digest: packed.payload_digest,
    }));
    expect(process.exitCode).toBeUndefined();
  });

  it("validates, packs, and verifies an M5 projection Action while retaining the M4 field", async () => {
    const root = path.join(temporaryRoot, "action-card");
    const archive = path.join(temporaryRoot, "action-card.hrp");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    scaffoldPluginProject(root, "com.example.action-card");
    addProjectionAction(root);

    await runJson("validate", root);
    expect(readLastJson(log)).toEqual(expect.objectContaining({
      valid: true,
      data_only_eligible: false,
      m5_projection_action_eligible: true,
      m5_projection_action_eligibility_reasons: [],
    }));

    await runJson("pack", root, "--out", archive);
    const packed = readLastJson(log) as Record<string, unknown>;
    expect(packed).toEqual(expect.objectContaining({
      output: archive,
      data_only_eligible: false,
      m5_projection_action_eligible: true,
      m5_projection_action_eligibility_reasons: [],
    }));

    await runJson("verify", archive);
    expect(readLastJson(log)).toEqual(expect.objectContaining({
      archive,
      data_only_eligible: false,
      m5_projection_action_eligible: true,
      m5_projection_action_eligibility_reasons: [],
      archive_digest: packed.archive_digest,
      payload_digest: packed.payload_digest,
    }));
    expect(process.exitCode).toBeUndefined();
  });

  it("packs, verifies, and uploads a valid runtime Action for Manager-controlled staging", async () => {
    const root = path.join(temporaryRoot, "runtime-action");
    const archive = path.join(temporaryRoot, "runtime-action.hrp");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    scaffoldPluginProject(root, "com.example.runtime-action");
    addProjectionAction(root);
    convertProjectionActionToRuntime(root);

    await runJson("validate", root);
    expect(readLastJson(log)).toEqual(expect.objectContaining({
      valid: true,
      data_only_eligible: false,
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: expect.arrayContaining([
        "runtime_trust_not_data_only",
        "runtime_entrypoint_present",
        "runtime_handler_present",
      ]),
    }));
    expect(process.exitCode).toBeUndefined();

    await runJson("pack", root, "--out", archive);
    expect(readLastJson(log)).toEqual(expect.objectContaining({
      output: archive,
      data_only_eligible: false,
      m5_projection_action_eligible: false,
    }));
    await runJson("verify", archive);
    expect(readLastJson(log)).toEqual(expect.objectContaining({
      archive,
      data_only_eligible: false,
      m5_projection_action_eligible: false,
      m5_projection_action_eligibility_reasons: expect.arrayContaining(["runtime_handler_present"]),
    }));
    expect(process.exitCode).toBeUndefined();

    const fetchSpy = mockApi({
      success: true,
      data: {
        plugin_id: "com.example.runtime-action",
        plugin_version: "0.1.0",
        installation: { lifecycle_state: "staged", health_state: "unchecked" },
        activation: { enabled: false },
      },
    });
    await runJson("install", archive, "--staging");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
  it("maps signed registry source, sync, install, and staged update commands to exact Manager routes", async () => {
    const root = path.join(temporaryRoot, "registry-install");
    const archive = path.join(temporaryRoot, "registry-install.hrp");
    const index = path.join(temporaryRoot, "registry-index.json");
    scaffoldPluginProject(root, "com.example.registry-install", { version: "1.2.3" });
    packPluginProject(root, { output: archive });
    fs.writeFileSync(index, '{"signed":"index"}\n');
    const archiveBytes = fs.readFileSync(archive);
    const indexBytes = fs.readFileSync(index);
    const fetchSpy = mockApi({
      success: true,
      data: {
        activation: { revision: 7, active_version: "1.2.3" },
        version_set_digest: "a".repeat(64),
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runJson(
      "registry-source",
      "stable.example",
      "https://registry.example/index.json",
      "--root-key-id",
      `sha256:${"a".repeat(64)}`,
    );
    await runJson("registry-sync", "stable.example", index);
    await runJson("registry-install", "stable.example", archive);
    await runJson("registry-update", "stable.example", archive);
    await runJson(
      "registry-activate", "stable.example", "com.example.registry-install", "1.2.3",
      "--expected-revision", "7",
    );
    await runJson("registry-enable", "stable.example", "com.example.registry-install");

    expect(fetchSpy.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ["http://localhost:19191/api/plugins/registries/stable.example/source", "PUT"],
      ["http://localhost:19191/api/plugins/registries/stable.example/sync", "POST"],
      [
        "http://localhost:19191/api/plugins/registries/stable.example/releases/"
          + "com.example.registry-install/1.2.3/install",
        "POST",
      ],
      [
        "http://localhost:19191/api/plugins/registries/stable.example/releases/"
          + "com.example.registry-install/1.2.3/update",
        "POST",
      ],
      [
        "http://localhost:19191/api/plugins/registries/stable.example/releases/"
          + "com.example.registry-install/1.2.3/activate",
        "POST",
      ],
      ["http://localhost:19191/api/plugins/com.example.registry-install/versions", "GET"],
      [
        "http://localhost:19191/api/plugins/registries/stable.example/plugins/"
          + "com.example.registry-install/enabled",
        "PUT",
      ],
    ]);
    expect(fetchSpy.mock.calls[0][1]?.body).toBe(JSON.stringify({
      source_url: "https://registry.example/index.json",
      root_key_id: `sha256:${"a".repeat(64)}`,
    }));
    expect(fetchSpy.mock.calls[1][1]?.body).toBe(JSON.stringify({
      index_base64: indexBytes.toString("base64url"),
    }));
    expect(Buffer.from(fetchSpy.mock.calls[2][1]?.body as Uint8Array)).toEqual(archiveBytes);
    expect(Buffer.from(fetchSpy.mock.calls[3][1]?.body as Uint8Array)).toEqual(archiveBytes);
    expect(fetchSpy.mock.calls[4][1]?.body).toBe(JSON.stringify({ expected_revision: 7 }));
    expect(fetchSpy.mock.calls[6][1]?.body).toBe(JSON.stringify({
      enabled: true,
      expected_revision: 7,
      expected_active_version: "1.2.3",
    }));
    expect(process.exitCode).toBeUndefined();
  });

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

  it("uploads an M5 projection Action archive instead of rejecting its preserved M4=false field", async () => {
    const root = path.join(temporaryRoot, "install-action");
    const archive = path.join(temporaryRoot, "install-action.hrp");
    scaffoldPluginProject(root, "com.example.install-action");
    addProjectionAction(root);
    expect(packPluginProject(root, { output: archive })).toMatchObject({
      data_only_eligible: false,
      m5_projection_action_eligible: true,
    });
    const fetchSpy = mockApi({
      success: true,
      data: {
        plugin_id: "com.example.install-action",
        plugin_version: "0.1.0",
        data_only_eligible: false,
        m5_projection_action_eligible: true,
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "node", "hr", "--json", "plugin", "install", archive, "--staging",
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("http://localhost:19191/api/plugins/install?channel=staging");
    expect(process.exitCode).toBeUndefined();
  });

  it("maps permissions, enablement, activation, rollback, runtime preflight, uninstall, and doctor to version-safe APIs", async () => {
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
    await runJson("runtime-preflight", "com.example.a", "1.0.0");
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
      ["http://localhost:19191/api/plugins/com.example.a/versions/1.0.0/runtime/preflight", "POST", "{}"],
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
