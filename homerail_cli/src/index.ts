import { Command, InvalidArgumentError } from "commander";
import { HomeRailClient } from "./client.js";
import { registerTemplatesCommand } from "./commands/templates.js";
import { registerRunCommand } from "./commands/run.js";
import { registerRunsCommand } from "./commands/runs.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerDagCommands } from "./commands/dag.js";
import { registerProviderCommand } from "./commands/provider.js";
import { registerLlmSettingsCommand } from "./commands/llm-settings.js";
import { registerEvidenceCommands } from "./commands/evidence.js";
import { registerModelCommand } from "./commands/model.js";
import { registerProfileCommand } from "./commands/profile.js";
import { registerVoiceCommand } from "./commands/voice.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerSmokeCommand } from "./commands/smoke.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerRuntimeCommands } from "./commands/runtime.js";
import { registerPatternsCommand } from "./commands/patterns.js";
import { registerPluginCommand } from "./commands/plugin.js";
import { DEFAULT_MANAGER_URL } from "./local-config.js";
import { registerCredentialCommand } from "./commands/credential.js";

export { HomeRailClient } from "./client.js";
export type { BaseResponse, HomeRailClientOptions } from "./client.js";

export function createProgram(): Command {
  const program = new Command();
  program
    .name("hr")
    .description("HomeRail CLI - DAG orchestration control (TypeScript)")
    .version("0.1.0")
    .option("--base-url <url>", `Manager API URL (default: $HOMERAIL_MANAGER_URL or ${DEFAULT_MANAGER_URL})`)
    .option("--request-timeout <ms>", "HTTP request timeout in milliseconds", parseTimeoutOption, 30_000)
    .option("--json", "Output as JSON");

  registerTemplatesCommand(program);
  registerPatternsCommand(program);
  registerPluginCommand(program);
  registerCredentialCommand(program);
  registerRunCommand(program);
  registerRunsCommand(program);
  registerStatusCommand(program);
  registerStopCommand(program);
  registerDagCommands(program);
  registerProviderCommand(program);
  registerLlmSettingsCommand(program);
  registerModelCommand(program);
  registerProfileCommand(program);
  registerVoiceCommand(program);
  registerConfigCommand(program);
  registerRuntimeCommands(program);
  registerDoctorCommand(program);
  registerSmokeCommand(program);
  registerEvidenceCommands(program);

  return program;
}

export function getClient(opts: { baseUrl?: string; requestTimeout?: number }): HomeRailClient {
  return new HomeRailClient({ baseUrl: opts.baseUrl, timeoutMs: opts.requestTimeout });
}

function parseTimeoutOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("timeout must be a positive integer");
  }
  return parsed;
}
