import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _clearDagWorkflowTablesForTest,
  getDagWorkflow,
  getDagWorkflowRevision,
  listDagWorkflowRevisions,
  upsertDagWorkflowFromYaml,
} from "../src/persistence/dag-workflows.js";
import { closeDb, encodeJson, getDb } from "../src/persistence/db.js";

const LEGACY_SOURCE = `
name: Revision Test
workflow_id: revision-test
agents:
  worker:
    system: Work.
nodes:
  execute:
    agent: worker
    outputs:
      done:
        to: ""
`;

describe("DAG workflow revisions", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workflow-revisions-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    _clearDagWorkflowTablesForTest();
  });

  afterEach(() => {
    _clearDagWorkflowTablesForTest();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("creates revisions only when canonical semantics change", () => {
    const first = upsertDagWorkflowFromYaml({ yaml_text: LEGACY_SOURCE });
    expect(first.workflow.head_revision).toBe(1);
    expect(first.revision_created).toBe(true);

    const formattingOnly = upsertDagWorkflowFromYaml({ yaml_text: `\n\n${LEGACY_SOURCE.trim()}\n\n` });
    expect(formattingOnly.workflow.head_revision).toBe(1);
    expect(formattingOnly.revision_created).toBe(false);
    expect(formattingOnly.workflow.yaml_hash).not.toBe(first.workflow.yaml_hash);
    expect(listDagWorkflowRevisions("revision-test")).toHaveLength(1);

    const semantic = upsertDagWorkflowFromYaml({
      yaml_text: LEGACY_SOURCE.replace("Work.", "Work and return evidence."),
    });
    expect(semantic.workflow.head_revision).toBe(2);
    expect(semantic.revision_created).toBe(true);
    const revisions = listDagWorkflowRevisions("revision-test");
    expect(revisions.map((revision) => revision.revision)).toEqual([2, 1]);
    expect(revisions[0].canonical_hash).not.toBe(revisions[1].canonical_hash);
    expect(getDagWorkflowRevision("revision-test", 1)?.source_text).toBe(LEGACY_SOURCE);
  });

  it("migrates an existing mutable workflow row to legacy revision 1", () => {
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO dag_workflows(
        workflow_id, name, description, source_path, yaml_text, yaml_hash,
        node_ids, agent_ids, created_at, updated_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "revision-test",
      "Revision Test",
      null,
      null,
      LEGACY_SOURCE,
      "legacy-source-hash",
      encodeJson(["execute"]),
      encodeJson(["worker"]),
      now,
      now,
      encodeJson({ workflow_id: "revision-test", name: "Revision Test" }),
    );

    const workflow = getDagWorkflow("revision-test");
    expect(workflow).toMatchObject({
      head_revision: 1,
      api_version: "legacy/v0",
      compiler_version: "1",
    });
    expect(workflow?.canonical_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(listDagWorkflowRevisions("revision-test")).toEqual([
      expect.objectContaining({
        workflow_id: "revision-test",
        revision: 1,
        api_version: "legacy/v0",
        source_hash: "legacy-source-hash",
      }),
    ]);
  });

  it("persists strict v1 source and canonical provenance", () => {
    const source = `
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: v1-revision, name: V1 Revision }
spec:
  contracts:
    Data: { type: object }
  agents:
    worker: { system: Work. }
  nodes:
    execute:
      kind: agent
      agent: worker
      inputs: { task: { contract: Data } }
      outputs: { result: { contract: Data } }
    done:
      kind: terminal
      outcome: success
      inputs: { result: { contract: Data } }
  edges:
    - { from: $run.input, to: execute.task }
    - { from: execute.result, to: done.result }
`;
    const result = upsertDagWorkflowFromYaml({ yaml_text: source });
    expect(result.parsed).toBeUndefined();
    expect(result.workflow).toMatchObject({
      workflow_id: "v1-revision",
      head_revision: 1,
      api_version: "homerail.ai/v1",
      compiler_version: "1",
      node_ids: ["execute"],
      agent_ids: ["worker"],
    });
    expect(getDagWorkflowRevision("v1-revision", 1)).toMatchObject({
      api_version: "homerail.ai/v1",
      source_format: "yaml",
      canonical_hash: result.workflow.canonical_hash,
    });
  });
});
