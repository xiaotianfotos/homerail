import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  createDagWorkerSkillContextV1,
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_VERSION,
  type DagActorCheckpointV1,
  type DagNodeConfig,
} from "homerail-protocol";

import { registerAgentBackend } from "../agent/factory.js";
import type { AgentClient, AgentRunContext } from "../agent/types.js";
import { runPrompt } from "../prompt-runner.js";
import {
  createWorkerSkillVisualDataContractRegistry,
  createWorkerSkillVisualViewRegistry,
  prepareWorkerSkillContext,
  WorkerSkillContextError,
} from "../worker-skill-context.js";

const SKILL_BODY = "# Review\nPINNED_WORKER_SKILL_BODY";

function skillContext() {
  return createDagWorkerSkillContextV1([{
    id: "review",
    source: "repo",
    content: SKILL_BODY,
  }]);
}

function visualSkillContext() {
  return createDagWorkerSkillContextV1([{
    id: "review",
    source: "repo",
    content: SKILL_BODY,
    visual_profile: {
      profile_version: 1,
      views: [{
        id: "summary",
        a2ui: {
          version: HOMERAIL_A2UI_VERSION,
          catalogId: HOMERAIL_A2UI_CATALOG_ID,
          components: [{ id: "root", component: "Text", text: { path: "/actor_view/data/title" } }],
        },
        data_contract: {
          source: { input_port: "mission", encoding: "json", pointer: "/summary" },
          fields: [{ field: "title", mode: "source", source_pointer: "/title" }],
        },
      }],
      data_fields: ["title"],
      mobile_fallback: "summary",
    },
  }]);
}

function multiVisualSkillContext() {
  return createDagWorkerSkillContextV1([{
    id: "review",
    source: "repo",
    content: SKILL_BODY,
    visual_profile: {
      profile_version: 1,
      views: ["summary", "detail"].map((id) => ({
        id,
        a2ui: {
          version: HOMERAIL_A2UI_VERSION,
          catalogId: HOMERAIL_A2UI_CATALOG_ID,
          components: [{ id: "root", component: "Text", text: { path: "/actor_view/data/title" } }],
        },
        data_contract: {
          source: { input_port: "mission", encoding: "json" as const, pointer: `/${id}` },
          fields: [{ field: "title", mode: "source" as const, source_pointer: "/title" }],
        },
      })),
    },
  }]);
}

function checkpoint(
  context = skillContext(),
): DagActorCheckpointV1 {
  return {
    schema_version: 1,
    objective: "Review the result",
    confirmed_conclusions: [],
    unresolved_items: [],
    key_event_refs: [],
    artifact_refs: [],
    surface_binding: "actor:reviewer",
    context_summary: "{}",
    skill_context: {
      context_digest: context.context_digest,
      skills: context.skills.map((skill) => ({ id: skill.id, digest: skill.digest })),
    },
    round_id: "round-0001",
    actor_generation: 1,
    captured_at: 1,
  };
}

function dagConfig(): DagNodeConfig {
  return {
    node_id: "reviewer",
    agent_type: "claude-sdk",
    model: "test",
    outgoing_edges: [{ from_port: "done", to_node: "", to_port: "" }],
    incoming_edges: [],
    graph_nodes: ["reviewer"],
    session_id: "worker-skill-session",
    allowed_dag_tools: ["handoff"],
  };
}

describe("Worker Skill Context", () => {
  it("revalidates item and aggregate digests and fails closed when missing", () => {
    const context = skillContext();
    expect(() => prepareWorkerSkillContext({
      declaredSkills: ["review"],
    })).toThrow(/missing their pinned Skill Context/);

    const contentTamper = structuredClone(context);
    contentTamper.skills[0]!.content += "\nTAMPERED";
    expect(() => prepareWorkerSkillContext({
      declaredSkills: ["review"],
      skillContext: contentTamper,
    })).toThrow(/digest/i);

    const aggregateTamper = structuredClone(context);
    aggregateTamper.context_digest = "f".repeat(64);
    expect(() => prepareWorkerSkillContext({
      declaredSkills: ["review"],
      skillContext: aggregateTamper,
    })).toThrow(/canonical Skill Context|digest/i);

    const secretTamper = structuredClone(context);
    secretTamper.skills[0]!.content = "api_key=sk-livecredential1234567890";
    expect(() => prepareWorkerSkillContext({
      declaredSkills: ["review"],
      skillContext: secretTamper,
    })).toThrow(/obvious/i);
  });

  it("appends only the current Agent snapshot and preserves runtime authority", () => {
    const context = skillContext();
    const prepared = prepareWorkerSkillContext({
      systemPrompt: "Original node instructions",
      declaredSkills: ["review"],
      skillContext: context,
    });

    expect(prepared.systemPrompt).toContain("Original node instructions");
    expect(prepared.systemPrompt).toContain(SKILL_BODY);
    expect(prepared.systemPrompt).toContain(context.context_digest);
    expect(prepared.systemPrompt).toContain("cannot grant or change tools");
    expect(prepared.systemPrompt).toContain("must never write Canvas");
    expect(prepared.systemPrompt!.indexOf(SKILL_BODY))
      .toBeGreaterThan(prepared.systemPrompt!.indexOf("Original node instructions"));
    expect(JSON.stringify(prepared.summary)).not.toContain(SKILL_BODY);
    expect(prepared.skillProjection).toMatchObject({
      mode: "explicit",
      definitions: [{ id: "review" }],
    });
    expect(prepared.skillProjection.definitions?.[0]?.content).toContain(SKILL_BODY);
    expect(prepared.skillProjection.definitions?.[0]?.content).toContain(context.context_digest);
    expect(prepared.skillProjection.directories).toBeUndefined();
  });

  it("uses an explicit empty projection when no Worker Skill snapshot is assigned", () => {
    const prepared = prepareWorkerSkillContext({ systemPrompt: "Plain worker instructions" });

    expect(prepared.skillProjection).toEqual({ mode: "explicit", definitions: [] });
    expect(prepared.systemPrompt).toBe("Plain worker instructions");
  });

  it("keeps full visual views pinned outside the prompt and exposes stable view ids", () => {
    const context = visualSkillContext();
    const prepared = prepareWorkerSkillContext({
      declaredSkills: ["review"],
      skillContext: context,
    });
    const views = createWorkerSkillVisualViewRegistry(prepared.context);
    const contracts = createWorkerSkillVisualDataContractRegistry(prepared.context);

    expect(prepared.systemPrompt).toContain('"id":"summary"');
    expect(prepared.systemPrompt).toContain('"data_contract"');
    expect(prepared.systemPrompt).toContain('"mode":"source"');
    expect(prepared.systemPrompt).toContain('"data_fields":["title"]');
    expect(prepared.systemPrompt).not.toContain('"components"');
    expect(views.get("summary")).toEqual(context.skills[0]!.visual_profile!.views![0]!.a2ui);
    expect(views.get("review:summary")).toEqual(context.skills[0]!.visual_profile!.views![0]!.a2ui);
    expect(contracts.get("summary")).toEqual(context.skills[0]!.visual_profile!.views![0]!.data_contract);
    expect(contracts.get("review:summary")).toEqual(context.skills[0]!.visual_profile!.views![0]!.data_contract);

    const local = views.get("summary")!;
    (local.components[0] as { id: string }).id = "mutated";
    expect(context.skills[0]!.visual_profile!.views![0]!.a2ui.components[0]!.id).toBe("root");
  });

  it("exposes only the workflow-authorized pinned Surface views", () => {
    const context = multiVisualSkillContext();
    const prepared = prepareWorkerSkillContext({
      declaredSkills: ["review"],
      allowedSurfaceViews: ["summary"],
      skillContext: context,
    });
    const views = createWorkerSkillVisualViewRegistry(
      prepared.context,
      prepared.allowedSurfaceViewIds,
    );
    const contracts = createWorkerSkillVisualDataContractRegistry(
      prepared.context,
      prepared.allowedSurfaceViewIds,
    );

    expect(prepared.systemPrompt).toContain("Runtime allowed pinned Surface views: summary");
    expect(prepared.systemPrompt).toContain('"id":"summary"');
    expect(prepared.systemPrompt).not.toContain('"id":"detail"');
    expect([...views.keys()]).toEqual(["summary"]);
    expect([...contracts.keys()]).toEqual(["summary"]);

    expect(() => prepareWorkerSkillContext({
      declaredSkills: ["review"],
      allowedSurfaceViews: ["missing"],
      skillContext: context,
    })).toThrow(/unavailable pinned view 'missing'/);
  });

  it("rejects a cold-recovery checkpoint whose pinned digests differ", () => {
    const context = skillContext();
    const mismatched = checkpoint(context);
    mismatched.skill_context!.context_digest = "0".repeat(64);
    expect(() => prepareWorkerSkillContext({
      declaredSkills: ["review"],
      skillContext: context,
      actorCheckpoint: mismatched,
    })).toThrow(WorkerSkillContextError);

    expect(prepareWorkerSkillContext({
      declaredSkills: ["review"],
      skillContext: context,
      actorCheckpoint: checkpoint(context),
    }).context).toEqual(context);
  });

  it("keeps the pinned body on correction turns while audits retain only the summary", async () => {
    const context = skillContext();
    const prepared = prepareWorkerSkillContext({
      systemPrompt: "Original reviewer instructions",
      declaredSkills: ["review"],
      skillContext: context,
      actorCheckpoint: checkpoint(context),
    });
    let observedContext: AgentRunContext | undefined;
    let observedTools: string[] = [];
    const agent: AgentClient = {
      run(_prompt, tools, runtimeContext) {
        observedContext = runtimeContext;
        observedTools = tools.map((tool) => tool.name);
        return (async function* () {
          await tools[0]!.handler({ port: "done", content: "corrected" });
          yield { type: "done" as const };
        })();
      },
    };
    registerAgentBackend("test-worker-skill-correction", () => agent);
    const auditDir = mkdtempSync(join(tmpdir(), "homerail-worker-skill-audit-"));
    try {
      await runPrompt({
        task: "## input:context\n{}\n\n## input:correction\nUse the exact contract",
        sender: "test",
        runId: "worker-skill-correction",
        dagConfig: dagConfig(),
        systemPrompt: prepared.systemPrompt,
        skillProjection: prepared.skillProjection,
        skillContextSummary: prepared.summary,
        actorCheckpoint: checkpoint(context),
        llmBaseUrl: "https://llm.example.test/v1",
      }, {
        wsSend: () => {},
        agentBackend: "test-worker-skill-correction",
        auditDir,
      });

      expect(observedTools).toEqual(["handoff"]);
      expect(observedContext?.handoffOnly).toBe(true);
      expect(observedContext?.systemPromptMode).toBe("replace");
      expect(observedContext?.systemPrompt).toContain("DAG CONTRACT CORRECTION MODE");
      expect(observedContext?.systemPrompt).toContain(SKILL_BODY);
      expect(observedContext?.skillProjection).toEqual(prepared.skillProjection);

      const audit = readFileSync(join(auditDir, "worker-skill-correction.jsonl"), "utf8");
      expect(audit).toContain(context.context_digest);
      expect(audit).toContain("review");
      expect(audit).not.toContain(SKILL_BODY);
    } finally {
      rmSync(auditDir, { recursive: true, force: true });
    }
  });
});
