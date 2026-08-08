import type { Command } from "commander";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
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
} from "../local-config.js";
import { applyStoredModelConfig } from "./config.js";
import {
  buildLocalRuntimeServiceStatuses,
  getRuntimeServiceControlStatus,
  installRuntimeService,
  uninstallRuntimeService,
  type LocalRuntimeServiceStatus,
  type RuntimeServiceControlStatus,
} from "../local-service-lifecycle.js";
import { normalizeExactHttpOrigin } from "../ui-admin-proxy.js";

interface GlobalOpts {
  json?: boolean;
  baseUrl?: string;
  requestTimeout?: number;
}

interface StartOpts {
  /** Legacy compatibility guard for an explicit asynchronous rebuild. */
  buildWorkerImage?: boolean;
  rebuildWorkerImage?: boolean;
  ui?: boolean;
  host?: string;
  public?: boolean;
  publicUrl?: string;
  uiHost?: string;
  uiPort?: string;
  uiPublicUrl?: string;
  enableTextMode?: boolean;
}

interface UiStartOpts {
  host?: string;
  port?: string;
  public?: boolean;
  publicUrl?: string;
  managerUrl?: string;
  enableTextMode?: boolean;
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
  managerOnly?: boolean;
}

interface StartRuntimeContext {
  managerOnly?: boolean;
  previousManagerState?: ManagerServiceState;
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
  /**
   * Absolute directory served by a packaged/static UI child. AppImage
   * extraction paths change between desktop launches, so a live child whose
   * recorded root differs from the current runtime must be replaced.
   */
  staticUiDir?: string;
  managerUrl?: string;
  publicUrl?: string;
  /**
   * Canonical explicit external Origin the child was launched with
   * (`HOMERAIL_UI_PUBLIC_URL`), or `undefined` when the child runs with
   * strict request-derived authorization. Drives the restart decision when
   * the requested effective Origin changes.
   */
  explicitPublicUrl?: string;
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

const MANAGER_ADMIN_ORIGINS_ENV = "HOMERAIL_MANAGER_ADMIN_ORIGINS";

/**
 * Merge operator-provided exact Origins with the two UI proxy origins.
 * Both inputs are validated with the same canonical exact HTTP(S) Origin rule
 * the static UI mutation proxy applies, so the Manager allowlist and the UI
 * proxy never diverge on what counts as an exact Origin.
 */
export function mergeManagerAdminOrigins(
  configured: string | undefined,
  uiUrls: readonly string[],
): string {
  const origins = new Set<string>();
  for (const value of (configured ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const normalized = normalizeExactHttpOrigin(value);
    if (!normalized) {
      throw new Error(`${MANAGER_ADMIN_ORIGINS_ENV} must contain exact http(s) Origins without paths`);
    }
    origins.add(normalized);
  }
  for (const value of uiUrls) {
    const normalized = normalizeExactHttpOrigin(value);
    if (!normalized) {
      throw new Error(
        `Agent UI public URL must be an exact http(s) Origin without wildcard, path, query, fragment, or credentials: ${value}`,
      );
    }
    origins.add(normalized);
  }
  return [...origins].sort().join(",");
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

export function registerRuntimeCommands(program: Command): void {
  program
    .command("start")
    .description("Start the local Manager and Node runtime together")
    .option("--no-build-worker-image", "Do not queue a Worker rebuild (legacy compatibility)")
    .option("--rebuild-worker-image", "Queue an asynchronous Worker image rebuild after Manager starts")
    .option("--host <host>", "Manager bind host")
    .option("--public", "Bind Manager publicly and bind Agent UI to the machine access IP")
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
    .option("--manager-only", "Restart only Manager; preserve Node, Worker, and Agent UI processes")
    .option("--no-build-worker-image", "Do not queue a Worker rebuild (legacy compatibility)")
    .option("--rebuild-worker-image", "Queue an asynchronous Worker image rebuild after Manager starts")
    .option("--host <host>", "Manager bind host")
    .option("--public", "Bind Manager publicly and bind Agent UI to the machine access IP")
    .option("--public-url <url>", "Public Manager access URL advertised to Agent UI")
    .option("--ui", "Also start the Agent UI server")
    .option("--ui-host <host>", "Agent UI bind host")
    .option("--ui-port <port>", "Agent UI HTTPS port")
    .option("--ui-public-url <url>", "Public Agent UI access URL shown in status")
    .option("--enable-text-mode", "Enable the temporary Agent UI text mode")
    .action(async (opts: RuntimeRestartOpts) => {
      const globalOpts = program.opts() as GlobalOpts;
      try {
        const previousManagerState = opts.managerOnly ? readManagerState() : undefined;
        const stopped = opts.managerOnly ? await stopManagerForRestart() : stopRuntime();
        if (!globalOpts.json) console.log(`Stopped ${stopped} local service(s).`);
        process.exitCode = await startRuntime(globalOpts, opts, {
          managerOnly: opts.managerOnly,
          previousManagerState,
        });
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

async function startRuntime(
  globalOpts: GlobalOpts,
  opts: StartOpts,
  context: StartRuntimeContext = {},
): Promise<number> {
  ensureHomerailHome();
  const managerOnly = context.managerOnly === true;
  const previousManagerState = managerOnly ? context.previousManagerState : undefined;
  const printMessage = (message: string): void => {
    if (!globalOpts.json) console.log(message);
  };
  const cfg = loadLocalConfig();
  const assetRoot = configuredAssetRoot(cfg);
  const assetEnv: Record<string, string> = assetRoot ? { HOMERAIL_ASSET_DIR: assetRoot } : {};
  const managerHost = opts.public
    ? "0.0.0.0"
    : opts.host
      ? configuredManagerHost(cfg, opts.host)
      : previousManagerState?.host ?? configuredManagerHost(cfg);
  const managerLocalUrl = configuredManagerLocalUrl(
    cfg,
    globalOpts.baseUrl || previousManagerState?.accessUrl,
  );
  const managerPublicUrl = configuredManagerAccessUrl(
    cfg,
    opts.publicUrl || globalOpts.baseUrl || previousManagerState?.publicUrl,
  );
  const hasExplicitManagerPublicUrl = hasManagerPublicUrl(cfg, opts.publicUrl || globalOpts.baseUrl)
    || Boolean(
      previousManagerState?.publicUrl
      && previousManagerState.publicUrl !== previousManagerState.accessUrl,
    );
  const managerPort = previousManagerState?.port ?? configuredManagerPort(cfg);
  const runningUi = managerOnly ? getUiStatus() : undefined;
  const uiBindHost = opts.public && !opts.uiHost ? detectedMachineHost() : configuredUiHost(cfg, opts.uiHost);
  const uiHttpsPort = configuredUiPort(cfg, opts.uiPort);
  const uiHttpPort = configuredUiHttpPort(cfg);
  const secrets = loadLocalSecrets();
  const preserveRunningUiOrigins = Boolean(
    managerOnly
    && runningUi?.uiPidRunning
    && !opts.public
    && !opts.uiHost
    && !opts.uiPort
    && !opts.uiPublicUrl,
  );
  const uiOrigins = preserveRunningUiOrigins && runningUi
    ? [runningUi.uiHttpsPublicUrl || runningUi.uiHttpsUrl, runningUi.uiHttpPublicUrl || runningUi.uiHttpUrl]
    : [
      configuredUiPublicUrl(cfg, uiBindHost, uiHttpsPort, opts.uiPublicUrl),
      configuredUiHttpPublicUrl(cfg, uiBindHost, uiHttpPort),
    ];
  const managerAdminOrigins = mergeManagerAdminOrigins(
    process.env[MANAGER_ADMIN_ORIGINS_ENV] ?? secrets[MANAGER_ADMIN_ORIGINS_ENV],
    uiOrigins,
  );
  const client = new HomeRailClient({ baseUrl: managerLocalUrl, timeoutMs: globalOpts.requestTimeout });

  ensureBuiltArtifact("homerail_manager/dist/index.js");
  if (!managerOnly) ensureBuiltArtifact("homerail_node/dist/cli.js");

  const before = managerOnly ? undefined : await getRuntimeStatus(globalOpts);
  if (managerOnly || !before?.managerHealthy) {
    const pid = startService("manager", "homerail_manager/dist/index.js", {
      HOMERAIL_HOME: getHomerailHome(),
      HOMERAIL_MANAGER_PORT: String(managerPort),
      HOMERAIL_MANAGER_HOST: managerHost,
      HOMERAIL_MANAGER_ADMIN_ORIGINS: managerAdminOrigins,
      HOMERAIL_MANAGER_ADMIN_TOKEN: "",
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
    printMessage(`Started Manager pid=${pid}`);
    await waitForManager(client);
    if (!pidIsRunning(pid)) {
      throw new Error(`Manager process exited during startup; see ${logPath("manager")}`);
    }
  } else {
    printMessage(`Manager already healthy at ${client.baseUrl}`);
  }

  const applyResult = await applyStoredModelConfig(client);
  if (applyResult.applied) {
    printMessage(`Model config ${applyResult.action}: ${applyResult.detail}`);
  } else {
    printMessage(`Model config not applied: ${applyResult.detail}`);
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
      printMessage("Next: run `hr model configure <provider-or-endpoint-alias>` to add provider credentials before running DAGs.");
    }
  }

  if (managerOnly) {
    const finalStatus = await getRuntimeStatus(globalOpts);
    printRuntimeResult(finalStatus, globalOpts.json);
    return finalStatus.managerHealthy && finalStatus.managerPidRunning ? 0 : 1;
  }

  if (opts.ui) {
    const uiStatus = await startUiServer(globalOpts, {
      host: opts.uiHost,
      port: opts.uiPort,
      public: opts.public,
      publicUrl: opts.uiPublicUrl,
      managerUrl: opts.public && !hasExplicitManagerPublicUrl ? undefined : managerPublicUrl,
      enableTextMode: opts.enableTextMode,
    });
    printMessage(`Agent UI: ${uiStatus.uiPidRunning ? "PASS" : "FAIL"} ${uiStatus.uiUrl}`);
  }

  // Worker images are owned by the running Manager and the Settings UI.
  // Manager startup must never wait for a Docker build. Keep the explicit
  // compatibility flag, but route it through the same asynchronous API used
  // by the UI.
  if (opts.rebuildWorkerImage && opts.buildWorkerImage !== false) {
    const accepted = await client.post<BaseResponse>("/api/dag/environment/build", {});
    if (!accepted.success) {
      throw new Error(accepted.error || accepted.message || "Worker image build was not accepted");
    }
    printMessage("Worker image rebuild queued; follow progress in Settings → Runtime environment.");
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
      ...assetEnv,
    };
    const pid = startService("node", "homerail_node/dist/cli.js", env);
    printMessage(`Started Node pid=${pid}`);
    await waitForNode(runtimeClient, nodeId);
  } else {
    printMessage(`Node already connected: ${nodeId}`);
  }

  const finalStatus = await getRuntimeStatus(globalOpts);
  printRuntimeResult(finalStatus, globalOpts.json);
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

async function stopManagerForRestart(): Promise<number> {
  const pid = servicePidForStop("manager");
  const stopped = stopService("manager", pid);
  if (stopped && pid !== undefined) await waitForPidExit(pid);
  return stopped ? 1 : 0;
}

function printRuntimeResult(status: RuntimeStatus, json = false): void {
  if (json) {
    console.log(JSON.stringify(status));
    return;
  }
  printRuntimeStatus(status);
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

/**
 * Explicit operator-configured public UI URL, mirroring the explicit sources
 * of configuredUiPublicUrl (--public-url flag, HOMERAIL_UI_PUBLIC_URL, then
 * ui.publicUrl). Returns undefined when the URL would be derived from the
 * bind host/port, so callers can keep no-config behavior strictly
 * request-derived.
 */
function explicitUiPublicUrl(
  config: ReturnType<typeof loadLocalConfig>,
  override?: string,
): string | undefined {
  if (override?.trim()) return override.trim().replace(/\/+$/, "");
  if (process.env.HOMERAIL_UI_PUBLIC_URL?.trim()) return process.env.HOMERAIL_UI_PUBLIC_URL.trim().replace(/\/+$/, "");
  if (config.ui?.publicUrl?.trim()) return config.ui.publicUrl.trim().replace(/\/+$/, "");
  return undefined;
}

/**
 * Resolve the operator-configured explicit public UI Origin from the CLI
 * flag, `HOMERAIL_UI_PUBLIC_URL`, or stored `ui.publicUrl` (in that
 * precedence order) into one canonical value shared by both static listeners.
 * The same exact http(s) Origin rule the static UI mutation proxy applies is
 * enforced here, so the runtime fails fast before any listener is launched
 * with an ambiguous trust boundary. Returns `undefined` when no explicit
 * Origin is configured so both listeners stay strictly request-derived.
 */
export function resolveExplicitUiPublicOrigin(
  config: ReturnType<typeof loadLocalConfig>,
  override?: string,
): string | undefined {
  const raw = explicitUiPublicUrl(config, override);
  if (raw === undefined) return undefined;
  const normalized = normalizeExactHttpOrigin(raw);
  if (normalized === undefined) {
    throw new Error(
      `Agent UI public URL must be an exact http(s) Origin without wildcard, path, query, fragment, or credentials: ${raw}`,
    );
  }
  return normalized;
}

async function startUiServer(globalOpts: GlobalOpts, opts: UiStartOpts = {}): Promise<UiStatus> {
  ensureHomerailHome();
  const cfg = loadLocalConfig();

  const host = opts.public && !opts.host ? detectedMachineHost() : configuredUiHost(cfg, opts.host);
  const httpsPort = configuredUiPort(cfg, opts.port);
  const httpPort = configuredUiHttpPort(cfg);
  if (httpsPort === httpPort) {
    throw new Error(`Agent UI HTTPS and HTTP ports must differ; both resolved to ${httpsPort}`);
  }

  ensureAgentUiRuntime();
  // One normalized explicit external Origin drives both static listener
  // environments, the persisted service state, and the restart decisions
  // below, no matter whether it came from the CLI flag, the environment, or
  // stored config.
  const explicitPublicUrl = resolveExplicitUiPublicOrigin(cfg, opts.publicUrl);
  const managerUrl = opts.managerUrl !== undefined || globalOpts.baseUrl
    ? configuredManagerAccessUrl(cfg, opts.managerUrl || globalOpts.baseUrl)
    : undefined;
  const httpsPublicUrl = explicitPublicUrl ?? configuredUiPublicUrl(cfg, host, httpsPort);
  const httpPublicUrl = explicitPublicUrl ?? configuredUiHttpPublicUrl(cfg, host, httpPort);
  const managerPort = String(configuredManagerPort(managerUrl ? { ...cfg, manager: { ...cfg.manager, url: managerUrl } } : cfg));
  const textModeEnabled = resolveTextModeEnabled(opts.enableTextMode);
  const agentUiDir = path.join(resolveRepoRoot(), "agent-ui");
  const serveStatic = shouldServeStaticAgentUi(agentUiDir);
  const staticUiDir = serveStatic ? path.join(agentUiDir, "dist") : undefined;
  restartUiIfTextModeChanged("ui-https", textModeEnabled);
  restartUiIfTextModeChanged("ui", textModeEnabled);
  restartUiIfServingModeChanged("ui-https", serveStatic);
  restartUiIfServingModeChanged("ui", serveStatic);
  restartUiIfStaticRootChanged("ui-https", staticUiDir);
  restartUiIfStaticRootChanged("ui", staticUiDir);
  restartUiIfPublicOriginChanged("ui-https", explicitPublicUrl);
  restartUiIfPublicOriginChanged("ui", explicitPublicUrl);
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
        explicitPublicUrl,
        textModeEnabled,
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
        explicitPublicUrl,
        textModeEnabled,
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
  /**
   * Operator-configured public UI URL (--ui-public-url /
   * HOMERAIL_UI_PUBLIC_URL / ui.publicUrl), only when explicitly set. Derived
   * URLs stay out of the static server so no-config behavior remains strictly
   * request-derived. Both the HTTPS and the HTTP static listeners receive the
   * same canonical Origin; the listener transport never rewrites it, so an
   * HTTPS browser Origin stays HTTPS behind a TLS-terminating proxy that
   * forwards plain HTTP to the fallback listener.
   */
  explicitPublicUrl?: string;
  textModeEnabled: boolean;
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

/**
 * Environment for the zero-dependency static UI server. `HOMERAIL_UI_PUBLIC_URL`
 * is only present when the operator explicitly configured a public UI URL, so
 * the proxy's mutation authorization stays strictly request-derived otherwise.
 */
export function staticUiServerEnv(opts: {
  homerailHome: string;
  staticUiDir: string;
  host: string;
  port: number;
  protocol: "http" | "https";
  managerHttp: string;
  explicitPublicUrl?: string;
  certificate?: UiCertificate;
}): Record<string, string> {
  return {
    HOMERAIL_HOME: opts.homerailHome,
    HOMERAIL_STATIC_UI_DIR: opts.staticUiDir,
    HOMERAIL_UI_HOST: opts.host,
    HOMERAIL_UI_PORT: String(opts.port),
    HOMERAIL_MANAGER_HTTP: opts.managerHttp,
    HOMERAIL_MANAGER_WS: opts.managerHttp.replace(/^http/, "ws"),
    ...(opts.protocol === "https"
      ? {
        HOMERAIL_UI_HTTPS: "1",
        HOMERAIL_UI_HTTPS_KEY: opts.certificate?.keyPath || "",
        HOMERAIL_UI_HTTPS_CERT: opts.certificate?.certPath || "",
      }
      : {}),
    ...(opts.explicitPublicUrl ? { HOMERAIL_UI_PUBLIC_URL: opts.explicitPublicUrl } : {}),
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
  let child: import("child_process").ChildProcess;
  if (serveStatic) {
    const serverScript = path.join(resolveRepoRoot(), "homerail_cli", "dist", "static-ui-server.js");
    child = spawn(process.execPath, [serverScript], {
      cwd: agentUiDir,
      env: {
        ...loadLocalSecrets(),
        ...process.env,
        ...staticUiServerEnv({
          homerailHome: getHomerailHome(),
          staticUiDir: path.join(agentUiDir, "dist"),
          host: opts.host,
          port: opts.port,
          protocol: opts.protocol,
          managerHttp,
          explicitPublicUrl: opts.explicitPublicUrl,
          certificate: opts.certificate,
        }),
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
    staticUiDir: serveStatic ? path.join(agentUiDir, "dist") : undefined,
    managerUrl: opts.managerUrl,
    publicUrl: opts.publicUrl,
    explicitPublicUrl: opts.explicitPublicUrl,
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

/**
 * A detached packaged UI may outlive the AppImage process that mounted or
 * extracted its files. The PID then remains alive while every static request
 * returns 404 because its old resource root has disappeared. Restart it when
 * the current package resolves to a different root, when that root vanished,
 * or when upgrading legacy state that did not record the root at all.
 */
function restartUiIfStaticRootChanged(
  name: "ui" | "ui-https",
  requestedStaticUiDir: string | undefined,
): void {
  if (!requestedStaticUiDir) return;
  const state = readUiState(name);
  const pid = readPid(name) ?? state?.pid;
  if (pid === undefined || !pidIsRunning(pid) || state?.mode !== "static") return;
  const runningStaticUiDir = state.staticUiDir;
  const runningIndex = runningStaticUiDir
    ? path.join(runningStaticUiDir, "index.html")
    : undefined;
  if (
    !runningStaticUiDir ||
    path.resolve(runningStaticUiDir) !== path.resolve(requestedStaticUiDir) ||
    !runningIndex ||
    !fs.existsSync(runningIndex)
  ) {
    stopService(name);
  }
}

/**
 * Compare the explicit external Origin a running UI child was launched with
 * against the newly requested one. Adding (`undefined -> value`), changing
 * (`value -> different value`), and removing (`value -> undefined`) the
 * Origin all invalidate the live child so the new authorization policy is
 * actually applied; an unchanged effective Origin never restarts.
 */
export function explicitPublicUrlChanged(
  runningExplicitPublicUrl: string | undefined,
  requestedExplicitPublicUrl: string | undefined,
): boolean {
  return (runningExplicitPublicUrl ?? undefined) !== (requestedExplicitPublicUrl ?? undefined);
}

function restartUiIfPublicOriginChanged(name: "ui" | "ui-https", explicitPublicUrl: string | undefined): void {
  const state = readUiState(name);
  const pid = readPid(name) ?? state?.pid;
  if (pid === undefined || !pidIsRunning(pid)) return;
  if (explicitPublicUrlChanged(state?.explicitPublicUrl, explicitPublicUrl)) {
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

function stopService(name: RuntimeServiceName, pid = servicePidForStop(name)): boolean {
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

function servicePidForStop(name: RuntimeServiceName): number | undefined {
  const pid = readPid(name);
  if (pid !== undefined && pidIsRunning(pid)) return pid;

  const statePid = name === "manager" ? readManagerState()?.pid : undefined;
  if (statePid !== undefined && pidIsRunning(statePid)) return statePid;
  return pid ?? statePid;
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
        staticUiDir: typeof parsed.staticUiDir === "string" && parsed.staticUiDir
          ? parsed.staticUiDir
          : undefined,
        managerUrl: typeof parsed.managerUrl === "string" ? parsed.managerUrl : DEFAULT_MANAGER_URL,
        publicUrl: typeof parsed.publicUrl === "string" ? parsed.publicUrl : undefined,
        explicitPublicUrl: typeof parsed.explicitPublicUrl === "string" && parsed.explicitPublicUrl
          ? parsed.explicitPublicUrl
          : undefined,
        textModeEnabled: parsed.textModeEnabled === true,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      };
    }
  } catch {
    // Missing or malformed state is treated as absent.
  }
  return undefined;
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

async function waitForPidExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!pidIsRunning(pid)) return;
    await sleep(50);
  }
  throw new Error(`Manager pid=${pid} did not stop within ${timeoutMs}ms`);
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
