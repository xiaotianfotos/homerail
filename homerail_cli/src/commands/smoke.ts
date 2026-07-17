import type { Command } from "commander";
import { getClient } from "../index.js";
import type { BaseResponse } from "../client.js";
import { dockerReadiness } from "./doctor.js";

const DEFAULT_PROMPT = "Create a concise implementation checklist for a small README improvement.";
const WINDOWS_SMOKE_TEMPLATE = "assets/orchestrations/public-two-node.yaml.template";
const WINDOWS_SMOKE_PROFILE = "offline-deterministic";
const WINDOWS_SMOKE_PROMPT = "Draft a short checklist for a Windows HomeRail runtime smoke.";

interface GlobalOpts {
  json?: boolean;
  baseUrl?: string;
  requestTimeout?: number;
}

interface SmokeDagOpts {
  template: string;
  prompt: string;
  profile?: string;
  settingId?: string;
  wait: boolean;
  interval: string;
  timeout: string;
}

interface SmokeManagerAgentOpts {
  message?: string;
  projectId: string;
  settingId?: string;
  provider?: string;
  model?: string;
  expectRun: boolean;
  wait: boolean;
  interval: string;
  timeout: string;
}

interface SmokeWindowsOpts {
  template: string;
  prompt: string;
  profile: string;
  wait: boolean;
  interval: string;
  timeout: string;
  dockerCheck: boolean;
}

interface SmokeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function registerSmokeCommand(program: Command): void {
  const smokeCmd = program
    .command("smoke")
    .description("Run release smoke checks");

  smokeCmd
    .command("dag")
    .description("Start a DAG smoke run from an explicit YAML template")
    .requiredOption("--template <path>", "DAG YAML path or .yaml.template path")
    .option("--prompt <text>", "Smoke prompt", DEFAULT_PROMPT)
    .option("--profile <profile>", "Runtime profile; only agent_type selection is supported", process.env.HOMERAIL_SMOKE_PROFILE)
    .option("--setting-id <id>", "Database LLM setting id for this DAG run")
    .option("--no-wait", "Only start the run; do not wait for terminal status")
    .option("--interval <sec>", "Polling interval while waiting", "3")
    .option("--timeout <sec>", "Maximum wait time", "300")
    .action(
      async (opts: SmokeDagOpts) => {
        const globalOpts = program.opts() as GlobalOpts;
        const client = getClient(globalOpts);
        const payload: Record<string, unknown> = {
          yamlPath: opts.template,
          prompt: opts.prompt,
        };
        if (opts.profile) payload.profile = opts.profile;
        if (opts.settingId) payload.llm_setting_id = opts.settingId;

        try {
          const resp = await client.post<BaseResponse>("/api/runs/create-and-run", payload);
          const data = resp.data as Record<string, unknown> | undefined;
          const runId = String(data?.run_id ?? data?.runId ?? "");
          if (!runId) {
            throw new Error("manager did not return a run_id");
          }

          if (!opts.wait) {
            if (globalOpts.json) {
              console.log(JSON.stringify(resp));
              return;
            }
            console.log(`Smoke DAG started: ${runId}`);
            console.log(`Template: ${opts.template}`);
            console.log("Next:");
            console.log(`  hr dag supervise ${runId}`);
            console.log(`  hr scorecard ${runId}`);
            console.log(`  hr eval-run ${runId}`);
            return;
          }

          const timeoutMs = parseInt(opts.timeout, 10) * 1000;
          const intervalMs = parseFloat(opts.interval) * 1000;
          const finalStatus = await waitForTerminalRun(
            client,
            runId,
            timeoutMs,
            intervalMs,
            globalOpts.json ? undefined : (status) => {
              console.log(`Smoke DAG status: ${status}`);
            },
          );
          const scorecard = await client.getScorecard(runId);
          const scorecardData = scorecard.data as Record<string, unknown> | undefined;
          const scorecardPassed = scorecard.success && scorecardData?.passed === true;
          const evalRun = await client.getEvalRun(runId);
          const evalRunData = evalRun.data as Record<string, unknown> | undefined;
          const evalVerdict = String(evalRunData?.verdict ?? "unknown").toLowerCase();
          const evalPassed = evalRun.success && ["pass", "pass_with_warnings", "scorecard_blind_spot"].includes(evalVerdict);

          if (globalOpts.json) {
            console.log(JSON.stringify({
              run_id: runId,
              status: finalStatus,
              scorecard: scorecardData ?? null,
              eval_run: evalRunData ?? null,
              passed: finalStatus === "completed" && scorecardPassed && evalPassed,
            }));
            return;
          }

          console.log(`Smoke DAG started: ${runId}`);
          console.log(`Template: ${opts.template}`);
          console.log(`Final status: ${finalStatus}`);
          console.log(
            `Scorecard: ${scorecardPassed ? "PASS" : "FAIL"} (${String(scorecardData?.score ?? "?")}/${String(scorecardData?.total ?? "?")})`,
          );
          console.log(`Eval: ${evalPassed ? "PASS" : "FAIL"} (${evalVerdict})`);
          console.log(`Inspect: hr dag handoffs ${runId}`);
          if (finalStatus !== "completed" || !scorecardPassed || !evalPassed) {
            process.exitCode = 1;
          }
        } catch (err: unknown) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      },
    );

  smokeCmd
    .command("windows")
    .description("Verify Windows runtime prerequisites and run the smallest deterministic DAG")
    .option("--template <path>", "DAG YAML path or .yaml.template path", WINDOWS_SMOKE_TEMPLATE)
    .option("--prompt <text>", "Smoke prompt", WINDOWS_SMOKE_PROMPT)
    .option("--profile <profile>", "Runtime profile", WINDOWS_SMOKE_PROFILE)
    .option("--no-docker-check", "Skip Docker CLI/daemon/image preflight")
    .option("--no-wait", "Only start the run; do not wait for terminal status")
    .option("--interval <sec>", "Polling interval while waiting", "3")
    .option("--timeout <sec>", "Maximum wait time", "300")
    .action(async (opts: SmokeWindowsOpts) => {
      const globalOpts = program.opts() as GlobalOpts;
      const client = getClient(globalOpts);

      try {
        const runtime = await client.get<BaseResponse | Record<string, unknown>>("/runtime/status");
        const runtimeData = dataFromResponse(runtime);
        const checks = windowsRuntimeChecks(runtimeData);
        if (opts.dockerCheck) checks.push(...dockerReadiness());
        const preflightPassed = checks.every((check) => check.ok);
        if (!preflightPassed) {
          if (globalOpts.json) {
            console.log(JSON.stringify({
              passed: false,
              phase: "preflight",
              checks,
              runtime: runtimeData,
            }));
          } else {
            console.log("Windows smoke preflight: FAIL");
            for (const check of checks) {
              console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
            }
          }
          process.exitCode = 1;
          return;
        }

        const resp = await client.post<BaseResponse>("/api/runs/create-and-run", {
          yamlPath: opts.template,
          prompt: opts.prompt,
          profile: opts.profile,
        });
        const data = resp.data as Record<string, unknown> | undefined;
        const runId = String(data?.run_id ?? data?.runId ?? "");
        if (!runId) throw new Error("manager did not return a run_id");

        if (!opts.wait) {
          if (globalOpts.json) {
            console.log(JSON.stringify({ passed: true, phase: "started", checks, run_id: runId }));
            return;
          }
          console.log("Windows smoke preflight: PASS");
          console.log(`Smoke DAG started: ${runId}`);
          console.log(`Template: ${opts.template}`);
          return;
        }

        const timeoutMs = parseInt(opts.timeout, 10) * 1000;
        const intervalMs = parseFloat(opts.interval) * 1000;
        const finalStatus = await waitForTerminalRun(
          client,
          runId,
          timeoutMs,
          intervalMs,
          globalOpts.json ? undefined : (status) => {
            console.log(`Windows smoke DAG status: ${status}`);
          },
        );
        const scorecard = await client.getScorecard(runId);
        const scorecardData = scorecard.data as Record<string, unknown> | undefined;
        const scorecardPassed = scorecard.success && scorecardData?.passed === true;
        const evalRun = await client.getEvalRun(runId);
        const evalRunData = evalRun.data as Record<string, unknown> | undefined;
        const evalVerdict = String(evalRunData?.verdict ?? "unknown").toLowerCase();
        const evalPassed = evalRun.success && ["pass", "pass_with_warnings", "scorecard_blind_spot"].includes(evalVerdict);
        const passed = finalStatus === "completed" && scorecardPassed && evalPassed;

        if (globalOpts.json) {
          console.log(JSON.stringify({
            passed,
            phase: "dag",
            checks,
            run_id: runId,
            status: finalStatus,
            scorecard: scorecardData ?? null,
            eval_run: evalRunData ?? null,
          }));
          if (!passed) process.exitCode = 1;
          return;
        }

        console.log("Windows smoke preflight: PASS");
        console.log(`Smoke DAG started: ${runId}`);
        console.log(`Template: ${opts.template}`);
        console.log(`Final status: ${finalStatus}`);
        console.log(
          `Scorecard: ${scorecardPassed ? "PASS" : "FAIL"} (${String(scorecardData?.score ?? "?")}/${String(scorecardData?.total ?? "?")})`,
        );
        console.log(`Eval: ${evalPassed ? "PASS" : "FAIL"} (${evalVerdict})`);
        if (!passed) process.exitCode = 1;
      } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  smokeCmd
    .command("manager-agent")
    .description("Ask the configured Manager Agent to start a deterministic DAG and verify the returned run")
    .option("--message <text>", "Manager Agent smoke prompt")
    .option("--project-id <id>", "Project id used for the Manager Agent session", "manager-agent-smoke")
    .option("--setting-id <id>", "Override Manager LLM setting id for this smoke")
    .option("--provider <id>", "Override Manager provider id for this smoke")
    .option("--model <name>", "Override Manager model name for this smoke")
    .option("--no-expect-run", "Do not require a run_id in the Manager Agent response")
    .option("--no-wait", "Only require the Manager Agent response; do not wait for terminal DAG status")
    .option("--interval <sec>", "Polling interval while waiting", "3")
    .option("--timeout <sec>", "Maximum wait time", "300")
    .action(async (opts: SmokeManagerAgentOpts) => {
      const globalOpts = program.opts() as GlobalOpts;
      const client = getClient(globalOpts);
      const message = opts.message || [
        "Run the Manager Agent live smoke.",
        "Use the create_and_run tool exactly once with yamlPath assets/orchestrations/public-two-node.yaml.template, profile offline-deterministic, and a short smoke prompt.",
        "Then call finish with a concise summary that includes the run id.",
      ].join(" ");
      const payload: Record<string, unknown> = {
        project_id: opts.projectId,
        message,
      };
      if (opts.expectRun) payload.required_tool_calls = ["create_and_run"];
      if (opts.settingId) payload.manager_llm_setting_id = opts.settingId;
      if (opts.provider) payload.manager_provider_name = opts.provider;
      if (opts.model) payload.manager_model_name = opts.model;

      try {
        const resp = await client.post<BaseResponse>("/api/manager/chat", payload);
        const data = resp.data as Record<string, unknown> | undefined;
        const runId = String(data?.run_id ?? "");
        const toolCalls = Array.isArray(data?.tool_calls)
          ? data.tool_calls.map((item) =>
              item && typeof item === "object" && "name" in item
                ? String((item as { name?: unknown }).name ?? "")
                : "",
            ).filter(Boolean)
          : [];
        const workerId = typeof data?.worker_id === "string" ? data.worker_id : null;
        const text = typeof data?.text === "string" ? data.text : "";

        if (opts.expectRun && !runId) {
          throw new Error(`manager-agent response did not include run_id: ${JSON.stringify(data)}`);
        }

        let finalStatus: string | null = null;
        if (runId && opts.wait) {
          const timeoutMs = parseInt(opts.timeout, 10) * 1000;
          const intervalMs = parseFloat(opts.interval) * 1000;
          finalStatus = await waitForTerminalRun(
            client,
            runId,
            timeoutMs,
            intervalMs,
            globalOpts.json ? undefined : (status) => {
              console.log(`Manager Agent smoke run status: ${status}`);
            },
          );
        }

        const passed = (!opts.expectRun || Boolean(runId)) && (!runId || !opts.wait || finalStatus === "completed");
        if (globalOpts.json) {
          console.log(JSON.stringify({
            passed,
            run_id: runId || null,
            run_status: finalStatus,
            tool_calls: toolCalls,
            worker_id: workerId,
            text,
          }));
          if (!passed) process.exitCode = 1;
          return;
        }

        console.log(`Manager Agent smoke: ${passed ? "PASS" : "FAIL"}`);
        if (runId) console.log(`Run: ${runId}`);
        if (finalStatus) console.log(`Final status: ${finalStatus}`);
        if (workerId) console.log(`Worker: ${workerId}`);
        if (toolCalls.length > 0) console.log(`Tool calls: ${toolCalls.join(", ")}`);
        if (text) console.log(`Reply: ${text}`);
        if (!passed) process.exitCode = 1;
      } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}

function dataFromResponse(value: BaseResponse | Record<string, unknown>): Record<string, unknown> {
  if (value && typeof value === "object" && "data" in value) {
    const data = (value as BaseResponse).data;
    return data && typeof data === "object" ? data as Record<string, unknown> : {};
  }
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function windowsRuntimeChecks(data: Record<string, unknown>): SmokeCheck[] {
  const connectedNodes = Number(data.connected_nodes ?? 0);
  return [
    {
      name: "runtime",
      ok: Boolean(data.runtime || connectedNodes > 0 || data.node_ids),
      detail: data.runtime ? String(data.runtime) : "runtime status available",
    },
    {
      name: "node",
      ok: connectedNodes > 0,
      detail: connectedNodes > 0 ? `${connectedNodes} connected` : "run: hr start",
    },
    {
      name: "docker-node",
      ok: hasDockerCapableNode(data),
      detail: hasDockerCapableNode(data)
        ? "connected node advertises docker-cli/docker-api"
        : "no connected node advertises docker-cli/docker-api",
    },
  ];
}

function hasDockerCapableNode(data: Record<string, unknown>): boolean {
  const capabilities = data.node_capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  return Object.values(capabilities as Record<string, unknown>).some((value) =>
    Array.isArray(value) &&
    value.some((capability) => capability === "docker-cli" || capability === "docker-api")
  );
}

async function waitForTerminalRun(
  client: { getRunStatus: (runId: string) => Promise<BaseResponse> },
  runId: string,
  timeoutMs: number,
  intervalMs: number,
  onStatus?: (status: string) => void,
): Promise<string> {
  const start = Date.now();
  let lastStatus = "";

  while (Date.now() - start <= timeoutMs) {
    const resp = await client.getRunStatus(runId);
    const data = resp.data as Record<string, unknown> | undefined;
    const status = String(data?.status ?? "unknown");
    if (status !== lastStatus) {
      lastStatus = status;
      onStatus?.(status);
    }
    if (["completed", "failed", "cancelled"].includes(status)) {
      return status;
    }
    await sleep(intervalMs);
  }

  throw new Error(`timed out waiting for smoke DAG ${runId}; last status: ${lastStatus || "unknown"}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
