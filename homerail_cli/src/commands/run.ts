import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { getClient } from "../index.js";
import type { BaseResponse, HomeRailClient } from "../client.js";
import { parseSettingIdOption } from "../command-options.js";
import { orchestrationsDir, resolveTemplatePath } from "./templates.js";

function collectInputFile(value: string, previous: string[]): string[] {
  return [...previous, value];
}

type RunInputMediaType = "text/markdown" | "text/plain" | "application/json";

function declaredRunInputMediaType(mountPath: string, content: string): RunInputMediaType {
  const extension = path.posix.extname(mountPath).toLowerCase();
  if (extension === ".json") {
    try {
      JSON.parse(content);
    } catch {
      throw new Error(`run input mounted at ${mountPath} must contain valid JSON`);
    }
    return "application/json";
  }
  if (extension === ".md") return "text/markdown";
  if (extension === ".txt") return "text/plain";
  throw new Error(`run input mount path must end in .md, .json, or .txt: ${mountPath}`);
}

export async function stageRunInputFiles(
  client: HomeRailClient,
  scopeId: string | undefined,
  specifications: string[],
): Promise<Array<{ artifact_id: string; logical_name: string; mount_path: string }>> {
  if (specifications.length === 0) return [];
  const scope = scopeId?.trim();
  if (!scope) throw new Error("--input-scope is required with --input-file");
  if (specifications.length > 16) throw new Error("at most 16 --input-file values are allowed");
  const logicalNames = new Set<string>();
  const mountPaths = new Set<string>();
  const bindings = [];
  for (const specification of specifications) {
    const equals = specification.indexOf("=");
    if (equals < 1 || equals === specification.length - 1) {
      throw new Error("--input-file must use logical_name[:input/mount]=local_path");
    }
    const target = specification.slice(0, equals);
    const localPath = path.resolve(specification.slice(equals + 1));
    const colon = target.indexOf(":");
    const logicalName = (colon < 0 ? target : target.slice(0, colon)).trim();
    const mountPath = (colon < 0 ? `input/${path.basename(localPath)}` : target.slice(colon + 1)).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(logicalName)) throw new Error(`invalid input logical name: ${logicalName}`);
    if (!/^input\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(mountPath)) throw new Error(`invalid input mount path: ${mountPath}`);
    if (logicalNames.has(logicalName) || mountPaths.has(mountPath)) throw new Error("input logical names and mount paths must be unique");
    logicalNames.add(logicalName);
    mountPaths.add(mountPath);
    const stat = fs.statSync(localPath);
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw new Error(`input file must contain 1 byte to 1 MiB: ${localPath}`);
    const bytes = fs.readFileSync(localPath);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`input file must contain valid UTF-8 text: ${localPath}`);
    }
    const mediaType = declaredRunInputMediaType(mountPath, content);
    const response = await client.post<BaseResponse>("/api/run-inputs", {
      scope_id: scope,
      name: path.posix.basename(mountPath),
      media_type: mediaType,
      content,
    });
    const data = response.data as { artifact?: { artifact_id?: unknown } } | undefined;
    const artifactId = data?.artifact?.artifact_id;
    if (typeof artifactId !== "string" || !artifactId) throw new Error(`Manager did not return an artifact id for ${localPath}`);
    bindings.push({ artifact_id: artifactId, logical_name: logicalName, mount_path: mountPath });
  }
  return bindings;
}

export function registerRunCommand(program: Command): void {
  program
    .command("run [template]")
    .description("Start a DAG run")
    .requiredOption("--prompt <text>", "Task prompt")
    .option("--project-name <name>", "Project name")
    .option("--workflow <workflow_id>", "Run a DAG workflow synced in the Manager database")
    .option("--sync", "Sync the template to the Manager database before running it")
    .option("--profile <profile>", "Runtime profile id, or a profile YAML file to sync before running")
    .option("--setting-id <id>", "Database LLM setting id for this DAG run", parseSettingIdOption)
    .option("--input-scope <scope>", "Scope for immutable run input artifacts")
    .option(
      "--input-file <binding>",
      "Stage logical_name[:input/mount]=local_path as immutable UTF-8 input (.md, .json, or .txt mount)",
      collectInputFile,
      [],
    )
    .action(
      async (
        template: string | undefined,
        opts: {
          prompt: string;
          projectName?: string;
          workflow?: string;
          sync?: boolean;
          profile?: string;
          settingId?: string;
          inputScope?: string;
          inputFile: string[];
        },
      ) => {
        const globalOpts = program.opts() as {
          json?: boolean;
          baseUrl?: string;
          requestTimeout?: number;
        };
        const client = getClient(globalOpts);

        try {
          const payload: Record<string, unknown> = {
            prompt: opts.prompt,
          };
          let workflowId = opts.workflow?.trim();

          if (opts.sync) {
            if (!template) {
              console.error("Error: --sync requires a DAG template path");
              process.exitCode = 1;
              return;
            }
            const templatePath = resolveTemplatePath(orchestrationsDir(), template);
            if (!fs.existsSync(templatePath)) {
              console.error(`Error: DAG template not found: ${template}`);
              process.exitCode = 1;
              return;
            }
            const syncResp = await client.post<BaseResponse>("/api/dag/workflows/sync", {
              yaml_text: fs.readFileSync(templatePath, "utf8"),
              source_path: templatePath,
            });
            const syncData = syncResp.data as { workflow?: { workflow_id?: string } } | undefined;
            workflowId = syncData?.workflow?.workflow_id;
            if (!workflowId) throw new Error("Manager did not return workflow_id after DAG sync");
            payload.workflow_id = workflowId;
          } else if (workflowId) {
            payload.workflow_id = workflowId;
          } else if (template) {
            payload.yamlPath = template;
          } else {
            console.error("Error: provide a DAG template path or --workflow <workflow_id>");
            process.exitCode = 1;
            return;
          }
          if (opts.projectName) {
            payload.projectName = opts.projectName;
          }
          if (opts.profile) {
            const maybeProfilePath = path.resolve(opts.profile);
            if (fs.existsSync(maybeProfilePath)) {
              if (!workflowId) {
                console.error("Error: profile YAML sync requires --workflow or template --sync");
                process.exitCode = 1;
                return;
              }
              const profileResp = await client.post<BaseResponse>("/api/dag/profiles/sync", {
                yaml_text: fs.readFileSync(maybeProfilePath, "utf8"),
                workflow_id: workflowId,
                source_path: maybeProfilePath,
              });
              const profileData = profileResp.data as { profile?: { profile_id?: string } } | undefined;
              const profileId = profileData?.profile?.profile_id;
              if (!profileId) throw new Error("Manager did not return profile_id after profile sync");
              payload.profile = profileId;
            } else {
              payload.profile = opts.profile;
            }
          }
          if (opts.settingId) {
            payload.llm_setting_id = opts.settingId;
          }
          const inputArtifacts = await stageRunInputFiles(client, opts.inputScope, opts.inputFile);
          if (inputArtifacts.length > 0) {
            payload.input_scope = opts.inputScope!.trim();
            payload.input_artifacts = inputArtifacts;
          }
          const resp = await client.post<BaseResponse>(
            "/api/runs/create-and-run",
            payload,
          );

          if (globalOpts.json) {
            console.log(JSON.stringify(resp));
            return;
          }

          const data = resp.data as Record<string, unknown> | undefined;
          const runId = data?.run_id ?? data?.runId ?? "?";
          console.log(`Run started: ${runId}`);
          if (payload.workflow_id) console.log(`Workflow: ${payload.workflow_id}`);
          if (payload.profile) console.log(`Profile: ${payload.profile}`);
          if (resp.message) console.log(`  ${resp.message}`);
        } catch (err: unknown) {
          console.error(
            `Error: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exitCode = 1;
        }
      },
    );
}
