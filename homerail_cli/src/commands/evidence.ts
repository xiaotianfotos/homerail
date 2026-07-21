/**
 * Evidence commands registration — scorecard, eval-run, replay, trace, stats
 */

import type { Command } from "commander";
import { getClient } from "../index.js";
import { cmdScorecard } from "./scorecard.js";
import { cmdEvalRun } from "./eval-run.js";
import { cmdReplay } from "./replay.js";
import { cmdTrace } from "./trace.js";
import { cmdStats } from "./stats.js";

interface GlobalOpts {
  baseUrl?: string;
  json?: boolean;
  requestTimeout?: number;
}

export function registerEvidenceCommands(program: Command): void {
  program
    .command("scorecard <runId>")
    .description("Show scorecard for a DAG run")
    .option("--source-issue <n>", "Source issue number for consistency check")
    .action(async (runId: string, opts: { sourceIssue?: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      process.exitCode = await cmdScorecard(client, runId, !!globalOpts.json, {
        sourceIssue: opts.sourceIssue,
      });
    });

  program
    .command("eval-run <runId>")
    .description("Show eval report for a DAG run")
    .option("--events <n>", "Max events to include", "5")
    .option("--tools <n>", "Recent tool calls per node", "3")
    .option("--content-limit <n>", "Max handoff content chars", "300")
    .option("--source-issue <n>", "Source issue number")
    .action(async (runId: string, opts: { events: string; tools: string; contentLimit: string; sourceIssue?: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      process.exitCode = await cmdEvalRun(client, runId, !!globalOpts.json, {
        events: parseInt(opts.events, 10),
        tools: parseInt(opts.tools, 10),
        contentLimit: parseInt(opts.contentLimit, 10),
        sourceIssue: opts.sourceIssue,
      });
    });

  program
    .command("replay <runId>")
    .description("Show replay plan for a DAG run")
    .option("--source-issue <n>", "Source issue number")
    .action(async (runId: string, opts: { sourceIssue?: string }) => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      process.exitCode = await cmdReplay(client, runId, !!globalOpts.json, {
        sourceIssue: opts.sourceIssue,
      });
    });

  program
    .command("trace <runId>")
    .description("Show execution trace for a DAG run")
    .option("--node <id>", "Filter to a specific node ID")
    .option("--raw", "Print the complete local Claude SDK JSONL trace (requires --node)")
    .action(async (runId: string, opts: { node?: string; raw?: boolean }) => {
      const globalOpts = program.opts<GlobalOpts>();
      const client = getClient(globalOpts);
      process.exitCode = await cmdTrace(client, runId, opts.node, !!globalOpts.json, opts.raw === true);
    });

  program
    .command("stats")
    .description("Show CLI usage statistics")
    .option("--top", "Show top orchestrations")
    .option("--by-orchestration", "Show only orchestrations breakdown")
    .option("--by-agent", "Show only agents breakdown")
    .option("--clean", "Clear all recorded stats")
    .option("--limit <n>", "Limit results", "10")
    .option("--verbose", "Show extra detail")
    .action((opts: { top?: boolean; byOrchestration?: boolean; byAgent?: boolean; clean?: boolean; limit: string; verbose?: boolean }) => {
      const globalOpts = program.opts<GlobalOpts>();
      process.exitCode = cmdStats(
        !!opts.top,
        !!opts.byOrchestration,
        !!opts.byAgent,
        !!opts.clean,
        parseInt(opts.limit, 10),
        !!opts.verbose,
        !!globalOpts.json,
      );
    });
}
