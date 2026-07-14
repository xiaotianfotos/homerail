import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import type { ParsedDAG } from "../src/orchestration/graph.js";
import { assertRuntimeGraphParity } from "../src/orchestration/runtime-graph-parity.js";
import {
  canonicalWorkflowToV1Document,
  compileWorkflowSource,
  projectCanonicalWorkflowToParsedDAG,
} from "../src/orchestration/workflow-spec-v1.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { _clearListeners } from "../src/events/bus.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  createActiveRun,
  dispatchReadyNodes,
  getActiveRun,
  handoffActiveRun,
} from "../src/runtime/active-runs.js";

const PUBLIC_LEGACY_ASSETS = [
  "local-harness-cli-deploy-diagnosis.yaml.template",
  "pattern-quorum-offline.yaml",
  "pattern-ratchet-exhaustion-offline.yaml",
  "public-dev-5node.yaml.template",
  "public-two-node.yaml.template",
] as const;

function convertLegacySource(source: string): { legacy: ParsedDAG; v1: ParsedDAG } {
  const legacy = parseDAGYaml(source);
  const legacyCompilation = compileWorkflowSource(source);
  expect(legacyCompilation.valid, legacyCompilation.diagnostics.map((entry) => entry.message).join("\n")).toBe(true);
  expect(legacyCompilation.canonical).toBeDefined();

  const v1Source = YAML.stringify(canonicalWorkflowToV1Document(legacyCompilation.canonical!));
  const v1Compilation = compileWorkflowSource(v1Source);
  expect(v1Compilation.valid, v1Compilation.diagnostics.map((entry) => entry.message).join("\n")).toBe(true);
  expect(v1Compilation.source_api_version).toBe("homerail.ai/v1");
  expect(v1Compilation.canonical).toBeDefined();
  return {
    legacy,
    v1: projectCanonicalWorkflowToParsedDAG(v1Compilation.canonical!),
  };
}

function loadLegacyAndV1(file: string): { legacy: ParsedDAG; v1: ParsedDAG } {
  const source = fs.readFileSync(path.resolve("..", "assets", "orchestrations", file), "utf8");
  return convertLegacySource(source);
}

function nodeStates(runId: string): Record<string, string> {
  return Object.fromEntries(getActiveRun(runId)?.dagRun.nodeStates ?? []);
}

describe("WorkflowSpec v1 legacy runtime parity", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workflow-parity-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it.each(PUBLIC_LEGACY_ASSETS)("preserves the public asset runtime graph: %s", (file) => {
    const { legacy, v1 } = loadLegacyAndV1(file);

    expect(() => assertRuntimeGraphParity(file, legacy, v1)).not.toThrow();
  });

  it("recognizes legacy await_command gateways and preserves their runtime config", () => {
    const source = `
name: legacy-await-command
agents:
  worker: { system: Work. }
nodes:
  actor:
    agent: worker
    outputs:
      summary: { to: suspend.in:summary }
  suspend:
    type: gateway
    after: [actor]
    gateway_config:
      kind: await_command
      primitive_version: 1
      target_actors: [actor]
      expires_after_ms: 60000
      command_port: next_command
  finisher:
    agent: worker
    outputs:
      done: { to: "" }
`;
    const compilation = compileWorkflowSource(source);
    expect(compilation.valid, compilation.diagnostics.map((entry) => entry.message).join("\n")).toBe(true);
    expect(compilation.canonical?.nodes.find((node) => node.id === "suspend")).toMatchObject({
      kind: "await_command",
      config: {
        primitive_version: 1,
        target_actors: ["actor"],
        expires_after_ms: 60_000,
        command_port: "next_command",
      },
    });

    const authoring = canonicalWorkflowToV1Document(compilation.canonical!);
    expect((authoring.spec as any).nodes.suspend.config).toEqual({
      command_port: "next_command",
      expires_after_ms: 60_000,
      primitive_version: 1,
      target_actors: ["actor"],
    });
    const { legacy, v1 } = convertLegacySource(source);
    expect(() => assertRuntimeGraphParity("legacy-await-command", legacy, v1)).not.toThrow();
  });

  it("preserves quorum branch selection and skipped descendants", () => {
    const { legacy, v1 } = loadLegacyAndV1("pattern-quorum-offline.yaml");
    createActiveRun("quorum-legacy", legacy);
    createActiveRun("quorum-v1", v1);

    for (const runId of ["quorum-legacy", "quorum-v1"]) {
      handoffActiveRun(runId, "collect_signal", "collected", "normalized-signal");
      handoffActiveRun(runId, "voter_one", "vote", "act");
      handoffActiveRun(runId, "voter_two", "vote", "act");
      handoffActiveRun(runId, "voter_three", "vote", "stop");
      expect(dispatchReadyNodes(runId, new FakeDAGDispatcher())).toBe(1);
    }

    expect(nodeStates("quorum-v1")).toEqual(nodeStates("quorum-legacy"));
    expect(nodeStates("quorum-v1")).toMatchObject({
      quorum: "COMPLETED",
      conduct: "READY",
      stopped: "SKIPPED",
    });
    expect(getActiveRun("quorum-v1")?.dagRun.mailboxes.get("conduct"))
      .toEqual(getActiveRun("quorum-legacy")?.dagRun.mailboxes.get("conduct"));
  });

  it("preserves whole-payload condition routing when field is omitted", () => {
    const source = `
name: whole-payload-condition
agents:
  worker: { system: Work. }
nodes:
  start:
    agent: worker
    outputs:
      decision: { to: gate.in:decision }
  gate:
    type: condition_gateway
    gateway_config:
      routes: { approve: approved, reject: rejected }
      default_port: rejected
    after: [start]
    outputs:
      approved: { to: good.in:task }
      rejected: { to: bad.in:task }
  good:
    agent: worker
    after: [gate]
    outputs:
      done: { to: "" }
  bad:
    agent: worker
    after: [gate]
    outputs:
      done: { to: "" }
`;
    const { legacy, v1 } = convertLegacySource(source);
    createActiveRun("condition-legacy", legacy);
    createActiveRun("condition-v1", v1);

    for (const runId of ["condition-legacy", "condition-v1"]) {
      handoffActiveRun(runId, "start", "decision", "approve");
      expect(dispatchReadyNodes(runId, new FakeDAGDispatcher())).toBe(1);
    }

    expect(nodeStates("condition-v1")).toEqual(nodeStates("condition-legacy"));
    expect(nodeStates("condition-v1")).toMatchObject({
      gate: "COMPLETED",
      good: "READY",
      bad: "SKIPPED",
    });
  });

  it("preserves ratchet feedback bounds and exhaustion routing", () => {
    const { legacy, v1 } = loadLegacyAndV1("pattern-ratchet-exhaustion-offline.yaml");
    createActiveRun("ratchet-legacy", legacy);
    createActiveRun("ratchet-v1", v1);

    for (const runId of ["ratchet-legacy", "ratchet-v1"]) {
      handoffActiveRun(runId, "baseline", "measured", "not-done");
      expect(dispatchReadyNodes(runId, new FakeDAGDispatcher())).toBe(1);
      handoffActiveRun(runId, "improve", "measured", "not-done");
      expect(dispatchReadyNodes(runId, new FakeDAGDispatcher())).toBe(1);
      handoffActiveRun(runId, "improve", "measured", "not-done");
      expect(dispatchReadyNodes(runId, new FakeDAGDispatcher())).toBe(1);
    }

    expect(nodeStates("ratchet-v1")).toEqual(nodeStates("ratchet-legacy"));
    expect(nodeStates("ratchet-v1")).toMatchObject({
      target_gate: "COMPLETED",
      achieved: "SKIPPED",
      stopped: "READY",
    });
    expect(getActiveRun("ratchet-v1")?.counters.gateway_iterations)
      .toEqual(getActiveRun("ratchet-legacy")?.counters.gateway_iterations);
    expect(getActiveRun("ratchet-v1")?.dagRun.mailboxes.get("stopped"))
      .toEqual(getActiveRun("ratchet-legacy")?.dagRun.mailboxes.get("stopped"));
  });
});
