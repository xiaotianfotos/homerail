import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { closeDb } from "../src/persistence/db.js";
import {
  dagRunInputPath,
  listDagRunInputs,
  resolveDagRunInputBindings,
  stageDagRunInputArtifact,
} from "../src/persistence/run-input-artifacts.js";
import { loadRunMetadata, loadRunSnapshot } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  createActiveRun,
  recoverAllActiveRuns,
} from "../src/runtime/active-runs.js";

function commandWorkflow() {
  return parseWorkflowSource(`
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: run-input-reader, name: Run input reader }
spec:
  agents: {}
  nodes:
    read:
      kind: command
      outputs: { done: {}, failed: {} }
      config:
        command:
          - node
          - -e
          - "const fs=require('fs');process.stdout.write(JSON.stringify({task:fs.readFileSync(process.argv[1],'utf8')}))"
          - $run_input/task_document
        cwd: $run_workspace
        timeout_ms: 5000
        parse_stdout: json
        result_payload: value
        success_port: done
        failure_port: failed
    done: { kind: terminal, outcome: success, inputs: { result: {} } }
    failed: { kind: terminal, outcome: failure, inputs: { result: {} } }
  edges:
    - { from: read.done, to: done.result }
    - { from: read.failed, to: failed.result, condition: on_failure }
`);
}

describe("immutable DAG run inputs", () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let previousAllowlist: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    previousAllowlist = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-run-inputs-"));
    process.env.HOMERAIL_HOME = tempHome;
    process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = "node";
    closeDb();
    _clearActiveRuns();
  });

  afterEach(() => {
    _clearActiveRuns();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    if (previousAllowlist === undefined) delete process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    else process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = previousAllowlist;
    for (const runId of ["run-input-command", "run-input-recovery"]) {
      const inputRoot = path.join(tempHome, "workspace", runId, "input");
      if (fs.existsSync(inputRoot)) fs.chmodSync(inputRoot, 0o700);
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("stages content idempotently and rejects invalid content or cross-scope binding", () => {
    const first = stageDagRunInputArtifact({
      scope_id: "project-one",
      name: "task.md",
      media_type: "text/markdown",
      content: "# Immutable task\n",
    });
    const repeated = stageDagRunInputArtifact({
      scope_id: "project-one",
      name: "task.md",
      media_type: "text/markdown",
      content: "# Immutable task\n",
    });
    expect(repeated).toEqual(first);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => stageDagRunInputArtifact({
      scope_id: "project-one",
      name: "task.json",
      media_type: "application/json",
      content: "not-json",
    })).toThrow("valid JSON");
    expect(() => resolveDagRunInputBindings("project-two", [{
      artifact_id: first.artifact_id,
      logical_name: "task_document",
      mount_path: "input/task.md",
    }])).toThrow("different scope");
    expect(() => resolveDagRunInputBindings("project-one", [{
      artifact_id: first.artifact_id,
      logical_name: "task_document",
      mount_path: "../task.md",
    }])).toThrow("below input/");
  });

  it("binds provenance atomically, projects it read-only, and resolves it for a trusted command", () => {
    const artifact = stageDagRunInputArtifact({
      scope_id: "project-one",
      name: "task.md",
      media_type: "text/markdown",
      content: "# Durable plan\nAcceptance: exact input\n",
    });
    const bindings = resolveDagRunInputBindings("project-one", [{
      artifact_id: artifact.artifact_id,
      logical_name: "task_document",
      mount_path: "input/task.md",
    }]);
    const executor = new GraphExecutor(new FakeDAGDispatcher());
    createActiveRun("run-input-command", commandWorkflow(), { inputArtifacts: bindings });

    const bound = listDagRunInputs("run-input-command");
    expect(bound).toHaveLength(1);
    expect(loadRunMetadata("run-input-command")?.inputArtifacts).toEqual(bound);
    const projected = dagRunInputPath("run-input-command", "task_document");
    expect(fs.readFileSync(projected, "utf8")).toContain("# Durable plan");
    if (process.platform !== "win32") expect(fs.statSync(projected).mode & 0o222).toBe(0);

    executor.tick("run-input-command");
    expect(loadRunSnapshot("run-input-command")?.handoffs).toContainEqual(expect.objectContaining({
      fromNode: "read",
      port: "done",
      content: { task: "# Durable plan\nAcceptance: exact input\n" },
    }));
  });

  it("refuses cold recovery when content-addressed bytes were modified", () => {
    const artifact = stageDagRunInputArtifact({
      scope_id: "project-one",
      name: "task.md",
      media_type: "text/markdown",
      content: "original",
    });
    const bindings = resolveDagRunInputBindings("project-one", [{
      artifact_id: artifact.artifact_id,
      logical_name: "task_document",
      mount_path: "input/task.md",
    }]);
    createActiveRun("run-input-recovery", commandWorkflow(), { inputArtifacts: bindings });
    const blob = path.join(
      tempHome,
      "manager",
      "run-inputs",
      "blobs",
      artifact.sha256.slice(0, 2),
      artifact.sha256,
      "blob",
    );
    fs.chmodSync(blob, 0o600);
    fs.writeFileSync(blob, "tampered");
    _clearActiveRuns();
    closeDb();

    const recovery = recoverAllActiveRuns();
    expect(recovery.recovered).not.toContain("run-input-recovery");
    expect(recovery.skipped).toContain("run-input-recovery");
  });
});
