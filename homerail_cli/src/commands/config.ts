import type { Command } from "commander";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { HomeRailClient } from "../client.js";
import {
  DEFAULT_MANAGER_URL,
  DEFAULT_UI_HOST,
  configuredManagerHost,
  configuredManagerPort,
  configuredUiPort,
  defaultLocalConfig,
  ensureHomerailHome,
  getConfigPath,
  getHomerailHome,
  getSecretsPath,
  loadLocalConfig,
  redactConfig,
  saveLocalConfig,
  saveLocalSecret,
  setConfigPathValue,
  type LocalHomeRailConfig,
} from "../local-config.js";

interface GlobalOpts {
  json?: boolean;
  baseUrl?: string;
  requestTimeout?: number;
}

interface ApplyResult {
  applied: boolean;
  action: "created" | "updated" | "skipped" | "failed";
  detail: string;
}

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Configure local HomeRail runtime settings")
    .action(async () => {
      const globalOpts = program.opts() as GlobalOpts;
      await runConfigWizard(globalOpts);
    });

  configCmd
    .command("wizard")
    .description("Run the interactive local configuration flow")
    .action(async () => {
      const globalOpts = program.opts() as GlobalOpts;
      await runConfigWizard(globalOpts);
    });

  configCmd
    .command("show")
    .description("Show local HomeRail config with secrets redacted")
    .action(() => {
      const cfg = loadLocalConfig();
      console.log(JSON.stringify(redactConfig(cfg), null, 2));
    });

  configCmd
    .command("path")
    .description("Print the local config path")
    .action(() => {
      console.log(getConfigPath());
    });

  configCmd
    .command("env-path")
    .description("Print the legacy plaintext secrets env path")
    .action(() => {
      console.log(getSecretsPath());
    });

  configCmd
    .command("set")
    .description("Set a local config value; secret-looking keys use the legacy plaintext import file")
    .argument("<key>", "Config key, for example manager.url or HOMERAIL_MIMO_API_KEY")
    .argument("<value>", "Value to set")
    .action((key: string, value: string) => {
      if (isSecretKey(key)) {
        saveLocalSecret(key.toUpperCase(), value);
        console.log(`Set legacy plaintext ${key.toUpperCase()} in ${getSecretsPath()}`);
        console.log("Run `hr config apply` to import it into the Manager encrypted secret store.");
        return;
      }
      const cfg = loadLocalConfig();
      setConfigPathValue(cfg, key, coerceValue(value));
      if (key === "manager.url") {
        cfg.manager = cfg.manager ?? {};
        cfg.manager.port = configuredManagerPort(cfg);
      }
      saveLocalConfig(cfg);
      console.log(`Set ${key} in ${getConfigPath()}`);
    });

  configCmd
    .command("apply")
    .description("Import local model config and legacy secrets into the running Manager encrypted store")
    .action(async () => {
      const globalOpts = program.opts() as GlobalOpts;
      const client = new HomeRailClient({ baseUrl: globalOpts.baseUrl, timeoutMs: globalOpts.requestTimeout });
      const result = await applyStoredModelConfig(client);
      if (globalOpts.json) {
        console.log(JSON.stringify(result));
      } else if (result.applied) {
        console.log(`Applied model config: ${result.detail}`);
      } else {
        console.log(`Model config not applied: ${result.detail}`);
      }
      if (result.action === "failed") process.exitCode = 1;
    });
}

export async function applyStoredModelConfig(client: HomeRailClient): Promise<ApplyResult> {
  void client;
  const cfg = loadLocalConfig();
  return applyModelConfig(cfg);
}

function applyModelConfig(cfg: LocalHomeRailConfig): ApplyResult {
  const preset = cfg.model?.preset?.trim();
  if (!preset) {
    return {
      applied: false,
      action: "skipped",
      detail: "no local model alias configured; run `hr model configure <provider-or-endpoint-alias>` when you are ready",
    };
  }
  return {
    applied: false,
    action: "skipped",
    detail: "legacy local model alias config is not auto-applied; resolve it from the Manager provider catalog with `hr model configure <provider-or-endpoint-alias>`",
  };
}

async function runConfigWizard(_globalOpts: GlobalOpts): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("Error: hr config requires an interactive terminal. Use `hr config set` in non-interactive environments.");
    process.exitCode = 1;
    return;
  }

  ensureHomerailHome();
  const current = loadLocalConfig();
  const next: LocalHomeRailConfig = {
    ...defaultLocalConfig(),
    ...current,
    manager: { ...defaultLocalConfig().manager, ...(current.manager ?? {}) },
    node: { ...defaultLocalConfig().node, ...(current.node ?? {}) },
    model: { ...defaultLocalConfig().model, ...(current.model ?? {}) },
    runtime: { ...defaultLocalConfig().runtime, ...(current.runtime ?? {}) },
  };

  console.log("HomeRail local config");
  console.log(`Config:  ${getConfigPath()}`);
  console.log(`Legacy plaintext secret import: ${getSecretsPath()}`);
  console.log("");

  const rl = readline.createInterface({ input, output });
  try {
    const managerUrl = await promptText(rl, "Manager URL", next.manager?.url || DEFAULT_MANAGER_URL);
    next.manager = next.manager ?? {};
    next.manager.url = managerUrl.replace(/\/+$/, "");
    next.manager.host = await promptText(rl, "Manager bind host", configuredManagerHost(next));
    const managerPublicUrl = await promptText(rl, "Manager public URL (blank for local)", next.manager.publicUrl || "");
    if (managerPublicUrl.trim()) next.manager.publicUrl = managerPublicUrl.trim().replace(/\/+$/, "");
    else delete next.manager.publicUrl;
    next.manager.port = configuredManagerPort(next);

    const projectId = await promptText(rl, "Project ID", next.node?.projectId || "p1");
    const nodeId = await promptText(rl, "Node ID", next.node?.nodeId || "local-docker-node");
    const provider = await promptChoice(rl, "Node provider", ["docker-cli", "docker-api", "mock"], next.node?.provider || "docker-cli");
    next.node = {
      projectId,
      nodeId,
      provider,
    };

    next.ui = next.ui ?? {};
    next.ui.host = await promptText(rl, "Agent UI host", next.ui.host || DEFAULT_UI_HOST);
    const uiPort = await promptText(rl, "Agent UI HTTPS port", String(configuredUiPort(next)));
    next.ui.port = configuredUiPort(next, uiPort);
    const uiPublicUrl = await promptText(rl, "Agent UI public URL (blank for local)", next.ui.publicUrl || "");
    if (uiPublicUrl.trim()) next.ui.publicUrl = uiPublicUrl.trim().replace(/\/+$/, "");
    else delete next.ui.publicUrl;

    next.model = { setDefault: true };

    next.runtime = next.runtime ?? {};
    next.runtime.buildWorkerImage = await promptYesNo(rl, "Build missing worker image during `hr start`", next.runtime.buildWorkerImage !== false);

    saveLocalConfig(next);
  } finally {
    rl.close();
  }

  console.log("");
  console.log("Saved local configuration.");
  console.log("Model settings are stored in Manager. Use `hr model configure <provider-or-endpoint-alias>` after Manager starts.");
  console.log("Next: hr start");
}

async function promptText(
  rl: readline.Interface,
  label: string,
  defaultValue: string,
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await rl.question(`${label}${suffix}: `);
  return answer.trim() || defaultValue;
}

async function promptChoice(
  rl: readline.Interface,
  label: string,
  choices: string[],
  defaultValue: string,
): Promise<string> {
  const defaultIndex = Math.max(0, choices.indexOf(defaultValue));
  console.log(label);
  choices.forEach((choice, index) => {
    const marker = index === defaultIndex ? "*" : " ";
    console.log(`  ${index + 1}. ${marker} ${choice}`);
  });
  const answer = await rl.question(`Choose [${defaultIndex + 1}]: `);
  const parsed = answer.trim() ? Number(answer.trim()) : defaultIndex + 1;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > choices.length) {
    return defaultValue;
  }
  return choices[parsed - 1]!;
}

async function promptYesNo(
  rl: readline.Interface,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  const answer = await rl.question(`${label} [${defaultValue ? "Y/n" : "y/N"}]: `);
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return defaultValue;
  return ["y", "yes", "true", "1"].includes(normalized);
}

function isSecretKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper.endsWith("_KEY") ||
    upper.endsWith("_TOKEN") ||
    upper.endsWith("_SECRET") ||
    upper.endsWith("_PASSWORD") ||
    upper.includes("API_KEY")
  );
}

function coerceValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.includes(",")) return value.split(",").map((item) => item.trim()).filter(Boolean);
  return value;
}
