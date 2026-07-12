import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeHomerailPluginTool } from "homerail-protocol";
import { GenerativeUiKindRegistry } from "../src/generative-ui/kind-registry.js";
import type { LegacyVoiceWidget } from "../src/generative-ui/legacy-widget-compiler.js";
import { GenerativeUiShadowService } from "../src/generative-ui/shadow-service.js";
import { closeDb } from "../src/persistence/db.js";
import { setPluginEnabled } from "../src/persistence/plugins.js";
import { assemblePluginTurnContext } from "../src/plugins/context-assembler.js";
import { acceptPluginToolExecution } from "../src/plugins/execution-broker.js";
import { syncBuiltinPlugins } from "../src/plugins/registry.js";

describe("plugin Tool execution broker", () => {
  let previousHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-plugin-execution-"));
    process.env.HOMERAIL_HOME = tmpHome;
    syncBuiltinPlugins();
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("replays a trusted envelope into one semantic node and preserves readable disabled history", () => {
    const context = assemblePluginTurnContext(undefined, { modality: "voice" });
    const descriptor = context.tools.find((tool) => tool.plugin_id === "com.homerail.topic-outline")!;
    const envelope = executeHomerailPluginTool(descriptor, {
      id: "com.homerail.topic-outline:topic-broker",
      title: "Generative UI plugins",
      brief: "Build one repeatable path from Skill to Renderer.",
      thesis: "The semantic DSL is the stable ABI.",
      outline: [{
        title: "Manifest and Context",
        status: "ready",
        points: ["Resolve immutable assets", "Project only enabled capabilities"],
      }],
      questions: ["How should historical nodes render?"],
      sources: [{ title: "Architecture baseline", url: "https://example.com/architecture", note: "Local WIP design" }],
      next_action: "Validate disable and re-enable",
    });
    const accepted = acceptPluginToolExecution(envelope, context);
    expect(accepted.node).toMatchObject({
      kind: "com.homerail.topic-outline/outline",
      owner: { id: "com.homerail.topic-outline", version: "1.0.0" },
      content: { title: "Generative UI plugins" },
      fallback: {
        items: expect.arrayContaining([
          "Thesis: The semantic DSL is the stable ABI.",
          "Next: Validate disable and re-enable",
          "Section: Manifest and Context: Resolve immutable assets; Project only enabled capabilities",
          "Question: How should historical nodes render?",
          "Source: Architecture baseline: Local WIP design",
        ]),
      },
    });

    const registry = new GenerativeUiKindRegistry();
    const shadow = new GenerativeUiShadowService(
      8,
      undefined,
      undefined,
      undefined,
      registry.validateHistoricalNode,
    );
    const snapshot = shadow.reconcile({
      sessionId: "voice-plugin-broker",
      widgets: [envelope.projection.legacy_widget as LegacyVoiceWidget],
      nodes: [accepted.node],
      checkedAt: "2026-07-11T12:00:00.000Z",
    });
    expect(snapshot).toMatchObject({ status: "ok", matched: true, transaction_status: "applied" });
    expect(shadow.getDocument("voice-plugin-broker")?.nodes[0]).toMatchObject({
      id: "com.homerail.topic-outline:topic-broker",
      kind: "com.homerail.topic-outline/outline",
      content: { title: "Generative UI plugins" },
    });

    setPluginEnabled("com.homerail.topic-outline", false);
    expect(() => acceptPluginToolExecution(envelope, context)).toThrow(/not enabled unchanged/);
    const disabledRegistry = new GenerativeUiKindRegistry();
    expect(disabledRegistry.validateHistoricalNode(shadow.getDocument("voice-plugin-broker")!.nodes[0])).toEqual([]);
    expect(disabledRegistry.uiProjection().renderers).toContainEqual(expect.objectContaining({
      renderer_id: "topic-outline-main",
      enabled: false,
    }));
  });

  it("accepts an evidence-grounded PR closeout projection without a legacy widget bridge", () => {
    const context = assemblePluginTurnContext(undefined, { modality: "text" });
    const descriptor = context.tools.find((tool) => tool.plugin_id === "com.homerail.pr-closeout")!;
    const envelope = executeHomerailPluginTool(descriptor, {
      id: "com.homerail.pr-closeout:xiaotianfotos-homerail-21",
      title: "PR #21 closeout",
      repository: "xiaotianfotos/homerail",
      pr_number: 21,
      status: "draft",
      recommendation: "blocked",
      risk: "medium",
      summary: "Windows Electron validation remains required.",
      checks: [{ id: "manager", label: "Manager tests", status: "passed", detail: "316 passed" }],
      flow: [
        { id: "tests", label: "Tests", status: "passed", progress: 100, depends_on: [] },
        { id: "windows", label: "Windows", status: "blocked", progress: 0, depends_on: ["tests"] },
      ],
      blockers: [{ id: "windows", title: "Windows evidence missing", severity: "blocking" }],
      platforms: [{ id: "windows", label: "Windows", status: "pending" }],
      evidence: [{ id: "manager", label: "Manager suite", status: "verified", detail: "316 passed" }],
    });
    expect(envelope.projection.legacy_widget).toBeUndefined();
    const accepted = acceptPluginToolExecution(envelope, context);
    expect(accepted.node).toMatchObject({
      id: "com.homerail.pr-closeout:xiaotianfotos-homerail-21",
      kind: "com.homerail.pr-closeout/report",
      owner: { id: "com.homerail.pr-closeout", version: "1.0.0" },
      content: {
        recommendation: "blocked",
        blockers: [{ id: "windows", severity: "blocking" }],
      },
      fallback: {
        title: "PR #21 closeout",
        summary: "Windows Electron validation remains required.",
        items: expect.arrayContaining([
          "Blocker: Windows evidence missing",
          "Check: Manager tests: 316 passed",
          "Platform: Windows",
          "Evidence: Manager suite: 316 passed",
        ]),
      },
    });
  });

  it("rejects a projection that no longer matches its validated Tool arguments", () => {
    const context = assemblePluginTurnContext(undefined, { modality: "voice" });
    const descriptor = context.tools.find((tool) => tool.plugin_id === "com.homerail.topic-outline")!;
    expect(() => executeHomerailPluginTool(descriptor, {
      id: "com.homerail.topic-outline:topic-blank-title",
      title: "   ",
    })).toThrow(/input is invalid|fallback title did not resolve/i);
    expect(() => executeHomerailPluginTool(descriptor, {
      id: "com.homerail.topic-outline:topic-source-without-url",
      title: "Source policy",
      sources: [{ title: "Missing URL" }],
    })).toThrow(/input is invalid/);
    const envelope = executeHomerailPluginTool(descriptor, {
      id: "com.homerail.topic-outline:topic-tampered",
      title: "Original title",
    });
    const tampered = structuredClone(envelope);
    tampered.projection.node.content.title = "Tampered title";
    expect(() => acceptPluginToolExecution(tampered, context)).toThrow(/deterministic replay/);

    const tamperedArguments = structuredClone(envelope);
    tamperedArguments.arguments.title = "Different arguments";
    expect(() => acceptPluginToolExecution(tamperedArguments, context)).toThrow(/deterministic replay/);

    const tamperedLegacyWidget = structuredClone(envelope);
    tamperedLegacyWidget.projection.legacy_widget!.title = "Tampered legacy bridge";
    expect(() => acceptPluginToolExecution(tamperedLegacyWidget, context)).toThrow(/deterministic replay/);

    const tamperedDigest = structuredClone(envelope);
    tamperedDigest.tool.handler_digest = "f".repeat(64);
    expect(() => acceptPluginToolExecution(tamperedDigest, context)).toThrow(/not available in this turn/);

    const legacyContext = assemblePluginTurnContext(undefined, {
      modality: "voice",
      legacy_compatibility_mode: true,
    });
    expect(() => acceptPluginToolExecution(envelope, legacyContext)).toThrow(/not available in this turn/);

    const tamperedContext = structuredClone(context);
    tamperedContext.tools[0].description = "tampered";
    expect(() => acceptPluginToolExecution(envelope, tamperedContext)).toThrow(/digest verification/);
  });
});
