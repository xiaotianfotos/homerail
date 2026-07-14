import type { Command } from "commander";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { HomeRailClient } from "../client.js";
import type { BaseResponse } from "../client.js";
import {
  DEFAULT_MANAGER_URL,
  configuredAssetRoot,
  configuredManagerAccessUrl,
  configuredManagerHost,
  configuredManagerLocalUrl,
  configuredUiPublicUrl,
  configuredUiHttpPublicUrl,
  configuredUiHost,
  configuredUiHttpPort,
  configuredUiPort,
  configuredManagerPort,
  detectedMachineHost,
  ensureHomerailHome,
  getHomerailHome,
  loadLocalConfig,
  loadLocalSecrets,
  managerWsUrl,
  resolveConfiguredManagerAdminToken,
} from "../local-config.js";
import {
  HOMERAIL_UI_ADMIN_PROXY_ENABLED,
  HOMERAIL_UI_ORIGIN,
  HOMERAIL_UNSAFE_ALLOW_PUBLIC_MANAGER_WITHOUT_AUTH,
  createUiAdminProxyPolicy,
} from "../ui-admin-proxy.js";
import { applyStoredModelConfig } from "./config.js";
import { dockerNotFoundDetail, resolveDockerBinary } from "../docker-bin.js";
import {
  buildLocalRuntimeServiceStatuses,
  getRuntimeServiceControlStatus,
  installRuntimeService,
  uninstallRuntimeService,
  type LocalRuntimeServiceStatus,
  type RuntimeServiceControlStatus,
} from "../local-service-lifecycle.js";

interface GlobalOpts {
  json?: boolean;
  baseUrl?: string;
  requestTimeout?: number;
}

interface StartOpts {
  /** Set to false by commander when `--no-build-worker-image` is passed. */
  buildWorkerImage?: boolean;
  /** @deprecated legacy field name; prefer buildWorkerImage. */
  noBuildWorkerImage?: boolean;
  rebuildWorkerImage?: boolean;
  ui?: boolean;
  host?: string;
  public?: boolean;
  publicUrl?: string;
  uiHost?: string;
  uiPort?: string;
  uiPublicUrl?: string;
  enableTextMode?: boolean;
  unsafeNoAdminToken?: boolean;
}

interface UiStartOpts {
  host?: string;
  port?: string;
  public?: boolean;
  publicUrl?: string;
  managerUrl?: string;
  enableTextMode?: boolean;
  unsafeNoAdminToken?: boolean;
}

interface RuntimeStatus {
  managerPid?: number;
  nodePid?: number;
  uiPid?: number;
  uiHttpsPid?: number;
  uiHttpPid?: number;
  managerPidRunning: boolean;
  nodePidRunning: boolean;
  uiPidRunning: boolean;
  uiHttpsPidRunning: boolean;
  uiHttpPidRunning: boolean;
  managerHealthy: boolean;
  managerBindHost: string;
  managerUrl: string;
  managerAccessUrl: string;
  managerPublicUrl?: string;
  uiBindHost: string;
  uiUrl: string;
  uiPublicUrl?: string;
  uiHttpsUrl: string;
  uiHttpsPublicUrl?: string;
  uiHttpUrl: string;
  uiHttpPublicUrl?: string;
  uiTextModeEnabled: boolean;
  runtime?: unknown;
  serviceControl: RuntimeServiceControlStatus;
  services: LocalRuntimeServiceStatus[];
}

interface RuntimeRestartOpts extends StartOpts {
  ui?: boolean;
}

interface RuntimeInstallOpts {
  load?: boolean;
}

interface RuntimeUninstallOpts {
  unload?: boolean;
}

interface UiStatus {
  uiPid?: number;
  uiHttpsPid?: number;
  uiHttpPid?: number;
  uiPidRunning: boolean;
  uiHttpsPidRunning: boolean;
  uiHttpPidRunning: boolean;
  uiHost: string;
  uiPort: number;
  uiUrl: string;
  uiPublicUrl?: string;
  uiHttpsPort: number;
  uiHttpsUrl: string;
  uiHttpsPublicUrl?: string;
  uiHttpPort: number;
  uiHttpUrl: string;
  uiHttpPublicUrl?: string;
  uiTextModeEnabled: boolean;
}

interface UiServiceState {
  pid: number;
  host: string;
  port: number;
  protocol?: "http" | "https";
  mode?: "dev" | "static";
  managerUrl?: string;
  publicUrl?: string;
  textModeEnabled?: boolean;
  startedAt: number;
}

interface ManagerServiceState {
  pid: number;
  host: string;
  port: number;
  accessUrl: string;
  publicUrl?: string;
  startedAt: number;
}

type RuntimeServiceName = "manager" | "node" | "worker" | "ui" | "ui-https";

export const WORKER_IMAGE_SOURCE_LABEL = "org.homerail.worker.source_fingerprint";
const WORKER_IMAGE_TAG = "homerail-worker:latest";
const MANAGER_ADMIN_ORIGINS_ENV = "HOMERAIL_MANAGER_ADMIN_ORIGINS";
type WorkerImageRuntimeStatus = "checking" | "building" | "ready" | "error" | "skipped";
const WORKER_IMAGE_SOURCE_INPUTS = [
  "homerail_worker/Dockerfile",
  "homerail_worker/package.json",
  "homerail_worker/package-lock.json",
  "homerail_worker/tsconfig.json",
  "homerail_worker/src",
  "homerail_protocol/package.json",
  "homerail_protocol/package-lock.json",
  "homerail_protocol/tsconfig.json",
  "homerail_protocol/src",
];

export type WorkerImageBuildReason = "forced" | "missing" | "stale";

/** Merge operator-provided exact Origins with the two UI proxy origins. */
export function mergeManagerAdminOrigins(
  configured: string | undefined,
  uiUrls: readonly string[],
): string {
  const origins = new Set<string>();
  for (const value of (configured ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`${MANAGER_ADMIN_ORIGINS_ENV} contains an invalid Origin`); }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || parsed.origin !== value
    ) throw new Error(`${MANAGER_ADMIN_ORIGINS_ENV} must contain exact http(s) Origins without paths`);
    origins.add(value);
  }
  for (const value of uiUrls) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`Agent UI public URL is invalid: ${value}`); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Agent UI public URL must use http(s): ${value}`);
    }
    origins.add(parsed.origin);
  }
  return [...origins].sort().join(",");
}

export interface UiAdminProxyProcessEnvOptions {
  uiBindHost: string;
  uiPublicUrl: string;
  managerUrl: string;
  adminToken?: string;
  unsafeNoAdminToken?: boolean;
}

/** Compute, rather than inherit, the only mode in which a UI may proxy writes. */
export function resolveUiAdminProxyProcessEnv(
  options: UiAdminProxyProcessEnvOptions,
): Record<string, string> {
  const uiOrigin = new URL(options.uiPublicUrl).origin;
  const policy = createUiAdminProxyPolicy({
    enabled: true,
    uiOrigin,
    uiBindHost: options.uiBindHost,
    managerUrl: options.managerUrl,
    adminToken: options.unsafeNoAdminToken ? undefined : options.adminToken,
    unsafeAllowPublicNoAuth: options.unsafeNoAdminToken,
  });
  return {
    [HOMERAIL_UI_ORIGIN]: uiOrigin,
    [HOMERAIL_UI_ADMIN_PROXY_ENABLED]: policy.enabled ? "1" : "0",
    // Explicitly erase an inherited credential outside the loopback boundary.
    HOMERAIL_MANAGER_ADMIN_TOKEN: policy.enabled && !options.unsafeNoAdminToken ? options.adminToken || "" : "",
    ...(options.unsafeNoAdminToken
      ? { [HOMERAIL_UNSAFE_ALLOW_PUBLIC_MANAGER_WITHOUT_AUTH]: "1" }
      : {}),
  };
}

export interface ModelConfigApplyStatus {
  applied: boolean;
  action: string;
  detail: string;
}

export function shouldAbortStartForModelConfig(result: ModelConfigApplyStatus): boolean {
  if (isMissingModelCredential(result.detail)) return false;
  return result.action === "failed";
}

export function isMissingModelCredential(detail: string): boolean {
  return /\bAPI key is required\b/i.test(detail);
}

export function dockerMissingMessage(binary = resolveDockerBinary()): string {
  return [
    `Docker is required to build homerail-worker:latest, but the Docker CLI was not found (${dockerNotFoundDetail(binary)}).`,
    "Install Docker Desktop on the host that runs HomeRail, or prebuild homerail-worker:latest and rerun `hr start --no-build-worker-image`.",
  ].join(" ");
}

export function registerRuntimeCommands(program: Command): void {
  program
    .command("start")
    .description("Start the local Manager and Node runtime together")
    .option("--no-build-worker-image", "Skip building homerail-worker:latest when missing")
    .option("--rebuild-worker-image", "Force rebuilding homerail-worker:latest before DAG provisioning")
    .option("--host <host>", "Manager bind host")
    .option("--public", "Bind Manager publicly and bind Agent UI to the machine access IP")
    .option("--unsafe-no-admin-token", "UNSAFE: allow unauthenticated public Manager/UI access for trusted test networks")
    .option("--public-url <url>", "Public Manager access URL advertised to Agent UI")
    .option("--ui", "Also start the Agent UI server")
    .option("--ui-host <host>", "Agent UI bind host")
    .option("--ui-port <port>", "Agent UI HTTPS port")
    .option("--ui-public-url <url>", "Public Agent UI access URL shown in status")
    .option("--enable-text-mode", "Enable the temporary Agent UI text mode")
    .action(async (opts: StartOpts) => {
      const globalOpts = program.opts() as GlobalOpts;
      try {
        process.exitCode = await startRuntime(globalOpts, opts);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  const runtime = program
    .command("runtime")
    .description("Inspect and manage local HomeRail runtime services");

  runtime
    .command("status")
    .description("Show local Manager and Node service status")
    .action(async () => {
      const globalOpts = program.opts() as GlobalOpts;
      const status = await getRuntimeStatus(globalOpts);
      if (globalOpts.json) {
        console.log(JSON.stringify(status));
        return;
      }
      printRuntimeStatus(status);
    });

  runtime
    .command("stop")
    .description("Stop local Manager, Node, Worker, and Agent UI services")
    .action(() => {
      const stopped = stopRuntime();
      console.log(`Stopped ${stopped} local service(s).`);
    });

  runtime
    .command("restart")
    .description("Restart local Manager and Node runtime services")
    .option("--no-build-worker-image", "Skip building homerail-worker:latest when missing")
    .option("--rebuild-worker-image", "Force rebuilding homerail-worker:latest before DAG provisioning")
    .option("--host <host>", "Manager bind host")
    .option("--public", "Bind Manager publicly and bind Agent UI to the machine access IP")
    .option("--unsafe-no-admin-token", "UNSAFE: allow unauthenticated public Manager/UI access for trusted test networks")
    .option("--public-url <url>", "Public Manager access URL advertised to Agent UI")
    .option("--ui", "Also start the Agent UI server")
    .option("--ui-host <host>", "Agent UI bind host")
    .option("--ui-port <port>", "Agent UI HTTPS port")
    .option("--ui-public-url <url>", "Public Agent UI access URL shown in status")
    .option("--enable-text-mode", "Enable the temporary Agent UI text mode")
    .action(async (opts: RuntimeRestartOpts) => {
      const globalOpts = program.opts() as GlobalOpts;
      try {
        const stopped = stopRuntime();
        if (!globalOpts.json) console.log(`Stopped ${stopped} local service(s).`);
        process.exitCode = await startRuntime(globalOpts, opts);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  runtime
    .command("logs")
    .description("Print local runtime log file paths")
    .action(() => {
      console.log(`Manager: ${logPath("manager")}`);
      console.log(`Node:    ${logPath("node")}`);
      console.log(`UI HTTPS: ${logPath("ui-https")}`);
      console.log(`UI HTTP:  ${logPath("ui")}`);
    });

  const printLifecycleResult = (result: ReturnType<typeof installRuntimeService> | ReturnType<typeof uninstallRuntimeService>) => {
    const globalOpts = program.opts() as GlobalOpts;
    if (globalOpts.json) {
      console.log(JSON.stringify(result));
      return;
    }
    const verb = result.action === "install" ? "Installed" : "Uninstalled";
    if (!result.status.supported) {
      console.log(`Service lifecycle unsupported on ${result.status.platform}: ${result.status.detail}`);
      return;
    }
    console.log(`${verb} ${result.status.label}`);
    console.log(`Path: ${result.status.config_path}`);
    console.log(`Installed: ${result.status.installed ? "yes" : "no"}`);
    if (result.action === "install") console.log(`Loaded: ${result.loaded ? "yes" : "no"}`);
    if (result.action === "uninstall") console.log(`Unloaded: ${result.unloaded ? "yes" : "no"}`);
  };

  const installCommand = runtime
    .command("install")
    .alias("register")
    .description("Install/register the local HomeRail runtime service")
    .option("--no-load", "Write the service definition without loading it")
    .action((opts: RuntimeInstallOpts) => {
      try {
        const result = installRuntimeService({ load: opts.load });
        printLifecycleResult(result);
        process.exitCode = result.status.supported ? 0 : 1;
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
  installCommand.showHelpAfterError();

  runtime
    .command("uninstall")
    .alias("unregister")
    .description("Uninstall/delete the local HomeRail runtime service")
    .option("--no-unload", "Delete the service definition without unloading it")
    .action((opts: RuntimeUninstallOpts) => {
      try {
        const result = uninstallRuntimeService({ unload: opts.unload });
        printLifecycleResult(result);
        process.exitCode = result.status.supported ? 0 : 1;
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  runtime
    .command("delete-service")
    .description("Alias for runtime uninstall")
    .option("--no-unload", "Delete the service definition without unloading it")
    .action((opts: RuntimeUninstallOpts) => {
      try {
        const result = uninstallRuntimeService({ unload: opts.unload });
        printLifecycleResult(result);
        process.exitCode = result.status.supported ? 0 : 1;
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  const ui = program
    .command("ui")
    .description("Manage the local Agent UI server");

  ui
    .command("start")
    .description("Start the local Agent UI server")
    .option("--host <host>", "Agent UI bind host")
    .option("--port <port>", "Agent UI HTTPS port")
    .option("--public", "Bind Agent UI to the machine access IP")
    .option("--unsafe-no-admin-token", "UNSAFE: allow public UI mutations without a Manager admin token")
    .option("--public-url <url>", "Public Agent UI access URL shown in status")
    .option("--enable-text-mode", "Enable the temporary Agent UI text mode")
    .action(async (opts: UiStartOpts) => {
      const globalOpts = program.opts() as GlobalOpts;
      try {
        const status = await startUiServer(globalOpts, opts);
        if (globalOpts.json) {
          console.log(JSON.stringify(status));
        } else {
          printUiStatus(status);
        }
        process.exitCode = status.uiPidRunning ? 0 : 1;
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  ui
    .command("status")
    .description("Show local Agent UI service status")
    .action(() => {
      const globalOpts = program.opts() as GlobalOpts;
      const status = getUiStatus();
      if (globalOpts.json) {
        console.log(JSON.stringify(status));
      } else {
        printUiStatus(status);
      }
    });

  ui
    .command("stop")
    .description("Stop the local Agent UI server")
    .action(() => {
      const stopped = (stopService("ui-https") ? 1 : 0) + (stopService("ui") ? 1 : 0);
      console.log(`Stopped ${stopped} local UI service(s).`);
    });

  ui
    .command("logs")
    .description("Print local Agent UI log file path")
    .action(() => {
      console.log(`UI HTTPS: ${logPath("ui-https")}`);
      console.log(`UI HTTP:  ${logPath("ui")}`);
    });
}

async function startRuntime(globalOpts: GlobalOpts, opts: StartOpts): Promise<number> {
  ensureHomerailHome();
  if (opts.unsafeNoAdminToken && !opts.public) {
    throw new Error("--unsafe-no-admin-token requires --public");
  }
  if (opts.unsafeNoAdminToken) {
    console.warn("WARNING: public Manager and Agent UI authentication is disabled for this test runtime.");
  }
  const cfg = loadLocalConfig();
  const assetRoot = configuredAssetRoot(cfg);
  const assetEnv: Record<string, string> = assetRoot ? { HOMERAIL_ASSET_DIR: assetRoot } : {};
  const managerHost = opts.public ? "0.0.0.0" : configuredManagerHost(cfg, opts.host);
  const managerLocalUrl = configuredManagerLocalUrl(cfg, globalOpts.baseUrl);
  const managerPublicUrl = configuredManagerAccessUrl(cfg, opts.publicUrl || globalOpts.baseUrl);
  const hasExplicitManagerPublicUrl = hasManagerPublicUrl(cfg, opts.publicUrl || globalOpts.baseUrl);
  const managerPort = configuredManagerPort(cfg);
  const uiBindHost = opts.public && !opts.uiHost ? detectedMachineHost() : configuredUiHost(cfg, opts.uiHost);
  const uiHttpsPort = configuredUiPort(cfg, opts.uiPort);
  const uiHttpPort = configuredUiHttpPort(cfg);
  const secrets = loadLocalSecrets();
  const managerAdminOrigins = mergeManagerAdminOrigins(
    process.env[MANAGER_ADMIN_ORIGINS_ENV] ?? secrets[MANAGER_ADMIN_ORIGINS_ENV],
    [
      configuredUiPublicUrl(cfg, uiBindHost, uiHttpsPort, opts.uiPublicUrl),
      configuredUiHttpPublicUrl(cfg, uiBindHost, uiHttpPort),
    ],
  );
  const client = new HomeRailClient({ baseUrl: managerLocalUrl, timeoutMs: globalOpts.requestTimeout });

  ensureBuiltArtifact("homerail_manager/dist/index.js");
  ensureBuiltArtifact("homerail_node/dist/cli.js");

  const before = await getRuntimeStatus(globalOpts);
  if (!before.managerHealthy) {
    const pid = startService("manager", "homerail_manager/dist/index.js", {
      HOMERAIL_HOME: getHomerailHome(),
      HOMERAIL_MANAGER_PORT: String(managerPort),
      HOMERAIL_MANAGER_HOST: managerHost,
      HOMERAIL_MANAGER_ADMIN_ORIGINS: managerAdminOrigins,
      ...(opts.unsafeNoAdminToken
        ? {
          HOMERAIL_MANAGER_ADMIN_TOKEN: "",
          [HOMERAIL_UNSAFE_ALLOW_PUBLIC_MANAGER_WITHOUT_AUTH]: "1",
        }
        : {}),
      ...(hasExplicitManagerPublicUrl ? { HOMERAIL_MANAGER_PUBLIC_URL: managerPublicUrl } : {}),
      HOMERAIL_PROJECT_ID: cfg.node?.projectId || "p1",
      ...assetEnv,
    });
    writeManagerState({
      pid,
      host: managerHost,
      port: managerPort,
      accessUrl: client.baseUrl,
      publicUrl: managerPublicUrl,
      startedAt: Date.now(),
    });
    console.log(`Started Manager pid=${pid}`);
    await waitForManager(client);
  } else {
    console.log(`Manager already healthy at ${client.baseUrl}`);
  }

  const applyResult = await applyStoredModelConfig(client);
  if (applyResult.applied) {
    console.log(`Model config ${applyResult.action}: ${applyResult.detail}`);
  } else {
    console.log(`Model config not applied: ${applyResult.detail}`);
    if (shouldAbortStartForModelConfig(applyResult)) {
      if (applyResult.detail.includes("Unknown provider_id")) {
        console.error(
          "Model config failed because the running Manager rejected the configured provider. " +
          "This can happen when an older or unmanaged Manager is already listening; run `hr runtime status` " +
          "and clean up the stale service before retrying.",
        );
      }
      return 1;
    }
    if (isMissingModelCredential(applyResult.detail)) {
      console.log("Next: run `hr model configure <provider-or-endpoint-alias>` to add provider credentials before running DAGs.");
    }
  }

  if (opts.ui) {
    const uiStatus = await startUiServer(globalOpts, {
      host: opts.uiHost,
      port: opts.uiPort,
      public: opts.public,
      publicUrl: opts.uiPublicUrl,
      managerUrl: opts.public && !hasExplicitManagerPublicUrl ? undefined : managerPublicUrl,
      enableTextMode: opts.enableTextMode,
      unsafeNoAdminToken: opts.unsafeNoAdminToken,
    });
    console.log(`Agent UI: ${uiStatus.uiPidRunning ? "PASS" : "FAIL"} ${uiStatus.uiUrl}`);
  }

  // commander maps --no-build-worker-image to opts.buildWorkerImage === false.
  const shouldBuildImage = opts.buildWorkerImage === false ? false : cfg.runtime?.buildWorkerImage !== false;
  if (shouldBuildImage) {
    try {
      await ensureWorkerImage(Boolean(opts.rebuildWorkerImage));
    } catch (err) {
      writeWorkerImageRuntimeStatus("error", {
        error: err instanceof Error ? err.message : String(err),
        message: "DAG worker image could not be prepared.",
      });
      throw err;
    }
  } else {
    writeWorkerImageRuntimeStatus("skipped", {
      message: "DAG worker image build was skipped for this startup.",
    });
  }

  const runtimeClient = new HomeRailClient({ baseUrl: client.baseUrl, timeoutMs: globalOpts.requestTimeout });
  await waitForManager(runtimeClient);
  const runtimeStatus = await safeRuntimeStatus(runtimeClient);
  const nodeId = cfg.node?.nodeId || "local-docker-node";
  const nodeIds = runtimeNodeIds(runtimeStatus);
  if (!nodeIds.includes(nodeId)) {
    const env = {
      HOMERAIL_HOME: getHomerailHome(),
      HOMERAIL_MANAGER_WS_URL: managerWsUrl({ ...cfg, manager: { ...cfg.manager, url: client.baseUrl } }),
      HOMERAIL_PROJECT_ID: cfg.node?.projectId || "p1",
      HOMERAIL_NODE_ID: nodeId,
      HOMERAIL_NODE_PROVIDER: cfg.node?.provider || "docker-cli",
      HOMERAIL_NODE_CAPABILITIES: (cfg.node?.capabilities || ["docker-cli"]).join(","),
      ...assetEnv,
    };
    const pid = startService("node", "homerail_node/dist/cli.js", env);
    console.log(`Started Node pid=${pid}`);
    await waitForNode(runtimeClient, nodeId);
  } else {
    console.log(`Node already connected: ${nodeId}`);
  }

  const finalStatus = await getRuntimeStatus(globalOpts);
  printRuntimeStatus(finalStatus);
  return finalStatus.managerHealthy && runtimeNodeIds(finalStatus.runtime).length > 0 ? 0 : 1;
}

async function getRuntimeStatus(globalOpts: GlobalOpts): Promise<RuntimeStatus> {
  const cfg = loadLocalConfig();
  const managerState = readManagerState();
  const managerUrl = globalOpts.baseUrl || managerState?.accessUrl || configuredManagerLocalUrl(cfg);
  const managerAccessUrl = globalOpts.baseUrl || managerState?.publicUrl || configuredManagerAccessUrl(cfg);
  const client = new HomeRailClient({ baseUrl: managerUrl, timeoutMs: globalOpts.requestTimeout });
  const managerPid = readPid("manager") ?? managerState?.pid;
  const nodePid = readPid("node");
  const uiStatus = getUiStatus();
  let managerHealthy = false;
  let runtime: unknown;
  try {
    await client.get("/health");
    managerHealthy = true;
    runtime = await safeRuntimeStatus(client);
  } catch {
    managerHealthy = false;
  }
  const status: RuntimeStatus = {
    managerPid,
    nodePid,
    uiPid: uiStatus.uiPid,
    uiHttpsPid: uiStatus.uiHttpsPid,
    uiHttpPid: uiStatus.uiHttpPid,
    managerPidRunning: managerPid !== undefined && pidIsRunning(managerPid),
    nodePidRunning: nodePid !== undefined && pidIsRunning(nodePid),
    uiPidRunning: uiStatus.uiPidRunning,
    uiHttpsPidRunning: uiStatus.uiHttpsPidRunning,
    uiHttpPidRunning: uiStatus.uiHttpPidRunning,
    managerHealthy,
    managerBindHost: managerState?.host ?? configuredManagerHost(cfg),
    managerUrl: client.baseUrl,
    managerAccessUrl,
    managerPublicUrl: managerAccessUrl,
    uiBindHost: uiStatus.uiHost,
    uiUrl: uiStatus.uiUrl,
    uiPublicUrl: uiStatus.uiPublicUrl,
    uiHttpsUrl: uiStatus.uiHttpsUrl,
    uiHttpsPublicUrl: uiStatus.uiHttpsPublicUrl,
    uiHttpUrl: uiStatus.uiHttpUrl,
    uiHttpPublicUrl: uiStatus.uiHttpPublicUrl,
    uiTextModeEnabled: uiStatus.uiTextModeEnabled,
    runtime,
    serviceControl: getRuntimeServiceControlStatus(),
    services: [],
  };
  status.services = buildLocalRuntimeServiceStatuses(status);
  return status;
}

function stopRuntime(): number {
  let stopped = 0;
  for (const name of ["ui-https", "ui", "worker", "node", "manager"] as const) {
    if (stopService(name)) stopped++;
  }
  return stopped;
}

function printRuntimeStatus(status: RuntimeStatus): void {
  console.log(`Manager API: ${status.managerHealthy ? "PASS" : "FAIL"} ${status.managerUrl}`);
  console.log(`Manager bind: ${status.managerBindHost}`);
  console.log(`Manager access URL: ${status.managerAccessUrl}`);
  console.log(`Manager PID: ${status.managerPid ?? "-"} ${status.managerPidRunning ? "running" : "not running"}`);
  console.log(`Node PID:    ${status.nodePid ?? "-"} ${status.nodePidRunning ? "running" : "not running"}`);
  console.log(`Agent UI:    ${status.uiPidRunning ? "PASS" : "FAIL"} ${status.uiUrl}`);
  console.log(`UI bind:     ${status.uiBindHost}`);
  console.log(`UI HTTPS PID:${status.uiHttpsPid ?? "-"} ${status.uiHttpsPidRunning ? "running" : "not running"}`);
  console.log(`UI HTTP:     ${status.uiHttpPidRunning ? "PASS" : "FAIL"} ${status.uiHttpUrl}`);
  console.log(`UI HTTP PID: ${status.uiHttpPid ?? "-"} ${status.uiHttpPidRunning ? "running" : "not running"}`);
  console.log(`UI text mode:${status.uiTextModeEnabled ? "enabled" : "disabled"}`);
  console.log(`Service:     ${status.serviceControl.supported ? (status.serviceControl.installed ? "installed" : "not installed") : "unsupported"} ${status.serviceControl.config_path}`);
  if (status.runtime && typeof status.runtime === "object") {
    const data = runtimeData(status.runtime);
    console.log(`Nodes:       ${String(data.connected_nodes ?? 0)} ${JSON.stringify(data.node_ids ?? [])}`);
    console.log(`Workers:     ${String(data.connected_workers ?? 0)} ${JSON.stringify(data.worker_ids ?? [])}`);
    console.log(`Active runs: ${String(data.active_runs ?? 0)}`);
  }
}

function printUiStatus(status: UiStatus): void {
  console.log(`Agent UI: ${status.uiPidRunning ? "PASS" : "FAIL"} ${status.uiUrl}`);
  console.log(`UI bind:  ${status.uiHost}`);
  console.log(`HTTPS PID:${status.uiHttpsPid ?? "-"} ${status.uiHttpsPidRunning ? "running" : "not running"}`);
  console.log(`HTTP UI:  ${status.uiHttpPidRunning ? "PASS" : "FAIL"} ${status.uiHttpUrl}`);
  console.log(`HTTP PID: ${status.uiHttpPid ?? "-"} ${status.uiHttpPidRunning ? "running" : "not running"}`);
  console.log(`Text mode:${status.uiTextModeEnabled ? "enabled" : "disabled"}`);
  console.log(`HTTPS log:${logPath("ui-https")}`);
  console.log(`HTTP log: ${logPath("ui")}`);
}

function startService(name: RuntimeServiceName, relativeScript: string, env: Record<string, string>): number {
  const repoRoot = resolveRepoRoot();
  const script = path.join(repoRoot, relativeScript);
  const out = fs.openSync(logPath(name), "a");
  const err = fs.openSync(logPath(name), "a");
  const child = spawn(process.execPath, [script], {
    cwd: repoRoot,
    env: {
      ...loadLocalSecrets(),
      ...process.env,
      ...env,
    },
    detached: true,
    shell: false,
    stdio: ["ignore", out, err],
    windowsHide: true,
  });
  child.unref();
  if (!child.pid) throw new Error(`failed to start ${name}`);
  fs.writeFileSync(pidPath(name), `${child.pid}\n`);
  return child.pid;
}

async function startUiServer(globalOpts: GlobalOpts, opts: UiStartOpts = {}): Promise<UiStatus> {
  ensureHomerailHome();
  if (opts.unsafeNoAdminToken && !opts.public) {
    throw new Error("--unsafe-no-admin-token requires --public");
  }
  const cfg = loadLocalConfig();

  const host = opts.public && !opts.host ? detectedMachineHost() : configuredUiHost(cfg, opts.host);
  const httpsPort = configuredUiPort(cfg, opts.port);
  const httpPort = configuredUiHttpPort(cfg);
  if (httpsPort === httpPort) {
    throw new Error(`Agent UI HTTPS and HTTP ports must differ; both resolved to ${httpsPort}`);
  }

  ensureAgentUiRuntime();
  const managerUrl = opts.managerUrl !== undefined || globalOpts.baseUrl
    ? configuredManagerAccessUrl(cfg, opts.managerUrl || globalOpts.baseUrl)
    : undefined;
  const httpsPublicUrl = configuredUiPublicUrl(cfg, host, httpsPort, opts.publicUrl);
  const httpPublicUrl = configuredUiHttpPublicUrl(cfg, host, httpPort);
  const managerPort = String(configuredManagerPort(managerUrl ? { ...cfg, manager: { ...cfg.manager, url: managerUrl } } : cfg));
  const textModeEnabled = resolveTextModeEnabled(opts.enableTextMode);
  const serveStatic = shouldServeStaticAgentUi(path.join(resolveRepoRoot(), "agent-ui"));
  restartUiIfTextModeChanged("ui-https", textModeEnabled);
  restartUiIfTextModeChanged("ui", textModeEnabled);
  restartUiIfServingModeChanged("ui-https", serveStatic);
  restartUiIfServingModeChanged("ui", serveStatic);
  const existing = getUiStatus(host, httpsPort, httpsPublicUrl, httpPort, httpPublicUrl);
  let httpsError: string | undefined;
  let httpError: string | undefined;

  if (!existing.uiHttpsPidRunning) {
    try {
      const certificate = ensureUiCertificate(host);
      startUiProcess({
        name: "ui-https",
        protocol: "https",
        host,
        port: httpsPort,
        managerUrl,
        managerPort,
        publicUrl: httpsPublicUrl,
        textModeEnabled,
        unsafeNoAdminToken: opts.unsafeNoAdminToken,
        certificate,
      });
      await waitForHttp(uiProbeUrl(host, httpsPort, "https"));
    } catch (err) {
      stopService("ui-https");
      httpsError = err instanceof Error ? err.message : String(err);
      console.warn(`Agent UI HTTPS unavailable: ${httpsError}`);
    }
  }

  if (!existing.uiHttpPidRunning) {
    try {
      startUiProcess({
        name: "ui",
        protocol: "http",
        host,
        port: httpPort,
        managerUrl,
        managerPort,
        publicUrl: httpPublicUrl,
        textModeEnabled,
        unsafeNoAdminToken: opts.unsafeNoAdminToken,
      });
      await waitForHttp(uiProbeUrl(host, httpPort, "http"));
    } catch (err) {
      stopService("ui");
      httpError = err instanceof Error ? err.message : String(err);
      console.warn(`Agent UI HTTP unavailable: ${httpError}`);
    }
  }

  const status = getUiStatus(host, httpsPort, httpsPublicUrl, httpPort, httpPublicUrl);
  if (!status.uiPidRunning) {
    const detail = [httpsError && `HTTPS failed: ${httpsError}`, httpError && `HTTP failed: ${httpError}`]
      .filter(Boolean)
      .join("; ");
    throw new Error(`Agent UI did not become healthy: ${detail || "no UI process running"}`);
  }
  return status;
}

interface StartUiProcessOpts {
  name: "ui" | "ui-https";
  protocol: "http" | "https";
  host: string;
  port: number;
  managerUrl?: string;
  managerPort: string;
  publicUrl: string;
  textModeEnabled: boolean;
  unsafeNoAdminToken?: boolean;
  certificate?: UiCertificate;
}

interface UiCertificate {
  keyPath: string;
  certPath: string;
}

export function agentUiDevServerCommand(agentUiDir: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [path.join(agentUiDir, "node_modules", "vite", "bin", "vite.js")],
  };
}

function startUiProcess(opts: StartUiProcessOpts): number {
  const agentUiDir = path.join(resolveRepoRoot(), "agent-ui");
  const out = fs.openSync(logPath(opts.name), "a");
  const err = fs.openSync(logPath(opts.name), "a");

  // Production / packaged mode: serve the prebuilt agent-ui/dist with a tiny
  // zero-dependency static server (see static-ui-server.ts), avoiding the need
  // to ship agent-ui's full node_modules (vite toolchain). On Windows this is
  // also the most reliable source-deploy path when dist exists.
  const serveStatic = shouldServeStaticAgentUi(agentUiDir);
  const managerHttp = opts.managerUrl || `http://localhost:${opts.managerPort}`;
  const adminProxyEnv = resolveUiAdminProxyProcessEnv({
    uiBindHost: opts.host,
    uiPublicUrl: opts.publicUrl,
    managerUrl: managerHttp,
    adminToken: resolveConfiguredManagerAdminToken(),
    unsafeNoAdminToken: opts.unsafeNoAdminToken,
  });

  let child: import("child_process").ChildProcess;
  if (serveStatic) {
    const serverScript = path.join(resolveRepoRoot(), "homerail_cli", "dist", "static-ui-server.js");
    const managerWs = managerHttp.replace(/^http/, "ws");
    child = spawn(process.execPath, [serverScript], {
      cwd: agentUiDir,
      env: {
        ...loadLocalSecrets(),
        ...process.env,
        HOMERAIL_HOME: getHomerailHome(),
        HOMERAIL_STATIC_UI_DIR: path.join(agentUiDir, "dist"),
        HOMERAIL_UI_HOST: opts.host,
        HOMERAIL_UI_PORT: String(opts.port),
        HOMERAIL_MANAGER_HTTP: managerHttp,
        HOMERAIL_MANAGER_WS: managerWs,
        ...adminProxyEnv,
        ...(opts.protocol === "https"
          ? {
            HOMERAIL_UI_HTTPS: "1",
            HOMERAIL_UI_HTTPS_KEY: opts.certificate?.keyPath || "",
            HOMERAIL_UI_HTTPS_CERT: opts.certificate?.certPath || "",
          }
          : {}),
      },
      detached: true,
      shell: false,
      stdio: ["ignore", out, err],
      windowsHide: true,
    });
  } else {
    const devServer = agentUiDevServerCommand(agentUiDir);
    const uiApiOrigin = new URL(opts.publicUrl).origin;
    child = spawn(devServer.command, [
      ...devServer.args,
      "--host",
      opts.host,
      "--port",
      String(opts.port),
      "--strictPort",
    ], {
      cwd: agentUiDir,
      env: {
        ...loadLocalSecrets(),
        ...process.env,
        HOMERAIL_HOME: getHomerailHome(),
        HOMERAIL_UI_HOST: opts.host,
        HOMERAIL_UI_PORT: String(opts.port),
        VITE_HOMERAIL_UI_PORT: String(opts.port),
        VITE_HOMERAIL_MANAGER_PORT: opts.managerPort,
        VITE_HOMERAIL_ENABLE_TEXT_MODE: opts.textModeEnabled ? "1" : "0",
        HOMERAIL_MANAGER_HTTP: managerHttp,
        VITE_API_BASE_URL: uiApiOrigin,
        ...adminProxyEnv,
        ...(opts.protocol === "https"
          ? {
            HOMERAIL_UI_HTTPS: "1",
            HOMERAIL_UI_HTTPS_KEY: opts.certificate?.keyPath || "",
            HOMERAIL_UI_HTTPS_CERT: opts.certificate?.certPath || "",
          }
          : {}),
      },
      detached: true,
      shell: false,
      stdio: ["ignore", out, err],
      windowsHide: true,
    });
  }
  child.unref();
  if (!child.pid) throw new Error(`failed to start Agent UI ${opts.protocol}`);
  fs.writeFileSync(pidPath(opts.name), `${child.pid}\n`);
  writeUiState(opts.name, {
    pid: child.pid,
    host: opts.host,
    port: opts.port,
    protocol: opts.protocol,
    mode: serveStatic ? "static" : "dev",
    managerUrl: opts.managerUrl,
    publicUrl: opts.publicUrl,
    textModeEnabled: opts.textModeEnabled,
    startedAt: Date.now(),
  });
  return child.pid;
}

function hasManagerPublicUrl(config: ReturnType<typeof loadLocalConfig>, override?: string): boolean {
  return Boolean(
    override?.trim() ||
    process.env.HOMERAIL_MANAGER_PUBLIC_URL?.trim() ||
    config.manager?.publicUrl?.trim(),
  );
}

function getUiStatus(
  host?: string,
  httpsPort?: number,
  httpsPublicUrl?: string,
  httpPort?: number,
  httpPublicUrl?: string,
): UiStatus {
  const httpsState = readUiState("ui-https");
  const httpState = readUiState("ui");
  const uiHost = host ?? httpsState?.host ?? httpState?.host ?? configuredUiHost();
  const uiHttpsPort = httpsPort ?? httpsState?.port ?? configuredUiPort();
  const uiHttpPort = httpPort ?? httpState?.port ?? configuredUiHttpPort();
  const uiHttpsPublicUrl = httpsPublicUrl ?? httpsState?.publicUrl ?? configuredUiPublicUrl(loadLocalConfig(), uiHost, uiHttpsPort);
  const uiHttpPublicUrl = httpPublicUrl ?? httpState?.publicUrl ?? configuredUiHttpPublicUrl(loadLocalConfig(), uiHost, uiHttpPort);
  const uiHttpsPid = readPid("ui-https") ?? httpsState?.pid;
  const uiHttpPid = readPid("ui") ?? httpState?.pid;
  const uiHttpsPidRunning = uiHttpsPid !== undefined && pidIsRunning(uiHttpsPid);
  const uiHttpPidRunning = uiHttpPid !== undefined && pidIsRunning(uiHttpPid);
  const uiTextModeEnabled = Boolean(httpsState?.textModeEnabled ?? httpState?.textModeEnabled ?? false);
  const shouldUseHttpUi = !uiHttpsPidRunning && uiHttpPidRunning;
  const preferredUiPublicUrl = shouldUseHttpUi ? uiHttpPublicUrl : uiHttpsPublicUrl;
  const preferredUiPid = shouldUseHttpUi ? uiHttpPid : uiHttpsPid;
  return {
    uiPid: preferredUiPid,
    uiHttpsPid,
    uiHttpPid,
    uiPidRunning: uiHttpsPidRunning || uiHttpPidRunning,
    uiHttpsPidRunning,
    uiHttpPidRunning,
    uiHost,
    uiPort: uiHttpsPort,
    uiUrl: preferredUiPublicUrl,
    uiPublicUrl: preferredUiPublicUrl,
    uiHttpsPort,
    uiHttpsUrl: uiHttpsPublicUrl,
    uiHttpsPublicUrl,
    uiHttpPort,
    uiHttpUrl: uiHttpPublicUrl,
    uiHttpPublicUrl,
    uiTextModeEnabled,
  };
}

function resolveTextModeEnabled(override?: boolean): boolean {
  if (override === true) return true;
  return envFlagEnabled(process.env.HOMERAIL_UI_ENABLE_TEXT_MODE) || envFlagEnabled(process.env.VITE_HOMERAIL_ENABLE_TEXT_MODE);
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function restartUiIfTextModeChanged(name: "ui" | "ui-https", textModeEnabled: boolean): void {
  const state = readUiState(name);
  const pid = readPid(name) ?? state?.pid;
  if (pid === undefined || !pidIsRunning(pid)) return;
  if (Boolean(state?.textModeEnabled) !== textModeEnabled) {
    stopService(name);
  }
}

function restartUiIfServingModeChanged(name: "ui" | "ui-https", serveStatic: boolean): void {
  const state = readUiState(name);
  const pid = readPid(name) ?? state?.pid;
  if (pid === undefined || !pidIsRunning(pid)) return;
  const desiredMode = serveStatic ? "static" : "dev";
  if (state?.mode !== desiredMode && (state?.mode !== undefined || serveStatic)) {
    stopService(name);
  }
}

function ensureAgentUiRuntime(): void {
  const agentUiDir = path.join(resolveRepoRoot(), "agent-ui");
  const packageJson = path.join(agentUiDir, "package.json");
  if (!fs.existsSync(packageJson)) {
    throw new Error("missing agent-ui/package.json");
  }
  // Static-serving mode only needs the prebuilt dist, not node_modules.
  const serveStatic = shouldServeStaticAgentUi(agentUiDir);
  if (serveStatic) {
    if (!fs.existsSync(path.join(agentUiDir, "dist", "index.html"))) {
      throw new Error("missing agent-ui/dist (run `npm run build` under agent-ui)");
    }
    return;
  }
  const nodeModules = path.join(agentUiDir, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    throw new Error("missing agent-ui/node_modules; run npm run install:all first");
  }
}

export function shouldServeStaticAgentUi(
  agentUiDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const mode = process.env.HOMERAIL_UI_SERVE_STATIC?.trim();
  const hasDist = fs.existsSync(path.join(agentUiDir, "dist", "index.html"));
  if (mode === "1") return true;
  if (mode === "0") return false;
  if (platform === "win32" && hasDist) return true;
  return hasDist && !fs.existsSync(path.join(agentUiDir, "node_modules"));
}

function stopService(name: RuntimeServiceName): boolean {
  const pid = readPid(name);
  let stopped = false;
  if (pid && pidIsRunning(pid)) {
    stopped = killProcessTree(pid, "SIGTERM");
  }
  try {
    fs.unlinkSync(pidPath(name));
  } catch {
    // Missing PID file is fine.
  }
  if (name === "ui" || name === "ui-https") {
    try {
      fs.unlinkSync(uiStatePath(name));
    } catch {
      // Missing state file is fine.
    }
  }
  if (name === "manager") {
    try {
      fs.unlinkSync(managerStatePath());
    } catch {
      // Missing state file is fine.
    }
  }
  return stopped;
}

function killProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return result.status === 0;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function ensureUiCertificate(host: string): UiCertificate {
  const certHost = certificateHost(host);
  const suffix = certHost.replace(/[^a-zA-Z0-9.-]+/g, "_");
  const certDir = path.join(getHomerailHome(), "certs");
  fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(certDir, `agent-ui-${suffix}.key.pem`);
  const certPath = path.join(certDir, `agent-ui-${suffix}.cert.pem`);
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { keyPath, certPath };
  }

  const configPath = path.join(certDir, `agent-ui-${suffix}.openssl.cnf`);
  fs.writeFileSync(configPath, opensslConfig(certHost), { mode: 0o600 });
  const result = spawnSync("openssl", [
    "req",
    "-x509",
    "-nodes",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "825",
    "-sha256",
    "-subj",
    "/CN=HomeRail Agent UI",
    "-config",
    configPath,
    "-extensions",
    "v3_req",
  ], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error("openssl is required to generate the local Agent UI HTTPS certificate");
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "openssl failed").trim();
    throw new Error(`failed to generate Agent UI HTTPS certificate: ${detail}`);
  }
  try {
    fs.chmodSync(keyPath, 0o600);
    fs.chmodSync(certPath, 0o644);
  } catch {
    // Best effort on platforms that do not support POSIX modes.
  }
  return { keyPath, certPath };
}

function certificateHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return detectedMachineHost();
  return host || "localhost";
}

function opensslConfig(host: string): string {
  const dnsNames = new Set(["localhost"]);
  const ipNames = new Set(["127.0.0.1", "::1"]);
  if (host && !isWildcardHost(host)) {
    if (net.isIP(host)) {
      ipNames.add(host);
    } else {
      dnsNames.add(host);
    }
  }
  const altNames: string[] = [];
  let dnsIndex = 1;
  for (const name of dnsNames) {
    altNames.push(`DNS.${dnsIndex++} = ${name}`);
  }
  let ipIndex = 1;
  for (const ip of ipNames) {
    altNames.push(`IP.${ipIndex++} = ${ip}`);
  }
  return [
    "[req]",
    "distinguished_name = req_distinguished_name",
    "x509_extensions = v3_req",
    "prompt = no",
    "",
    "[req_distinguished_name]",
    "CN = HomeRail Agent UI",
    "",
    "[v3_req]",
    "basicConstraints = CA:FALSE",
    "keyUsage = digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    "subjectAltName = @alt_names",
    "",
    "[alt_names]",
    ...altNames,
    "",
  ].join("\n");
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function managerStatePath(): string {
  const dir = path.join(getHomerailHome(), "pids");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "manager.json");
}

function dagResourceStatusPath(): string {
  const dir = path.join(getHomerailHome(), "runtime");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "dag-resources.json");
}

function writeWorkerImageRuntimeStatus(
  status: WorkerImageRuntimeStatus,
  patch: { reason?: WorkerImageBuildReason; message: string; error?: string },
): void {
  const now = Date.now();
  const filePath = dagResourceStatusPath();
  let startedAt = now;
  try {
    const previous = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { worker_image?: { started_at?: unknown } };
    if (typeof previous.worker_image?.started_at === "number" && (status === "checking" || status === "building")) {
      startedAt = previous.worker_image.started_at;
    }
  } catch {
    // Missing or malformed resource status is replaced below.
  }
  const body = {
    worker_image: {
      status,
      image: WORKER_IMAGE_TAG,
      reason: patch.reason,
      message: patch.message,
      started_at: status === "checking" || status === "building" ? startedAt : undefined,
      updated_at: now,
      error: patch.error,
    },
  };
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(body, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

function writeManagerState(state: ManagerServiceState): void {
  const filePath = managerStatePath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

function readManagerState(): ManagerServiceState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(managerStatePath(), "utf-8")) as Partial<ManagerServiceState>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.host === "string" &&
      typeof parsed.port === "number" &&
      Number.isInteger(parsed.port) &&
      parsed.port > 0 &&
      typeof parsed.accessUrl === "string"
    ) {
      return {
        pid: parsed.pid,
        host: parsed.host,
        port: parsed.port,
        accessUrl: parsed.accessUrl,
        publicUrl: typeof parsed.publicUrl === "string" ? parsed.publicUrl : undefined,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      };
    }
  } catch {
    // Missing or malformed state is treated as absent.
  }
  return undefined;
}

function uiStatePath(name: "ui" | "ui-https" = "ui"): string {
  const dir = path.join(getHomerailHome(), "pids");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.json`);
}

function writeUiState(name: "ui" | "ui-https", state: UiServiceState): void {
  const filePath = uiStatePath(name);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

function readUiState(name: "ui" | "ui-https" = "ui"): UiServiceState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(uiStatePath(name), "utf-8")) as Partial<UiServiceState>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.host === "string" &&
      typeof parsed.port === "number" &&
      Number.isInteger(parsed.port) &&
      parsed.port > 0
    ) {
      return {
        pid: parsed.pid,
        host: parsed.host,
        port: parsed.port,
        protocol: parsed.protocol === "https" ? "https" : "http",
        mode: parsed.mode === "static" ? "static" : parsed.mode === "dev" ? "dev" : undefined,
        managerUrl: typeof parsed.managerUrl === "string" ? parsed.managerUrl : DEFAULT_MANAGER_URL,
        publicUrl: typeof parsed.publicUrl === "string" ? parsed.publicUrl : undefined,
        textModeEnabled: parsed.textModeEnabled === true,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      };
    }
  } catch {
    // Missing or malformed state is treated as absent.
  }
  return undefined;
}

function addPathToHash(hash: ReturnType<typeof createHash>, repoRoot: string, relativePath: string): void {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return;
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolutePath).sort()) {
      addPathToHash(hash, repoRoot, path.join(relativePath, name));
    }
    return;
  }
  if (!stat.isFile()) return;
  hash.update(relativePath.split(path.sep).join("/"));
  hash.update("\0");
  hash.update(fs.readFileSync(absolutePath));
  hash.update("\0");
}

export function workerImageSourceFingerprint(repoRoot = resolveRepoRoot()): string {
  const hash = createHash("sha256");
  for (const relativePath of WORKER_IMAGE_SOURCE_INPUTS) {
    addPathToHash(hash, repoRoot, relativePath);
  }
  return hash.digest("hex").slice(0, 16);
}

export function workerImageBuildReason(
  imageExists: boolean,
  imageFingerprint: string | undefined,
  sourceFingerprint: string,
  forceRebuild = false,
): WorkerImageBuildReason | null {
  if (forceRebuild) return "forced";
  if (!imageExists) return "missing";
  const cleanImageFingerprint = (imageFingerprint ?? "").trim();
  if (!cleanImageFingerprint || cleanImageFingerprint === "<no value>") return "stale";
  if (cleanImageFingerprint !== sourceFingerprint) return "stale";
  return null;
}

export function workerImageDockerBuildSpawnOptions(): SpawnOptions {
  return {
    cwd: resolveRepoRoot(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...loadLocalSecrets(), ...process.env, HOMERAIL_HOME: getHomerailHome() },
    shell: false,
    windowsHide: true,
  };
}

export function runWorkerImageDockerBuild(
  dockerBin: string,
  args: string[],
  spawnImpl: typeof spawn = spawn,
  writeStdout: (chunk: Buffer | string) => void = (chunk) => { process.stdout.write(chunk); },
  writeStderr: (chunk: Buffer | string) => void = (chunk) => { process.stderr.write(chunk); },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(dockerBin, args, workerImageDockerBuildSpawnOptions());
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    child.stdout?.on("data", writeStdout);
    child.stderr?.on("data", writeStderr);
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = code === null
        ? signal ? `signal ${signal}` : "unknown exit status"
        : `exit code ${code}`;
      finish(new Error(`failed to build ${WORKER_IMAGE_TAG} (${detail})`));
    });
  });
}

async function ensureWorkerImage(forceRebuild = false): Promise<void> {
  const dockerBin = resolveDockerBinary();
  writeWorkerImageRuntimeStatus("checking", {
    message: "Checking DAG worker image before DAG runs are enabled.",
  });
  const dockerVersion = spawnSync(dockerBin, ["--version"], {
    encoding: "utf-8",
    windowsHide: true,
  });
  if (dockerVersion.error && (dockerVersion.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error(dockerMissingMessage(dockerBin));
  }
  if (dockerVersion.status !== 0) {
    const detail = (dockerVersion.stderr || dockerVersion.stdout || "docker --version failed").trim();
    throw new Error(`Docker is required to build homerail-worker:latest: ${detail}`);
  }

  const sourceFingerprint = workerImageSourceFingerprint();
  const inspect = spawnSync(dockerBin, [
    "image",
    "inspect",
    "--format",
    `{{ index .Config.Labels "${WORKER_IMAGE_SOURCE_LABEL}" }}`,
    WORKER_IMAGE_TAG,
  ], {
    encoding: "utf-8",
    windowsHide: true,
  });
  const reason = workerImageBuildReason(inspect.status === 0, inspect.stdout, sourceFingerprint, forceRebuild);
  if (!reason) {
    writeWorkerImageRuntimeStatus("ready", {
      message: `${WORKER_IMAGE_TAG} is ready for DAG runs.`,
    });
    return;
  }
  const label = reason === "forced" ? "Rebuilding" : reason === "missing" ? "Building missing" : "Rebuilding stale";
  console.log(`${label} worker image: ${WORKER_IMAGE_TAG}`);
  writeWorkerImageRuntimeStatus("building", {
    reason,
    message: `${label} DAG worker image. DAG runs are temporarily unavailable until this finishes.`,
  });
  await runWorkerImageDockerBuild(dockerBin, [
    "build",
    "-f",
    "homerail_worker/Dockerfile",
    "--label",
    `${WORKER_IMAGE_SOURCE_LABEL}=${sourceFingerprint}`,
    "-t",
    WORKER_IMAGE_TAG,
    ".",
  ]);
  writeWorkerImageRuntimeStatus("ready", {
    reason,
    message: `${WORKER_IMAGE_TAG} is ready for DAG runs.`,
  });
}

function ensureBuiltArtifact(relativePath: string): void {
  const filePath = path.join(resolveRepoRoot(), relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing ${relativePath}; run npm run build first`);
  }
}

async function waitForManager(client: HomeRailClient): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    try {
      await client.get("/health");
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Manager did not become healthy at ${client.baseUrl}`);
}

async function waitForNode(client: HomeRailClient, nodeId: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const runtime = await safeRuntimeStatus(client);
    if (runtimeNodeIds(runtime).includes(nodeId)) return;
    await sleep(500);
  }
  throw new Error(`Node did not connect: ${nodeId}`);
}

async function waitForHttp(url: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
          hostname: parsed.hostname,
          port: parsed.port,
          path: `${parsed.pathname}${parsed.search}`,
        };
        const req = parsed.protocol === "https:"
          ? https.get({ ...options, rejectUnauthorized: false }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          })
          : http.get(options, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.setTimeout(2_000, () => req.destroy(new Error("timeout")));
        req.on("error", reject);
      });
      if (status >= 200 && status < 500) return;
      lastError = `status=${status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(250);
  }
  throw new Error(lastError || "timeout");
}

async function safeRuntimeStatus(client: HomeRailClient): Promise<unknown> {
  const resp = await client.get<BaseResponse | Record<string, unknown>>("/api/runtime/status");
  if ("success" in resp) return (resp as BaseResponse).data;
  return resp;
}

function runtimeData(runtime: unknown): Record<string, unknown> {
  if (runtime && typeof runtime === "object") return runtime as Record<string, unknown>;
  return {};
}

function runtimeNodeIds(runtime: unknown): string[] {
  const data = runtimeData(runtime);
  return Array.isArray(data.node_ids)
    ? data.node_ids.filter((id): id is string => typeof id === "string")
    : [];
}

function uiProbeUrl(host: string, port: number, protocol: "http" | "https" = "http"): string {
  const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return probeHost.includes(":")
    ? `${protocol}://[${probeHost}]:${port}`
    : `${protocol}://${probeHost}:${port}`;
}

function pidPath(name: RuntimeServiceName): string {
  const dir = path.join(getHomerailHome(), "pids");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.pid`);
}

function logPath(name: RuntimeServiceName): string {
  const dir = path.join(getHomerailHome(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.log`);
}

function readPid(name: RuntimeServiceName): number | undefined {
  try {
    const raw = fs.readFileSync(pidPath(name), "utf-8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveRepoRoot(): string {
  // Allow packaged deployments (e.g. the desktop packaged shell app) to point the
  // CLI at a relocated runtime tree instead of relying on the source layout.
  const override = process.env.HOMERAIL_REPO_ROOT?.trim();
  if (override) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
