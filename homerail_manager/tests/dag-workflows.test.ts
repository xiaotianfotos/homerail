import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChangeOrchestrator } from "../src/orchestration/change-orchestrator.js";
import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import {
  _clearDagWorkflowTablesForTest,
  upsertDagRuntimeProfileFromYaml,
  upsertDagWorkflowFromYaml,
} from "../src/persistence/dag-workflows.js";
import { closeDb } from "../src/persistence/db.js";
import { loadRunMetadata } from "../src/persistence/store.js";
import {
  _clearAllSettings,
  createSetting,
  upsertProvider,
} from "../src/persistence/llm-settings.js";
import { _clearActiveRuns } from "../src/runtime/active-runs.js";

const WORKFLOW_YAML = `
name: db-workflow
workflow_id: db-workflow
description: DB backed workflow
agents:
  planner:
    system: Plan and hand off.
nodes:
  plan:
    agent: planner
    after: []
    outputs:
      done:
        to: ""
`;

describe("DAG workflow persistence", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-workflows-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    _clearActiveRuns();
    _clearDagWorkflowTablesForTest();
    _clearAllSettings();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearDagWorkflowTablesForTest();
    _clearAllSettings();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("runs a synced DB workflow with a DB runtime profile", () => {
    upsertProvider({
      id: "local-qwen",
      name: "Local Qwen",
      default_model: "qwen3.6",
      base_url: "http://127.0.0.1:5000/v1",
      anthropic_base_url: "http://127.0.0.1:5000/anthropic",
    });
    const setting = createSetting({
      provider_id: "local-qwen",
      endpoint_id: "local-qwen_custom",
      endpoint_name: "custom",
      model_name: "qwen3.6",
      display_name: "local-qwen-alias",
      api_key: "local-no-key",
      protocol: "custom",
      plan_type: "custom",
      base_url: "http://127.0.0.1:5000/v1",
      anthropic_base_url: "http://127.0.0.1:5000/anthropic",
      supports_llm: true,
      is_active: true,
      is_default: true,
    });
    const synced = upsertDagWorkflowFromYaml({ yaml_text: WORKFLOW_YAML, source_path: "assets/orchestrations/db-workflow.yaml" });
    upsertDagRuntimeProfileFromYaml({
      yaml_text: `
profile_id: qwen-main
workflow_id: db-workflow
default:
  model_alias: local-qwen-alias
  agent_type: claude-sdk
`,
    });

    const dispatcher = new FakeDAGDispatcher();
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(dispatcher));
    const result = orchestrator.createAndRun({
      workflowId: "db-workflow",
      profile: "qwen-main",
      prompt: "plan",
    });

    expect(result.workflowId).toBe("db-workflow");
    expect(result).toMatchObject({
      workflowRevision: 1,
      canonicalHash: synced.workflow.canonical_hash,
      compilerVersion: "4",
      sourceApiVersion: "legacy/v0",
    });
    expect(loadRunMetadata(result.runId)).toMatchObject({
      workflowId: "db-workflow",
      workflowRevision: 1,
      canonicalHash: synced.workflow.canonical_hash,
      compilerVersion: "4",
      sourceApiVersion: "legacy/v0",
    });

    const updated = upsertDagWorkflowFromYaml({
      yaml_text: WORKFLOW_YAML.replace("Plan and hand off.", "Plan, verify, and hand off."),
    });
    expect(updated.workflow.head_revision).toBe(2);
    expect(loadRunMetadata(result.runId)).toMatchObject({
      workflowRevision: 1,
      canonicalHash: synced.workflow.canonical_hash,
    });
    expect(dispatcher.dispatched).toHaveLength(1);
    expect(dispatcher.dispatched[0].agentConfig.llm_setting_id).toBe(setting.id);
    expect(dispatcher.dispatched[0].agentConfig).toMatchObject({
      agent_type: "claude-sdk",
      llm: {
        provider: "local-qwen",
        model: "qwen3.6",
        base_url: "http://127.0.0.1:5000/anthropic",
        protocol: "anthropic_compatible",
      },
    });
  });

  it("rejects provider/model fields in profile YAML", () => {
    upsertDagWorkflowFromYaml({ yaml_text: WORKFLOW_YAML });

    expect(() => upsertDagRuntimeProfileFromYaml({
      yaml_text: `
profile_id: old-style
workflow_id: db-workflow
default:
  provider: local-qwen
  model: qwen3.6
`,
    })).toThrow(/must reference DB model_alias or llm_setting_id/);
  });
});
