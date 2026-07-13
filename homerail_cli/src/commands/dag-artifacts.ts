import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { HomeRailClient } from "../client.js";

export interface RunArtifact {
  artifact_id: string;
  run_id: string;
  name: string;
  status: "pending" | "uploading" | "ready" | "failed" | "skipped";
  media_type: string;
  required: boolean;
  publish: "success" | "failure" | "always";
  source: {
    type: "handoff" | "workspace";
    node?: string;
    port?: string;
    path?: string;
    produced_by?: string;
  };
  size_bytes?: number;
  sha256?: string;
  error?: { code: string; message: string };
}

interface ArtifactListResponse {
  data?: {
    run_id: string;
    artifacts: RunArtifact[];
    total: number;
  };
}

function sourceLabel(artifact: RunArtifact): string {
  if (artifact.source.type === "handoff") return `${artifact.source.node}.${artifact.source.port}`;
  return `${artifact.source.path} (${artifact.source.produced_by})`;
}

function sizeLabel(size: number | undefined): string {
  if (size === undefined) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

async function listArtifacts(client: HomeRailClient, runId: string): Promise<RunArtifact[]> {
  const response = await client.get<ArtifactListResponse>(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
  if (!response.data?.artifacts) throw new Error("Manager returned no artifact list");
  return response.data.artifacts;
}

export async function cmdDagArtifacts(client: HomeRailClient, runId: string, json: boolean): Promise<number> {
  try {
    const artifacts = await listArtifacts(client, runId);
    if (json) {
      console.log(JSON.stringify(artifacts));
      return 0;
    }
    if (artifacts.length === 0) {
      console.log(`Run ${runId} declares no artifacts.`);
      return 0;
    }
    console.log("STATUS     REQUIRED  SIZE       NAME  SOURCE");
    for (const artifact of artifacts) {
      console.log(
        `${artifact.status.padEnd(10)} ${String(artifact.required).padEnd(9)} ${sizeLabel(artifact.size_bytes).padEnd(10)} ${artifact.name}  ${sourceLabel(artifact)}`,
      );
      if (artifact.error) console.log(`  ${artifact.error.code}: ${artifact.error.message}`);
    }
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function errorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Fall back to the HTTP status.
  }
  return `HTTP ${status}`;
}

async function writeFileToStdout(filePath: string): Promise<void> {
  for await (const raw of fs.createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
  }
}

export interface DagArtifactDownloadOptions {
  output?: string;
  force?: boolean;
}

export async function cmdDagArtifact(
  client: HomeRailClient,
  runId: string,
  name: string,
  options: DagArtifactDownloadOptions,
  json: boolean,
): Promise<number> {
  let stagingDir: string | undefined;
  let temporaryPath: string | undefined;
  try {
    const artifacts = await listArtifacts(client, runId);
    const artifact = artifacts.find((candidate) => candidate.name === name);
    if (!artifact) throw new Error(`Artifact '${name}' is not declared by run ${runId}`);
    if (artifact.status !== "ready") {
      const detail = artifact.error ? `: ${artifact.error.message}` : "";
      throw new Error(`Artifact '${name}' is ${artifact.status}${detail}`);
    }
    const textual = artifact.media_type === "application/json" || artifact.media_type.startsWith("text/");
    if (!options.output && !textual) {
      throw new Error(`Artifact '${name}' is binary (${artifact.media_type}); use --output <path>`);
    }
    if (!artifact.sha256) throw new Error(`Artifact '${name}' has no SHA-256 metadata`);

    const destination = options.output ? path.resolve(options.output) : undefined;
    if (destination && fs.existsSync(destination) && !options.force) {
      throw new Error(`Output already exists: ${destination} (use --force to replace it)`);
    }
    if (destination) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      temporaryPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${Date.now()}.part`);
    } else {
      stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-artifact-"));
      temporaryPath = path.join(stagingDir, "artifact.part");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), client.timeoutMs);
    let response: Response;
    try {
      response = await fetch(
        `${client.baseUrl}/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}/content`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(errorMessage(response.status, await response.text()));
      if (!response.body) throw new Error("Manager returned an empty artifact response body");
      const hash = createHash("sha256");
      let size = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
        counter,
        fs.createWriteStream(temporaryPath, { mode: 0o600 }),
      );
      const actualSha = hash.digest("hex");
      if (actualSha !== artifact.sha256) throw new Error(`SHA-256 mismatch for artifact '${name}'`);
      if (artifact.size_bytes !== undefined && size !== artifact.size_bytes) {
        throw new Error(`Size mismatch for artifact '${name}': expected ${artifact.size_bytes}, received ${size}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Artifact download timed out after ${client.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (destination) {
      try {
        fs.renameSync(temporaryPath, destination);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (!options.force || !["EEXIST", "ENOTEMPTY", "EPERM"].includes(code)) throw error;
        // Some platforms do not replace an existing destination with rename.
        fs.rmSync(destination, { force: true });
        fs.renameSync(temporaryPath, destination);
      }
      temporaryPath = undefined;
      if (json) {
        console.log(JSON.stringify({ run_id: runId, name, output: destination, sha256: artifact.sha256 }));
      } else {
        console.log(`Downloaded ${name} -> ${destination} (${artifact.sha256})`);
      }
    } else {
      await writeFileToStdout(temporaryPath);
    }
    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (temporaryPath) fs.rmSync(temporaryPath, { force: true });
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
