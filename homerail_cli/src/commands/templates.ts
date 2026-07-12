import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { configuredAssetRoot } from "../local-config.js";

export function repoRoot(): string {
  // Walk up from cwd to find assets/orchestrations
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "assets", "orchestrations"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function orchestrationsDir(): string {
  const assetRoot = configuredAssetRoot();
  return path.join(assetRoot ?? path.join(repoRoot(), "assets"), "orchestrations");
}

export function isYamlFile(name: string): boolean {
  return name.endsWith(".yaml") ||
    name.endsWith(".yml") ||
    name.endsWith(".yaml.template") ||
    name.endsWith(".yml.template");
}

export function registerTemplatesCommand(program: Command): void {
  const cmd = program
    .command("templates")
    .description("Orchestration template management");

  cmd
    .command("list")
    .description("List all templates")
    .option("--all", "Include test and legacy templates")
    .action(async (opts: { all?: boolean }) => {
      const globalOpts = program.opts() as { json?: boolean };
      const items = localTemplateItems(opts.all ?? false);

      if (globalOpts.json) {
        console.log(JSON.stringify(items));
        return;
      }

      if (items.length === 0) {
        console.log("No templates found.");
        return;
      }

      console.log(
        `${"Name".padEnd(30)} ${"Nodes".padEnd(6)} Description`,
      );
      console.log("-".repeat(70));
      for (const t of items) {
        const name = String(t.name ?? "?").padEnd(30);
        const nodes = String(t.node_count ?? 0).padEnd(6);
        const desc = truncate(oneLineDescription(String(t.description ?? "")), 40);
        console.log(`${name} ${nodes} ${desc}`);
      }
    });

  cmd
    .command("show <name>")
    .description("Show template details")
    .action(async (name: string) => {
      const globalOpts = program.opts() as { json?: boolean; baseUrl?: string };
      const dir = orchestrationsDir();
      const filePath = resolveTemplatePath(dir, name);

      if (!fs.existsSync(filePath)) {
        console.error(
          `Error: template '${name}' not found\n  Looked in: ${dir}`,
        );
        process.exitCode = 1;
        return;
      }

      const content = fs.readFileSync(filePath, "utf-8");

      if (globalOpts.json) {
        // Parse YAML-like output — for now just wrap raw content
        console.log(JSON.stringify({ name, content, path: filePath }));
      } else {
        process.stdout.write(content);
        if (!content.endsWith("\n")) console.log();
      }
    });
}

export function resolveTemplatePath(dir: string, name: string): string {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("assets/orchestrations/")) {
    return path.join(dir, normalized.slice("assets/orchestrations/".length));
  }
  if (
    normalized.includes("/") ||
    normalized.endsWith(".yaml") ||
    normalized.endsWith(".yml") ||
    normalized.endsWith(".yaml.template") ||
    normalized.endsWith(".yml.template")
  ) {
    const p = path.resolve(normalized);
    if (fs.existsSync(p)) return p;
    return path.join(dir, normalized);
  }
  const yamlPath = path.join(dir, `${name}.yaml`);
  if (fs.existsSync(yamlPath)) return yamlPath;
  const templatePath = path.join(dir, `${name}.yaml.template`);
  if (fs.existsSync(templatePath)) return templatePath;
  return yamlPath;
}

function localTemplateItems(all: boolean): Array<Record<string, unknown>> {
  const dir = orchestrationsDir();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir);
  const items: Array<Record<string, unknown>> = [];

  for (const entry of entries) {
    if (!isYamlFile(entry)) continue;
    if (entry === "catalog.yaml") continue;

    const filePath = path.join(dir, entry);
    const stem = entry.replace(/\.(yaml|yml)(\.template)?$/, "");

    let name = stem;
    let description = "";
    let nodeCount = 0;

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim();
      const descMatch = content.match(/^description:\s*"?([^"]*)"?$/m);
      if (descMatch) description = descMatch[1].trim();
      nodeCount = countTopLevelNodeEntries(content);
    } catch {
      // Use defaults
    }

    if (!all && (stem.includes("test") || stem.includes("legacy"))) continue;

    items.push({ name, description, path: filePath, node_count: nodeCount, source: "local" });
  }

  items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return items;
}

function countTopLevelNodeEntries(content: string): number {
  const lines = content.split(/\r?\n/);
  let inNodes = false;
  let nodeIndent: number | undefined;
  let count = 0;

  for (const line of lines) {
    if (!inNodes) {
      if (/^nodes:\s*(?:#.*)?$/.test(line)) {
        inNodes = true;
      }
      continue;
    }

    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }

    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent === 0) {
      break;
    }

    const isMappingKey = /^\s+[A-Za-z0-9_-]+:\s*(?:#.*)?$/.test(line);
    if (!isMappingKey) {
      continue;
    }

    if (nodeIndent === undefined) {
      nodeIndent = indent;
    }

    if (indent === nodeIndent) {
      count += 1;
    }
  }

  return count;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function oneLineDescription(s: string): string {
  return s.replace(/^\|\s*/, "").replace(/\s+/g, " ").trim();
}
