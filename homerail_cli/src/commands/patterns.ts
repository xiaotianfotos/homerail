import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";

import { getClient } from "../index.js";

interface GlobalOpts {
  baseUrl?: string;
  json?: boolean;
  requestTimeout?: number;
}

interface PatternSummary {
  id: string;
  version: string;
  name: string;
  summary: string;
  required_primitives: string[];
  node_count: number;
}

interface PatternDetail extends PatternSummary {
  intent: string;
  roles: Array<{ id: string; responsibility: string }>;
  typical_uses: string[];
  avoid_when: string[];
  parameters: Record<string, { type: string; description: string; default: unknown }>;
  source: { title: string; author: string; url: string };
}

interface InstantiateResponse {
  success?: boolean;
  message?: string;
  data?: {
    pattern?: PatternDetail;
    parameters?: Record<string, unknown>;
    workflow?: { workflow_id?: string; name?: string };
    yaml_text?: string;
    validation?: { valid?: boolean };
  };
}

interface InstantiateOptions {
  set: string[];
  output?: string;
  sync?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function parsePatternParameters(values: string[]): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid --set value '${value}'. Expected key=value.`);
    const key = value.slice(0, separator).trim();
    const raw = value.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_]+$/.test(key)) throw new Error(`Invalid pattern parameter name: ${key}`);
    if (raw === "true") parameters[key] = true;
    else if (raw === "false") parameters[key] = false;
    else if (raw !== "" && Number.isFinite(Number(raw))) parameters[key] = Number(raw);
    else parameters[key] = raw;
  }
  return parameters;
}

function printPattern(detail: PatternDetail): void {
  console.log(`${detail.name} (${detail.id}@${detail.version})`);
  console.log(detail.summary);
  console.log(`Intent: ${detail.intent}`);
  console.log("Roles:");
  for (const role of detail.roles) console.log(`  ${role.id}: ${role.responsibility}`);
  console.log("Typical uses:");
  for (const use of detail.typical_uses) console.log(`  - ${use}`);
  console.log("Avoid when:");
  for (const item of detail.avoid_when) console.log(`  - ${item}`);
  console.log("Parameters:");
  for (const [name, parameter] of Object.entries(detail.parameters)) {
    console.log(`  ${name} (${parameter.type}, default=${String(parameter.default)}): ${parameter.description}`);
  }
  console.log(`Source: ${detail.source.title} by ${detail.source.author}`);
  console.log(detail.source.url);
}

export function registerPatternsCommand(program: Command): void {
  const patterns = program
    .command("patterns")
    .description("Built-in DAG design pattern catalog");

  patterns
    .command("list")
    .description("List built-in DAG patterns from Manager")
    .action(async () => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      try {
        const response = await client.get("/api/dag/patterns") as {
          data?: { patterns?: PatternSummary[] };
        };
        const items = response.data?.patterns ?? [];
        if (globalOpts.json) {
          console.log(JSON.stringify(items));
          return;
        }
        if (items.length === 0) {
          console.log("No built-in DAG patterns found.");
          return;
        }
        console.log(`${"Pattern".padEnd(28)} ${"Nodes".padEnd(7)} Summary`);
        console.log("-".repeat(90));
        for (const item of items) {
          console.log(`${item.id.padEnd(28)} ${String(item.node_count).padEnd(7)} ${item.summary}`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  patterns
    .command("show <id>")
    .description("Show AI-readable guidance and the abstract workflow template")
    .action(async (id: string) => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      try {
        const response = await client.get(`/api/dag/patterns/${encodeURIComponent(id)}`) as { data?: PatternDetail };
        if (!response.data) throw new Error(`DAG pattern not found: ${id}`);
        if (globalOpts.json) console.log(JSON.stringify(response.data));
        else printPattern(response.data);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  patterns
    .command("instantiate <id>")
    .description("Instantiate a built-in pattern as validated DAG YAML")
    .option("--set <key=value>", "Override a typed pattern parameter; repeat for multiple values", collect, [])
    .option("--output <file>", "Write the generated YAML to a file")
    .option("--sync", "Sync the generated workflow into Manager after validation")
    .action(async (id: string, opts: InstantiateOptions) => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      try {
        const parameters = parsePatternParameters(opts.set);
        const response = await client.post(
          `/api/dag/patterns/${encodeURIComponent(id)}/instantiate`,
          { parameters },
        ) as InstantiateResponse;
        const yamlText = response.data?.yaml_text;
        if (!yamlText || response.data?.validation?.valid !== true) {
          throw new Error("Manager did not return a valid instantiated DAG.");
        }

        let outputPath: string | undefined;
        if (opts.output) {
          outputPath = path.resolve(opts.output);
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, yamlText, "utf8");
        }

        let syncResponse: unknown;
        if (opts.sync) {
          syncResponse = await client.post("/api/dag/workflows/sync", {
            yaml_text: yamlText,
            source_path: outputPath ?? `builtin:${id}`,
          });
        }

        if (globalOpts.json) {
          console.log(JSON.stringify({ ...response.data, output_path: outputPath, sync: syncResponse }));
          return;
        }
        if (!outputPath && !opts.sync) {
          process.stdout.write(yamlText);
          return;
        }
        const workflowId = response.data?.workflow?.workflow_id ?? id;
        if (outputPath) console.log(`Pattern instantiated: ${workflowId} -> ${outputPath}`);
        if (opts.sync) console.log(`Workflow synced: ${workflowId}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
