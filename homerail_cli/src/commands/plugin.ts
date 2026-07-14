import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { scaffoldPluginProject } from "homerail-plugin-sdk";
import { isHomerailPluginId } from "homerail-protocol";
import { getClient } from "../index.js";
import {
  inspectPluginDevelopmentProject,
  startPluginDevServer,
} from "../plugin/dev-server.js";
import {
  codegenPluginProject,
  generatePluginPublisherKey,
  packPluginProject,
  readPluginArchive,
  testPluginProject,
  validatePluginProject,
  verifyPluginArchiveFile,
} from "../plugin/workflows.js";

interface PluginGlobalOptions {
  json?: boolean;
  baseUrl?: string;
  requestTimeout?: number;
}

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

type JsonObject = Record<string, unknown>;

export function registerPluginCommand(program: Command): void {
  const plugin = program
    .command("plugin")
    .description("Develop, package, install, and manage HomeRail plugins");

  plugin
    .command("init <id> [directory]")
    .description("Scaffold a data-only scenario plugin in an empty directory")
    .option("--template <template>", "Plugin template (scenario)", "scenario")
    .option("--name <name>", "Human-readable plugin name")
    .option("--plugin-version <version>", "Initial semantic version", "0.1.0")
    .action(async (
      id: string,
      directory: string | undefined,
      options: { template: string; name?: string; pluginVersion: string },
    ) => runPluginAction(async () => {
      if (options.template !== "scenario") {
        throw new Error(`Unsupported plugin template: ${options.template}`);
      }
      const destination = path.resolve(directory ?? id.split(".").at(-1) ?? id);
      const result = scaffoldPluginProject(destination, id, {
        name: options.name,
        version: options.pluginVersion,
      });
      output(program, result, [
        `Scaffolded ${id} in ${result.root}`,
        `${result.files.length} files created`,
      ]);
    }));

  plugin
    .command("codegen [directory]")
    .description("Generate TypeScript types from plugin schemas")
    .option("--check", "Fail when generated types are missing or stale")
    .action(async (directory: string | undefined, options: { check?: boolean }) => runPluginAction(async () => {
      const result = codegenPluginProject(directory, { check: options.check });
      output(program, result, [
        options.check
          ? `Generated types are current: ${result.output}`
          : result.changed
            ? `Generated plugin types: ${result.output}`
            : `Plugin types already current: ${result.output}`,
      ]);
    }));

  plugin
    .command("validate [directory]")
    .description("Statically validate a plugin project and its safe execution-tier eligibility")
    .action(async (directory: string | undefined) => runPluginAction(async () => {
      const report = validatePluginProject(directory);
      output(program, report, validationLines(report));
      if (!report.valid) process.exitCode = 1;
    }));

  plugin
    .command("dev [directory]")
    .description("Run the live validation and fixture-matrix browser")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port (0 selects an available port)", parsePort, 4174)
    .option("--once", "Inspect once without starting a server")
    .action(async (
      directory: string | undefined,
      options: { host: string; port: number; once?: boolean },
    ) => runPluginAction(async () => {
      const root = path.resolve(directory ?? ".");
      if (options.once) {
        const report = inspectPluginDevelopmentProject(root);
        output(program, report, developmentReportLines(report));
        if (report.error || !report.validation?.valid || !report.fixtures?.valid) process.exitCode = 1;
        return;
      }
      const development = await startPluginDevServer(root, {
        host: options.host,
        port: options.port,
      });
      output(program, { root, url: development.url }, [
        `Plugin development browser: ${development.url}`,
        `Project: ${root}`,
      ]);
      const close = async (): Promise<void> => {
        await development.close();
      };
      process.once("SIGINT", () => void close());
      process.once("SIGTERM", () => void close());
    }));

  plugin
    .command("test [directory]")
    .description("Run plugin projection fixtures and renderer viewport/state matrix")
    .option("--matrix", "Include phone, desktop, and TV renderer state matrix")
    .action(async (directory: string | undefined) => runPluginAction(async () => {
      const report = testPluginProject(directory);
      output(program, report, [
        `${report.valid ? "PASS" : "FAIL"}: ${report.fixtures.length} projection fixture(s)`,
        `Renderer matrix: ${report.renderer_matrix.length} case(s)`,
        ...report.fixtures.map((fixture) => (
          `${fixture.passed ? "PASS" : "FAIL"} ${fixture.file}${fixture.message ? ` — ${fixture.message}` : ""}`
        )),
      ]);
      if (!report.valid) process.exitCode = 1;
    }));

  plugin
    .command("publisher-keygen <publisher> [directory]")
    .description("Generate an Ed25519 publisher key and public trust descriptor")
    .action(async (publisher: string, directory: string | undefined) => runPluginAction(async () => {
      const report = generatePluginPublisherKey(directory ?? ".", publisher);
      output(program, report, [
        `Generated publisher key: ${report.publisher}`,
        `Key id: ${report.key_id}`,
        `Private key: ${report.private_key}`,
        `Trust descriptor: ${report.trust_descriptor}`,
      ]);
    }));

  plugin
    .command("pack [directory]")
    .description("Build a deterministic .hrp archive and lock file")
    .option("-o, --out <file>", "Output .hrp path")
    .option("--force", "Replace an existing output file")
    .option("--publisher <publisher>", "Publisher identity for a signed archive")
    .option("--sign-key <file>", "Ed25519 PKCS#8 private key PEM")
    .action(async (
      directory: string | undefined,
      options: { out?: string; force?: boolean; publisher?: string; signKey?: string },
    ) => runPluginAction(async () => {
      if ((options.publisher === undefined) !== (options.signKey === undefined)) {
        throw new Error("Use --publisher and --sign-key together");
      }
      const report = packPluginProject(directory, {
        output: options.out,
        force: options.force,
        ...(options.publisher && options.signKey ? {
          publisher: options.publisher,
          signing_key: readPrivateSigningKey(options.signKey),
        } : {}),
      });
      output(program, report, [
        `Packed ${report.plugin_id}@${report.plugin_version}`,
        `Archive: ${report.output}`,
        `SHA-256: ${report.archive_digest}`,
        `Signature: ${report.signature_state}${report.key_id ? ` (${report.key_id})` : ""}`,
      ]);
    }));

  plugin
    .command("verify <archive>")
    .description("Verify an .hrp archive, deterministic lock, and plugin payload")
    .action(async (archive: string) => runPluginAction(async () => {
      const report = verifyPluginArchiveFile(archive);
      output(program, report, [
        `Verified ${report.plugin_id}@${report.plugin_version}`,
        `Archive SHA-256: ${report.archive_digest}`,
        `Payload SHA-256: ${report.payload_digest}`,
        `Signature: ${report.signature_state}${report.key_id ? ` (${report.key_id})` : ""}`,
        `M4 data-only eligible: ${report.data_only_eligible ? "yes" : "no"}`,
        `M5 projection Action eligible: ${report.m5_projection_action_eligible ? "yes" : "no"}`,
        `M5 Workflow resolution eligible: ${report.m5_workflow_resolution_eligible ? "yes" : "no"}`,
        `M6 isolated custom Renderer eligible: ${report.m6_custom_renderer_eligible ? "yes" : "no"}`,
      ]);
    }));

  plugin
    .command("publisher-list")
    .description("List trusted and revoked plugin publisher keys")
    .action(async () => runPluginAction(async () => {
      const client = getClient(globalOptions(program));
      const response = await client.get<ApiResponse<JsonObject>>("/api/plugins/publishers");
      const data = requireSuccess(response);
      const publishers = Array.isArray(data.publishers) ? data.publishers : [];
      output(program, data, publishers.length
        ? publishers.map((entry) => publisherLine(entry))
        : ["No plugin publisher keys are configured."]);
    }));

  plugin
    .command("publisher-trust <descriptor>")
    .description("Trust an Ed25519 publisher descriptor through the Manager")
    .option("--expected-revision <revision>", "Publisher trust compare-and-swap", parseNonNegativeRevision)
    .action(async (
      descriptor: string,
      options: { expectedRevision?: number },
    ) => runPluginAction(async () => {
      const entry = readPublisherDescriptor(descriptor);
      const client = getClient(globalOptions(program));
      const expectedRevision = options.expectedRevision ?? await publisherTrustRevision(client, entry.key_id);
      const response = await client.put<ApiResponse<JsonObject>>(
        `/api/plugins/publishers/${encodeURIComponent(entry.key_id)}`,
        {
          publisher: entry.publisher,
          public_key_spki: entry.public_key_spki,
          state: "trusted",
          expected_revision: expectedRevision,
        },
      );
      const data = requireSuccess(response);
      output(program, data, [`Trusted ${entry.publisher} (${entry.key_id}).`]);
    }));

  plugin
    .command("publisher-revoke <key-id>")
    .description("Permanently revoke a publisher key and disable affected plugins")
    .requiredOption("--reason <reason>", "Auditable revocation reason")
    .option("--expected-revision <revision>", "Publisher trust compare-and-swap", parseRevision)
    .action(async (
      keyId: string,
      options: { reason: string; expectedRevision?: number },
    ) => runPluginAction(async () => {
      const client = getClient(globalOptions(program));
      const current = await publisherTrustRecord(client, keyId);
      const response = await client.put<ApiResponse<JsonObject>>(
        `/api/plugins/publishers/${encodeURIComponent(keyId)}`,
        {
          publisher: String(current.publisher),
          public_key_spki: String(current.public_key_spki),
          state: "revoked",
          expected_revision: options.expectedRevision ?? Number(current.revision),
          reason: options.reason,
        },
      );
      const data = requireSuccess(response);
      output(program, data, [`Revoked ${keyId}.`, "Affected active plugins were disabled fail-closed."]);
    }));

  plugin
    .command("registry-source <registry-id> <source-url>")
    .description("Configure an HTTPS plugin registry source and immutable root pin")
    .requiredOption("--root-key-id <key-id>", "Pinned Ed25519 registry root key id")
    .action(async (
      registryId: string,
      sourceUrl: string,
      options: { rootKeyId: string },
    ) => runPluginAction(async () => {
      const client = getClient(globalOptions(program));
      const response = await client.put<ApiResponse<JsonObject>>(
        `/api/plugins/registries/${encodeRegistryId(registryId)}/source`,
        { source_url: sourceUrl, root_key_id: assertKeyId(options.rootKeyId) },
      );
      const data = requireSuccess(response);
      output(program, data, [
        `Configured registry ${registryId}`,
        `Source: ${sourceUrl}`,
        `Root pin: ${options.rootKeyId}`,
      ]);
    }));

  plugin
    .command("registry-sync <registry-id> <index>")
    .description("Submit exact canonical signed registry-index bytes to the Manager")
    .action(async (registryId: string, index: string) => runPluginAction(async () => {
      const indexPath = path.resolve(index);
      const bytes = fs.readFileSync(indexPath);
      if (!bytes.byteLength || bytes.byteLength > 1024 * 1024) {
        throw new Error("Plugin registry index size is outside the 1 MiB limit");
      }
      const client = getClient(globalOptions(program));
      const response = await client.post<ApiResponse<JsonObject>>(
        `/api/plugins/registries/${encodeRegistryId(registryId)}/sync`,
        { index_base64: bytes.toString("base64url") },
      );
      const data = requireSuccess(response);
      output(program, data, [
        `Synchronized registry ${registryId}`,
        `Index: ${indexPath}`,
      ]);
    }));

  for (const operation of ["install", "update"] as const) {
    plugin
      .command(`registry-${operation} <registry-id> <archive>`)
      .description(`${operation === "install" ? "Install" : "Stage an update for"} an exact signed registry release`)
      .action(async (registryId: string, archive: string) => runPluginAction(async () => {
        const verified = verifyPluginArchiveFile(archive);
        const input = readPluginArchive(archive);
        const client = getClient(globalOptions(program));
        const response = await client.postBinary<ApiResponse<JsonObject>>(
          `/api/plugins/registries/${encodeRegistryId(registryId)}/releases/`
            + `${encodePluginId(verified.plugin_id)}/${encodeURIComponent(verified.plugin_version)}/${operation}`,
          input.content,
        );
        const data = requireSuccess(response);
        output(program, data, [
          `${operation === "install" ? "Installed" : "Staged update"} ${verified.plugin_id}@${verified.plugin_version}`,
          `Registry: ${registryId}`,
          "The candidate is not activated or enabled implicitly.",
        ]);
      }));
  }

  plugin
    .command("registry-activate <registry-id> <id> <version>")
    .description("Activate an installed release through its fresh signed Registry catalog")
    .option("--expected-revision <revision>", "Activation revision compare-and-swap", parseRevision)
    .action(async (
      registryId: string,
      id: string,
      version: string,
      options: { expectedRevision?: number },
    ) => runPluginAction(async () => {
      const client = getClient(globalOptions(program));
      const expectedRevision = options.expectedRevision
        ?? (await getPluginVersionState(client, id)).activation.revision;
      const response = await client.post<ApiResponse<JsonObject>>(
        `/api/plugins/registries/${encodeRegistryId(registryId)}/releases/`
          + `${encodePluginId(id)}/${encodeURIComponent(version)}/activate`,
        { expected_revision: expectedRevision },
      );
      const data = requireSuccess(response);
      output(program, data, [
        `Activated ${id}@${version} from registry ${registryId}.`,
        "The release remains disabled until registry-enable succeeds.",
      ]);
    }));

  plugin
    .command("registry-enable <registry-id> <id>")
    .description("Enable the active release only while its signed Registry catalog is fresh")
    .option("--expected-revision <revision>", "Activation revision compare-and-swap", parseRevision)
    .action(async (
      registryId: string,
      id: string,
      options: { expectedRevision?: number },
    ) => runPluginAction(async () => {
      const client = getClient(globalOptions(program));
      const state = await getPluginVersionState(client, id);
      const expectedRevision = options.expectedRevision ?? state.activation.revision;
      const response = await client.put<ApiResponse<JsonObject>>(
        `/api/plugins/registries/${encodeRegistryId(registryId)}/plugins/${encodePluginId(id)}/enabled`,
        {
          enabled: true,
          expected_revision: expectedRevision,
          expected_active_version: state.activation.active_version,
        },
      );
      const data = requireSuccess(response);
      output(program, data, [`Enabled ${id} from fresh registry ${registryId}.`]);
    }));

  plugin
    .command("install <archive>")
    .description("Verify and upload an .hrp archive to the Manager staging lifecycle")
    .option("--staging", "Install through the staging channel")
    .option("--local", "Install through the local-development channel")
    .action(async (
      archive: string,
      options: { staging?: boolean; local?: boolean },
    ) => runPluginAction(async () => {
      const channel = installChannel(options);
      const verified = verifyPluginArchiveFile(archive);
      const input = readPluginArchive(archive);
      const client = getClient(globalOptions(program));
      const response = await client.postBinary<ApiResponse<JsonObject>>(
        `/api/plugins/install?channel=${encodeURIComponent(channel)}`,
        input.content,
      );
      const data = requireSuccess(response);
      output(program, data, [
        `Installed ${String(data.plugin_id ?? verified.plugin_id)}@${String(data.plugin_version ?? verified.plugin_version)}`,
        `Channel: ${channel}`,
        "The package remains disabled until `hr plugin enable` succeeds.",
      ]);
    }));

  plugin
    .command("permissions <id>")
    .description("Inspect or update version-scoped plugin permission grants")
    .option("--plugin-version <version>", "Plugin version (required for grant updates)")
    .option("--grant <permission>", "Grant one declared permission")
    .option("--deny <permission>", "Deny one declared permission")
    .option("--expected-revision <revision>", "Grant revision compare-and-swap", parseRevision)
    .action(async (
      id: string,
      options: { pluginVersion?: string; grant?: string; deny?: string; expectedRevision?: number },
    ) => runPluginAction(async () => {
      if (options.grant && options.deny) throw new Error("Use only one of --grant or --deny");
      const client = getClient(globalOptions(program));
      if (options.grant || options.deny) {
        if (!options.pluginVersion) throw new Error("--plugin-version is required when changing a permission grant");
        const expectedRevision = options.expectedRevision ?? await resolveGrantRevision(
          client,
          id,
          options.pluginVersion,
          String(options.grant ?? options.deny),
        );
        const response = await client.put<ApiResponse<JsonObject>>(
          `/api/plugins/${encodePluginId(id)}/permissions`,
          {
            version: options.pluginVersion,
            permission: options.grant ?? options.deny,
            status: options.grant ? "granted" : "denied",
            expected_revision: expectedRevision,
          },
        );
        const data = requireSuccess(response);
        output(program, data, [
          `${options.grant ? "Granted" : "Denied"} ${String(options.grant ?? options.deny)}`,
          `Plugin: ${id}@${options.pluginVersion}`,
        ]);
        return;
      }
      const query = options.pluginVersion ? `?version=${encodeURIComponent(options.pluginVersion)}` : "";
      const response = await client.get<ApiResponse<JsonObject>>(
        `/api/plugins/${encodePluginId(id)}/permissions${query}`,
      );
      const data = requireSuccess(response);
      const grants = Array.isArray(data.grants) ? data.grants : [];
      output(program, data, grants.length
        ? grants.map((grant) => permissionLine(grant))
        : [`No permission grants recorded for ${id}${options.pluginVersion ? `@${options.pluginVersion}` : ""}.`]);
    }));

  registerEnabledCommand(plugin, program, "enable", true);
  registerEnabledCommand(plugin, program, "disable", false);

  plugin
    .command("activate <id> <version>")
    .description("Select an installed plugin version; activation leaves it disabled")
    .option("--expected-revision <revision>", "Activation revision compare-and-swap", parseRevision)
    .action(async (
      id: string,
      version: string,
      options: { expectedRevision?: number },
    ) => runPluginAction(async () => {
      const client = getClient(globalOptions(program));
      const expectedRevision = options.expectedRevision ?? (await getPluginVersionState(client, id)).activation.revision;
      const response = await client.put<ApiResponse<JsonObject>>(
        `/api/plugins/${encodePluginId(id)}/active-version`,
        {
          version,
          expected_revision: expectedRevision,
        },
      );
      const data = requireSuccess(response);
      output(program, data, [
        `Activated ${id}@${version}`,
        "The selected version is disabled until explicitly enabled.",
      ]);
    }));

  plugin
    .command("rollback <id> [version]")
    .description("Move the active pointer to a prior installed version without a database downgrade")
    .option("--expected-revision <revision>", "Activation revision compare-and-swap", parseRevision)
    .action(async (
      id: string,
      version: string | undefined,
      options: { expectedRevision?: number },
    ) => runPluginAction(async () => {
      const client = getClient(globalOptions(program));
      const expectedRevision = options.expectedRevision ?? (await getPluginVersionState(client, id)).activation.revision;
      const response = await client.post<ApiResponse<JsonObject>>(
        `/api/plugins/${encodePluginId(id)}/rollback`,
        {
          ...(version ? { version } : {}),
          expected_revision: expectedRevision,
        },
      );
      const data = requireSuccess(response);
      output(program, data, [
        `Rolled back ${id}${version ? ` to ${version}` : " to its prior installed version"}.`,
        "Installation and migration history were retained.",
      ]);
    }));

  plugin
    .command("uninstall <id>")
    .description("Remove executable package files while retaining immutable install history")
    .action(async (id: string) => runPluginAction(async () => {
      const client = getClient(globalOptions(program));
      const state = await getPluginVersionState(client, id);
      const response = await client.delete<ApiResponse<JsonObject>>(
        `/api/plugins/${encodePluginId(id)}`,
        { expected_version_set_digest: state.version_set_digest },
      );
      const data = requireSuccess(response);
      output(program, data, [
        `Uninstalled ${id}.`,
        `Retained version records: ${String(data.retained_versions ?? 0)}`,
      ]);
    }));

  plugin
    .command("runtime-preflight <id> <version>")
    .description("Attest a staged executable HRP on the configured Node before enablement")
    .action(async (id: string, version: string) => runPluginAction(async () => {
      const client = getClient(globalOptions(program));
      const response = await client.post<ApiResponse<JsonObject>>(
        `/api/plugins/${encodePluginId(id)}/versions/${encodeURIComponent(version)}/runtime/preflight`,
        {},
      );
      const data = requireSuccess(response);
      output(program, data, [
        `Runtime preflight passed for ${id}@${version}.`,
        `Node: ${String(data.node_id ?? "?")}`,
        `Image: ${String(data.image_digest ?? "?")}`,
        `Measurement: ${String(data.measurement_digest ?? "?")}`,
      ]);
    }));

  plugin
    .command("doctor <id>")
    .description("Inspect installation, package, health, and activation state")
    .action(async (id: string) => runPluginAction(async () => {
      const client = getClient(globalOptions(program));
      const response = await client.get<ApiResponse<JsonObject>>(
        `/api/plugins/${encodePluginId(id)}/doctor`,
      );
      const data = response.data ?? {};
      output(program, data, doctorLines(id, data));
      if (!response.success || data.healthy === false) process.exitCode = 1;
    }));
}

function registerEnabledCommand(
  plugin: Command,
  program: Command,
  name: "enable" | "disable",
  enabled: boolean,
): void {
  plugin
    .command(`${name} <id>`)
    .description(`${enabled ? "Enable" : "Disable"} the active version of a plugin`)
    .action(async (id: string) => runPluginAction(async () => {
      const client = getClient(globalOptions(program));
      const state = await getPluginVersionState(client, id);
      const response = await client.put<ApiResponse<JsonObject>>(
        `/api/plugins/${encodePluginId(id)}/enabled`,
        {
          enabled,
          expected_revision: state.activation.revision,
          expected_active_version: state.activation.active_version,
        },
      );
      const data = requireSuccess(response);
      output(program, data, [`${enabled ? "Enabled" : "Disabled"} ${id}.`]);
    }));
}

async function runPluginAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (cause) {
    console.error(`Error: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  }
}

function globalOptions(program: Command): PluginGlobalOptions {
  return program.opts() as PluginGlobalOptions;
}

function output(program: Command, value: unknown, lines: string[]): void {
  if (globalOptions(program).json) {
    console.log(JSON.stringify(value));
    return;
  }
  for (const line of lines) console.log(line);
}

function requireSuccess<T>(response: ApiResponse<T>): T {
  if (!response.success) {
    throw new Error(response.error ?? response.message ?? "Manager rejected the plugin request");
  }
  if (response.data === undefined) throw new Error("Manager plugin response omitted data");
  return response.data;
}

function installChannel(options: { staging?: boolean; local?: boolean }): "staging" | "local" {
  const selected = [options.staging && "staging", options.local && "local"]
    .filter((value): value is "staging" | "local" => Boolean(value));
  if (selected.length > 1) throw new Error("Use only one install channel flag");
  return selected[0] ?? "staging";
}

function encodePluginId(pluginId: string): string {
  if (!isHomerailPluginId(pluginId)) throw new Error(`Invalid HomeRail plugin id: ${pluginId}`);
  return encodeURIComponent(pluginId);
}

function encodeRegistryId(registryId: string): string {
  if (!/^[a-z][a-z0-9._-]{0,79}$/.test(registryId)) {
    throw new Error(`Invalid HomeRail plugin registry id: ${registryId}`);
  }
  return encodeURIComponent(registryId);
}

function assertKeyId(keyId: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(keyId)) throw new Error("Registry root key id must be sha256:<64 lowercase hex>");
  return keyId;
}

async function getPluginVersionState(
  client: ReturnType<typeof getClient>,
  pluginId: string,
): Promise<{ activation: { revision: number; active_version: string }; version_set_digest: string }> {
  const response = await client.get<ApiResponse<JsonObject>>(
    `/api/plugins/${encodePluginId(pluginId)}/versions`,
  );
  const data = requireSuccess(response);
  const activation = data.activation;
  if (!activation || typeof activation !== "object" || Array.isArray(activation)) {
    throw new Error(`Plugin ${pluginId} has no active installation`);
  }
  const revision = (activation as JsonObject).revision;
  const activeVersion = (activation as JsonObject).active_version;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1 || typeof activeVersion !== "string") {
    throw new Error(`Plugin ${pluginId} returned invalid activation state`);
  }
  if (typeof data.version_set_digest !== "string" || !/^[a-f0-9]{64}$/.test(data.version_set_digest)) {
    throw new Error(`Plugin ${pluginId} returned invalid version-set digest`);
  }
  return {
    activation: { revision: Number(revision), active_version: activeVersion },
    version_set_digest: data.version_set_digest,
  };
}

async function resolveGrantRevision(
  client: ReturnType<typeof getClient>,
  pluginId: string,
  pluginVersion: string,
  permission: string,
): Promise<number> {
  const response = await client.get<ApiResponse<JsonObject>>(
    `/api/plugins/${encodePluginId(pluginId)}/permissions?version=${encodeURIComponent(pluginVersion)}`,
  );
  const data = requireSuccess(response);
  const grant = (Array.isArray(data.grants) ? data.grants : []).find((candidate) => (
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && (candidate as JsonObject).permission === permission
  ));
  const revision = grant && typeof grant === "object" ? (grant as JsonObject).revision : undefined;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
    throw new Error(`Permission ${permission} was not declared for ${pluginId}@${pluginVersion}`);
  }
  return Number(revision);
}

function validationLines(report: ReturnType<typeof validatePluginProject>): string[] {
  const lines = [
    `${report.valid ? "VALID" : "INVALID"}: ${report.plugin_id}@${report.plugin_version}`,
    `M4 data-only eligible: ${report.data_only_eligible ? "yes" : "no"}`,
    `M5 projection Action eligible: ${report.m5_projection_action_eligible ? "yes" : "no"}`,
    `M5 Workflow resolution eligible: ${report.m5_workflow_resolution_eligible ? "yes" : "no"}`,
    `M6 isolated custom Renderer eligible: ${report.m6_custom_renderer_eligible ? "yes" : "no"}`,
    `Payload files: ${report.files.length}`,
  ];
  for (const issue of report.issues) {
    lines.push(`${issue.severity.toUpperCase()} ${issue.path}: ${issue.message}`);
  }
  return lines;
}

function developmentReportLines(report: ReturnType<typeof inspectPluginDevelopmentProject>): string[] {
  if (report.error) return [`INVALID: ${report.error}`];
  return [
    ...(report.validation ? validationLines(report.validation) : ["No validation report was produced."]),
    `Fixture matrix: ${report.fixtures?.valid ? "PASS" : "FAIL"}`,
    `Renderer cases: ${report.fixtures?.renderer_matrix.length ?? 0}`,
  ];
}

function permissionLine(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const grant = value as JsonObject;
  return `${String(grant.permission ?? "?")}: ${String(grant.status ?? "?")} (revision ${String(grant.revision ?? "?")})`;
}

function publisherLine(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const entry = value as JsonObject;
  return `${String(entry.publisher ?? "?")}: ${String(entry.state ?? "?")} ${String(entry.key_id ?? "?")} (revision ${String(entry.revision ?? "?")})`;
}

function readPrivateSigningKey(fileValue: string): Buffer {
  const file = path.resolve(fileValue);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Plugin signing key must be a regular file, not a symlink");
  }
  if (!stat.size || stat.size > 16 * 1024) throw new Error("Plugin signing key size is invalid");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Plugin signing key must not be readable or writable by group/other users");
  }
  return fs.readFileSync(file);
}

function readPublisherDescriptor(fileValue: string): {
  publisher: string;
  key_id: string;
  public_key_spki: string;
} {
  const file = path.resolve(fileValue);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || !stat.size || stat.size > 16 * 1024) {
    throw new Error("Publisher descriptor must be a bounded regular file, not a symlink");
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Publisher descriptor must be an object");
  }
  const descriptor = value as JsonObject;
  if (
    Object.keys(descriptor).sort().join(",")
      !== "algorithm,descriptor_version,key_id,public_key_spki,publisher"
    || descriptor.descriptor_version !== 1
    || descriptor.algorithm !== "Ed25519"
    || typeof descriptor.publisher !== "string"
    || typeof descriptor.key_id !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(descriptor.key_id)
    || typeof descriptor.public_key_spki !== "string"
  ) throw new Error("Publisher descriptor is malformed or unsupported");
  return {
    publisher: descriptor.publisher,
    key_id: descriptor.key_id,
    public_key_spki: descriptor.public_key_spki,
  };
}

async function publisherTrustRecords(client: ReturnType<typeof getClient>): Promise<JsonObject[]> {
  const response = await client.get<ApiResponse<JsonObject>>("/api/plugins/publishers");
  const data = requireSuccess(response);
  return (Array.isArray(data.publishers) ? data.publishers : [])
    .filter((entry): entry is JsonObject => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
}

async function publisherTrustRecord(
  client: ReturnType<typeof getClient>,
  keyId: string,
): Promise<JsonObject> {
  const record = (await publisherTrustRecords(client)).find((entry) => entry.key_id === keyId);
  if (!record) throw new Error(`Publisher key is not configured: ${keyId}`);
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1) {
    throw new Error(`Publisher key has invalid revision: ${keyId}`);
  }
  return record;
}

async function publisherTrustRevision(
  client: ReturnType<typeof getClient>,
  keyId: string,
): Promise<number> {
  const record = (await publisherTrustRecords(client)).find((entry) => entry.key_id === keyId);
  if (!record) return 0;
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1) {
    throw new Error(`Publisher key has invalid revision: ${keyId}`);
  }
  return Number(record.revision);
}

function doctorLines(id: string, data: JsonObject): string[] {
  const versions = Array.isArray(data.versions) ? data.versions : [];
  return [
    `${data.healthy === false ? "UNHEALTHY" : "HEALTHY"}: ${id}`,
    `Installed versions: ${versions.length}`,
    ...versions.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return JSON.stringify(entry);
      const value = entry as JsonObject;
      const installation = value.installation && typeof value.installation === "object" && !Array.isArray(value.installation)
        ? value.installation as JsonObject
        : {};
      return `${String(value.plugin_version ?? "?")} ${value.active ? "active" : "inactive"} ${String(installation.health_state ?? "unknown")}`;
    }),
  ];
}

function parseRevision(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("revision must be a positive integer");
  }
  return parsed;
}

function parseNonNegativeRevision(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("revision must be a non-negative integer");
  }
  return parsed;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new InvalidArgumentError("port must be an integer between 0 and 65535");
  }
  return parsed;
}
