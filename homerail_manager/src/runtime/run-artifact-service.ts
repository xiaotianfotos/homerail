import type { DAGArtifactDeclaration, DAGHandoffArtifactDeclaration, DAGWorkspaceArtifactDeclaration } from "../orchestration/graph.js";
import { emit, subscribe, type DAGEventPayload } from "../events/bus.js";
import { validateJsonContract } from "../orchestration/json-contract.js";
import { listProvisionedForRun, type ProvisionedWorkerEntry } from "../orchestration/provisioned-cleanup.js";
import { getAllNodes, type NodeState } from "../node/registry.js";
import { sendLifecycleRequest, type LifecycleResult } from "../node/lifecycle-request.js";
import {
  getRunArtifact,
  initializeRunArtifacts,
  listRunArtifacts,
  markRunArtifactFailed,
  markRunArtifactSkipped,
  prepareRunArtifactUpload,
  writeRunArtifactBytes,
  type RunArtifactRecord,
} from "../persistence/run-artifacts.js";
import { loadRunMetadata, loadRunSnapshot } from "../persistence/store.js";
import { getActiveRun } from "./active-runs.js";

type RunOutcome = "success" | "failure";

export interface RunArtifactServiceOptions {
  sendLifecycle?: typeof sendLifecycleRequest;
  listProvisioned?: typeof listProvisionedForRun;
  listNodes?: typeof getAllNodes;
}

function payloadRunId(payload: DAGEventPayload): string | undefined {
  const record = payload as unknown as Record<string, unknown>;
  return typeof record.runId === "string" ? record.runId : undefined;
}

function declarationsForRun(runId: string): DAGArtifactDeclaration[] {
  const active = getActiveRun(runId);
  if (active?.artifacts) return structuredClone(active.artifacts);
  return structuredClone(loadRunMetadata(runId)?.artifacts ?? []);
}

function contractsForRun(runId: string): Record<string, unknown> {
  return getActiveRun(runId)?.contracts ?? loadRunMetadata(runId)?.contracts ?? {};
}

function shouldPublish(declaration: DAGArtifactDeclaration, outcome: RunOutcome): boolean {
  if (declaration.publish === "always") return true;
  if (declaration.publish === "success") return outcome === "success";
  return outcome === "failure";
}

function deepSortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, deepSortJson(entry)]),
  );
}

function jsonArtifactValue(content: unknown, schema: unknown): unknown {
  const direct = validateJsonContract(schema, content);
  if (direct.valid) return content;
  if (typeof content !== "string") {
    throw new Error(`artifact contract validation failed: ${direct.details}`);
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    const validation = validateJsonContract(schema, parsed);
    if (!validation.valid) throw new Error(validation.details);
    return parsed;
  } catch {
    throw new Error(`artifact contract validation failed: ${direct.details}`);
  }
}

function emitRecord(type: "pending" | "ready" | "failed" | "skipped", record: RunArtifactRecord): void {
  emit(`dag:artifact_${type}`, {
    runId: record.run_id,
    artifactId: record.artifact_id,
    name: record.name,
    status: record.status,
    sizeBytes: record.size_bytes,
    sha256: record.sha256,
    error: record.error,
  });
}

function failArtifact(runId: string, name: string, code: string, error: unknown): RunArtifactRecord {
  const record = markRunArtifactFailed(runId, name, {
    code,
    message: error instanceof Error ? error.message : String(error),
  });
  emitRecord("failed", record);
  return record;
}

function materializeHandoffArtifact(
  runId: string,
  declaration: DAGHandoffArtifactDeclaration,
): RunArtifactRecord {
  const snapshot = loadRunSnapshot(runId);
  const handoff = snapshot?.handoffs
    .filter((entry) => entry.fromNode === declaration.source.node && entry.port === declaration.source.port)
    .at(-1);
  if (!handoff) throw new Error(`handoff ${declaration.source.node}.${declaration.source.port} was not produced`);

  let bytes: Buffer;
  if (declaration.media_type === "application/json") {
    const schema = declaration.contract ? contractsForRun(runId)[declaration.contract] : undefined;
    const value = jsonArtifactValue(handoff.content, schema);
    bytes = Buffer.from(`${JSON.stringify(deepSortJson(value), null, 2)}\n`, "utf8");
  } else {
    if (typeof handoff.content !== "string") {
      throw new Error(`${declaration.media_type} handoff content must be a string`);
    }
    bytes = Buffer.from(handoff.content.endsWith("\n") ? handoff.content : `${handoff.content}\n`, "utf8");
  }

  const record = writeRunArtifactBytes(runId, declaration.name, bytes);
  emitRecord("ready", record);
  return record;
}

function selectArtifactNode(
  declaration: DAGWorkspaceArtifactDeclaration,
  provisioned: ProvisionedWorkerEntry[],
  nodes: NodeState[],
): string | undefined {
  const exact = provisioned.find((entry) => entry.nodeId === declaration.source.produced_by);
  if (exact) return exact.dockerNodeId;
  const nodeIds = [...new Set(provisioned.map((entry) => entry.dockerNodeId))];
  if (nodeIds.length === 1) return nodeIds[0];
  const connected = nodes.filter((node) => node.socket.readyState === 1);
  return connected.length === 1 ? connected[0].node_id : undefined;
}

async function materializeWorkspaceArtifact(
  runId: string,
  declaration: DAGWorkspaceArtifactDeclaration,
  provisioned: ProvisionedWorkerEntry[],
  nodes: NodeState[],
  sendLifecycle: typeof sendLifecycleRequest,
): Promise<RunArtifactRecord> {
  const nodeId = selectArtifactNode(declaration, provisioned, nodes);
  if (!nodeId) throw new Error("cannot identify the Node that owns this run workspace");
  const prepared = prepareRunArtifactUpload(runId, declaration.name);
  emitRecord("pending", prepared.record);
  const uploadPath = `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(declaration.name)}/upload`;
  const result: LifecycleResult = await sendLifecycle(
    nodeId,
    "workspace_artifact",
    "archive_upload",
    {
      workspace_id: runId,
      path: declaration.source.path,
      archive: declaration.archive,
      limits: declaration.limits,
      media_type: declaration.media_type,
      upload_url: uploadPath,
      upload_token: prepared.token,
    },
    { timeoutMs: declaration.limits.timeout_ms + 30_000 },
  );
  if (result.status !== "success") {
    const message = typeof result.error?.message === "string" ? result.error.message : `Node returned ${result.status}`;
    throw new Error(message);
  }
  const record = getRunArtifact(runId, declaration.name);
  if (!record || record.status !== "ready") {
    throw new Error("Node completed without a committed artifact upload");
  }
  return record;
}

const inflightFinalizations = new Set<string>();

export async function finalizeRunArtifacts(
  runId: string,
  outcome: RunOutcome,
  options: RunArtifactServiceOptions = {},
): Promise<RunArtifactRecord[]> {
  if (inflightFinalizations.has(runId)) return listRunArtifacts(runId);
  inflightFinalizations.add(runId);
  try {
    const declarations = declarationsForRun(runId);
    if (declarations.length === 0) return [];
    initializeRunArtifacts(runId, declarations);

    // Capture ownership before run cleanup removes the in-memory provisioning registry.
    const provisioned = (options.listProvisioned ?? listProvisionedForRun)(runId);
    const nodes = (options.listNodes ?? getAllNodes)();
    const sendLifecycle = options.sendLifecycle ?? sendLifecycleRequest;

    for (const declaration of declarations) {
      const existing = getRunArtifact(runId, declaration.name);
      if (existing?.status === "ready" || existing?.status === "skipped") continue;
      if (!shouldPublish(declaration, outcome)) {
        const skipped = markRunArtifactSkipped(
          runId,
          declaration.name,
          `publish policy '${declaration.publish}' does not apply to a ${outcome} run`,
        );
        emitRecord("skipped", skipped);
        continue;
      }
      try {
        if (!("archive" in declaration)) {
          materializeHandoffArtifact(runId, declaration);
        } else {
          const ready = await materializeWorkspaceArtifact(runId, declaration, provisioned, nodes, sendLifecycle);
          emitRecord("ready", ready);
        }
      } catch (error) {
        const current = getRunArtifact(runId, declaration.name);
        if (current?.status !== "ready") {
          failArtifact(
            runId,
            declaration.name,
            "ARTIFACT_MATERIALIZATION_FAILED",
            error,
          );
        }
      }
    }
    return listRunArtifacts(runId);
  } finally {
    inflightFinalizations.delete(runId);
  }
}

export function startRunArtifactService(options: RunArtifactServiceOptions = {}): () => void {
  const unsubscribers: Array<() => void> = [];
  const initialize = (payload: DAGEventPayload) => {
    const runId = payloadRunId(payload);
    if (!runId) return;
    const declarations = declarationsForRun(runId);
    if (declarations.length > 0) initializeRunArtifacts(runId, declarations);
  };
  unsubscribers.push(subscribe("dag:run_created", initialize));
  unsubscribers.push(subscribe("dag:run_recovered", initialize));
  unsubscribers.push(subscribe("dag:run_completed", (payload) => {
    const runId = payloadRunId(payload);
    if (runId) void finalizeRunArtifacts(runId, "success", options);
  }));
  for (const eventType of ["dag:run_failed", "dag:run_cancelled"] as const) {
    unsubscribers.push(subscribe(eventType, (payload) => {
      const runId = payloadRunId(payload);
      if (runId) void finalizeRunArtifacts(runId, "failure", options);
    }));
  }
  return () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  };
}
