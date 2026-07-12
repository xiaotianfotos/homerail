import type { Command } from "commander";
import * as fs from "node:fs";
import { getClient } from "../index.js";
import { cmdDagChats } from "./dag-chats.js";
import { cmdDagHandoffs } from "./dag-handoffs.js";
import { cmdDagQuick } from "./dag-quick.js";
import {
  cmdDagSuperviseContinuous,
  cmdDagSuperviseTick,
} from "./dag-supervise.js";
import { cmdDagWatch } from "./dag-watch.js";
import { cmdInject } from "./inject.js";
import { cmdResume, type ResumeOptions } from "./resume.js";
import { orchestrationsDir, resolveTemplatePath } from "./templates.js";

interface GlobalOpts {
  baseUrl?: string;
  json?: boolean;
  requestTimeout?: number;
}

interface WorkflowDiagnostic {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
  line?: number;
  column?: number;
  hint?: string;
}

interface WorkflowValidationResult {
  valid: boolean;
  source_format: "yaml" | "json";
  source_api_version?: string;
  canonical_hash?: string;
  diagnostics: WorkflowDiagnostic[];
  summary?: {
    workflow_id: string;
    node_count: number;
    edge_count: number;
    entry_nodes: string[];
    terminal_nodes: string[];
  };
}

export function registerDagCommands(program: Command): void {
  const dagCmd = program.command("dag").description("DAG status and supervision commands");
  const registerResumeCommand = (command: Command) => {
    command
      .command("resume <runId> <nodeId>")
      .description("Fork and resume a DAG node from a SessionStore checkpoint")
      .option("--uuid <uuid>", "Checkpoint entry UUID")
      .option("--last <n>", "Resume from the nth latest checkpoint marker")
      .option("--instruction <text>", "Instruction injected into the resumed node prompt")
      .option("--session-id <id>", "Explicit new session id for the forked attempt")
      .action(async (runId: string, nodeId: string, opts: ResumeOptions) => {
        const globalOpts = program.opts<GlobalOpts>();
        const client = getClient(globalOpts);
        process.exitCode = await cmdResume(client, runId, nodeId, opts, !!globalOpts.json);
      });
  };

  dagCmd
    .command("sync <template>")
    .description("Sync a DAG YAML asset into the Manager database by stable workflow_id")
    .action(async (template: string) => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      const filePath = resolveTemplatePath(orchestrationsDir(), template);
      if (!fs.existsSync(filePath)) {
        console.error(`Error: DAG template not found: ${template}`);
        process.exitCode = 1;
        return;
      }
      try {
        const resp = await client.post("/api/dag/workflows/sync", {
          yaml_text: fs.readFileSync(filePath, "utf8"),
          source_path: filePath,
        }) as { data?: { workflow?: { workflow_id?: string; name?: string }; warning?: string }; message?: string };
        if (globalOpts.json) {
          console.log(JSON.stringify(resp));
          return;
        }
        const workflow = resp.data?.workflow;
        console.log(`DAG synced: ${workflow?.workflow_id ?? "unknown"} (${workflow?.name ?? "unnamed"})`);
        console.log("workflow_id is the stable identity. Keep it unchanged when editing YAML; change it only for a new workflow/version.");
      } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  dagCmd
    .command("validate <template>")
    .description("Validate a DAG YAML or JSON document without syncing it")
    .action(async (template: string) => {
      const globalOpts = program.opts<GlobalOpts>();
      const filePath = resolveTemplatePath(orchestrationsDir(), template);
      if (!fs.existsSync(filePath)) {
        console.error(`Error: DAG document not found: ${template}`);
        process.exitCode = 1;
        return;
      }
      try {
        const client = getClient(globalOpts);
        const response = await client.post("/api/dag/validate", {
          source: fs.readFileSync(filePath, "utf8"),
        }) as { data?: WorkflowValidationResult };
        const result = response.data;
        if (!result) throw new Error("Manager returned no validation result");
        if (globalOpts.json) {
          console.log(JSON.stringify(result));
        } else if (result.valid) {
          const summary = result.summary;
          console.log(`Valid ${result.source_api_version ?? "workflow"}: ${summary?.workflow_id ?? template}`);
          console.log(`Nodes: ${summary?.node_count ?? 0}  Edges: ${summary?.edge_count ?? 0}`);
          if (result.canonical_hash) console.log(`Canonical hash: ${result.canonical_hash}`);
          for (const entry of result.diagnostics.filter((item) => item.severity === "warning")) {
            console.log(formatWorkflowDiagnostic(entry));
          }
        } else {
          for (const entry of result.diagnostics) console.error(formatWorkflowDiagnostic(entry));
          process.exitCode = 1;
        }
      } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  dagCmd
    .command("schema")
    .description("Fetch the live WorkflowSpec JSON Schema from Manager")
    .action(async () => {
      const globalOpts = program.opts<GlobalOpts>();
      try {
        const client = getClient(globalOpts);
        const response = await client.get("/api/dag/schema") as {
          data?: { schema?: unknown; api_version?: string; compiler_version?: string; schema_hash?: string };
        };
        if (!response.data?.schema) throw new Error("Manager returned no WorkflowSpec schema");
        if (globalOpts.json) {
          console.log(JSON.stringify(response.data));
        } else {
          console.log(JSON.stringify(response.data.schema, null, 2));
        }
      } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  dagCmd
    .command("approvals")
    .description("List DAG nodes waiting for an authorized human decision")
    .action(async () => {
      const globalOpts = program.opts<GlobalOpts>();
      try {
        const response = await getClient(globalOpts).get("/api/dag/approvals") as {
          data?: { approvals?: Array<Record<string, unknown>> };
        };
        const approvals = response.data?.approvals ?? [];
        if (globalOpts.json) console.log(JSON.stringify(approvals));
        else if (approvals.length === 0) console.log("No pending DAG approvals.");
        else for (const approval of approvals) {
          console.log(`${String(approval.run_id)} ${String(approval.node_id)} ${String(approval.approval_id)} ${String(approval.proposal_hash)}`);
        }
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  dagCmd
    .command("decide <runId> <nodeId>")
    .description("Approve or reject a durable DAG approval node")
    .requiredOption("--decision <approved|rejected>")
    .requiredOption("--actor <actor>")
    .requiredOption("--proposal-hash <hash>")
    .action(async (runId: string, nodeId: string, opts: { decision: string; actor: string; proposalHash: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      if (opts.decision !== "approved" && opts.decision !== "rejected") {
        console.error("Error: --decision must be approved or rejected");
        process.exitCode = 1;
        return;
      }
      try {
        const response = await getClient(globalOpts).post(
          `/api/runs/${encodeURIComponent(runId)}/node/${encodeURIComponent(nodeId)}/approval`,
          {
            decision: opts.decision,
            actor: opts.actor,
            proposal_hash: opts.proposalHash,
            ...(process.env.HOMERAIL_DAG_APPROVAL_TOKEN
              ? { authorization_token: process.env.HOMERAIL_DAG_APPROVAL_TOKEN }
              : {}),
          },
        );
        console.log(globalOpts.json ? JSON.stringify(response) : `Approval ${opts.decision}: ${runId}/${nodeId}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  dagCmd
    .command("triggers")
    .description("List Manager-owned DAG interval and event triggers")
    .action(async () => {
      const globalOpts = program.opts<GlobalOpts>();
      try {
        const response = await getClient(globalOpts).get("/api/dag/triggers") as { data?: { triggers?: Array<Record<string, unknown>> } };
        const triggers = response.data?.triggers ?? [];
        if (globalOpts.json) console.log(JSON.stringify(triggers));
        else if (triggers.length === 0) console.log("No DAG triggers configured.");
        else for (const trigger of triggers) console.log(`${String(trigger.trigger_key)} ${String((trigger.config as Record<string, unknown> | undefined)?.type ?? "")}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  dagCmd
    .command("trigger-event <event>")
    .description("Deliver an idempotent event to matching DAG triggers")
    .requiredOption("--idempotency-key <key>")
    .option("--payload <json>", "JSON event payload", "{}")
    .action(async (event: string, opts: { idempotencyKey: string; payload: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      try {
        const payload = JSON.parse(opts.payload) as unknown;
        const response = await getClient(globalOpts).post(`/api/dag/triggers/events/${encodeURIComponent(event)}`, {
          idempotency_key: opts.idempotencyKey,
          payload,
          ...((process.env.HOMERAIL_DAG_MUTATION_TOKEN ?? process.env.HOMERAIL_DAG_APPROVAL_TOKEN)
            ? { authorization_token: process.env.HOMERAIL_DAG_MUTATION_TOKEN ?? process.env.HOMERAIL_DAG_APPROVAL_TOKEN }
            : {}),
        });
        console.log(JSON.stringify(response));
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  dagCmd
    .command("state-get <namespace> <key>")
    .description("Read a namespaced Manager-owned DAG state record")
    .action(async (namespace: string, key: string) => {
      const globalOpts = program.opts<GlobalOpts>();
      try {
        const response = await getClient(globalOpts).get(`/api/dag/state/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`);
        console.log(JSON.stringify(response, null, globalOpts.json ? 0 : 2));
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  dagCmd
    .command("state-set <namespace> <key> <value>")
    .description("Atomically write JSON to a namespaced Manager-owned DAG state record")
    .option("--expected-version <n>", "Compare-and-set against this version")
    .action(async (namespace: string, key: string, value: string, opts: { expectedVersion?: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      try {
        const response = await getClient(globalOpts).post(`/api/dag/state/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, {
          value: JSON.parse(value) as unknown,
          ...(opts.expectedVersion === undefined ? {} : { expected_version: Number(opts.expectedVersion) }),
          ...((process.env.HOMERAIL_DAG_MUTATION_TOKEN ?? process.env.HOMERAIL_DAG_APPROVAL_TOKEN)
            ? { authorization_token: process.env.HOMERAIL_DAG_MUTATION_TOKEN ?? process.env.HOMERAIL_DAG_APPROVAL_TOKEN }
            : {}),
        });
        console.log(JSON.stringify(response, null, globalOpts.json ? 0 : 2));
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  dagCmd
    .command("quick <runId>")
    .description("Show compact DAG status snapshot")
    .option("--events <n>", "Recent event count", "10")
    .action(async (runId: string, opts: { events: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      process.exitCode = await cmdDagQuick(
        client,
        runId,
        parseInt(opts.events, 10),
        !!globalOpts.json,
      );
    });

  dagCmd
    .command("watch <runId>")
    .description("Watch DAG status changes with bounded timeout")
    .option("--events <n>", "Recent event count", "5")
    .option("--interval <sec>", "Polling interval seconds", "2")
    .option("--timeout <sec>", "Total watch timeout seconds", "60")
    .action(async (runId: string, opts: { events: string; interval: string; timeout: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      process.exitCode = await cmdDagWatch(
        client,
        runId,
        parseInt(opts.events, 10),
        parseFloat(opts.interval),
        parseInt(opts.timeout, 10),
        !!globalOpts.json,
      );
    });

  dagCmd
    .command("supervise <runId>")
    .description("Supervise a DAG run with cursor-based deltas")
    .option("--tick", "Run one cursor-based supervision tick and exit", false)
    .option("--cursor <str>", "Opaque cursor from previous tick", "")
    .option("--events <n>", "Max new events to include", "5")
    .option("--tools <n>", "Recent tool calls per node", "3")
    .option("--content-limit <n>", "Max handoff content chars", "300")
    .option("--interval <sec>", "Polling interval seconds", "5")
    .option("--timeout <sec>", "Total supervise timeout", "600")
    .option("--report-every <sec>", "Heartbeat interval", "60")
    .action(async (
      runId: string,
      opts: {
        tick?: boolean;
        cursor: string;
        events: string;
        tools: string;
        contentLimit: string;
        interval: string;
        timeout: string;
        reportEvery: string;
      },
    ) => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      if (opts.tick) {
        process.exitCode = await cmdDagSuperviseTick(
          client,
          runId,
          opts.cursor ?? "",
          parseInt(opts.events, 10),
          parseInt(opts.tools, 10),
          parseInt(opts.contentLimit, 10),
          !!globalOpts.json,
        );
        return;
      }
      process.exitCode = await cmdDagSuperviseContinuous(
        client,
        runId,
        parseFloat(opts.interval),
        parseInt(opts.timeout, 10),
        parseInt(opts.events, 10),
        parseInt(opts.tools, 10),
        parseInt(opts.contentLimit, 10),
        parseFloat(opts.reportEvery),
        !!globalOpts.json,
      );
    });

  dagCmd
    .command("chats <runId>")
    .description("Summarize per-node chat/tool activity")
    .option("--node <ids...>", "Node IDs to include")
    .option("--tools <n>", "Recent tool calls per node", "5")
    .option("--raw-tools", "Show redacted tool inputs and result previews", false)
    .action(async (runId: string, opts: { node?: string[]; tools: string; rawTools?: boolean }) => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      process.exitCode = await cmdDagChats(
        client,
        runId,
        opts.node,
        parseInt(opts.tools, 10),
        !!opts.rawTools,
        !!globalOpts.json,
      );
    });

  dagCmd
    .command("handoffs <runId>")
    .description("Show handoff content and contract hook checks")
    .option("--content-limit <n>", "Max handoff content chars", "500")
    .action(async (runId: string, opts: { contentLimit: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      process.exitCode = await cmdDagHandoffs(
        client,
        runId,
        parseInt(opts.contentLimit, 10),
        !!globalOpts.json,
      );
    });

  registerResumeCommand(dagCmd);

  program
    .command("inject <runId> <nodeId> <instruction>")
    .description("Inject an instruction into a DAG node")
    .option("--mode <mode>", "Injection mode: auto|inbox|interrupt|redispatch", "inbox")
    .action(async (runId: string, nodeId: string, instruction: string, opts: { mode: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      process.exitCode = await cmdInject(client, runId, nodeId, instruction, opts.mode);
    });

  registerResumeCommand(program);
}

function formatWorkflowDiagnostic(entry: WorkflowDiagnostic): string {
  const location = entry.line !== undefined
    ? ` line ${entry.line}${entry.column !== undefined ? `:${entry.column}` : ""}`
    : "";
  const hint = entry.hint ? ` Hint: ${entry.hint}` : "";
  return `${entry.code} ${entry.path}${location}: ${entry.message}.${hint}`;
}
