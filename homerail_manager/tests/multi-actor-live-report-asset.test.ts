import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb } from "../src/persistence/db.js";
import type { DAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { getDagLiveSurfaceDocument } from "../src/generative-ui/dag-live-surface-projector.js";
import { readArchivedPluginSkill } from "../src/plugins/context-assembler.js";
import { syncBuiltinPlugins } from "../src/plugins/registry.js";
import {
  compileWorkflowSource,
  parseWorkflowSource,
} from "../src/orchestration/workflow-spec-v1.js";
import { resolveDeclaredDagWorkerSkillContexts } from "../src/runtime/dag-worker-skill-context.js";
import { _clearActiveRuns } from "../src/runtime/active-runs.js";

const ACTORS = ["research", "synthesis", "visual_story"] as const;
const VIEWS = ["research-live", "analysis-live", "publication-live"] as const;
const VIEW_FIELDS: Record<(typeof VIEWS)[number], string[]> = {
  "research-live": [
    "title", "phase_text", "summary", "progress", "primary_tone", "secondary_tone", "accent_tone",
    "verified_count", "source_count", "gap_count",
    "finding_one", "finding_two", "source_one", "source_two",
  ],
  "analysis-live": [
    "title", "phase_text", "summary", "progress", "primary_tone", "secondary_tone", "accent_tone",
    "confidence", "evidence_count", "risk_count",
    "conclusion", "evidence_one", "evidence_two", "caveat",
  ],
  "publication-live": [
    "title", "phase_text", "summary", "progress", "primary_tone", "secondary_tone", "accent_tone",
    "headline", "hook", "stat_one_label", "stat_one_value",
    "stat_two_label", "stat_two_value", "point_one", "point_two", "point_three", "post_text", "tags",
  ],
};
const WORKFLOW_FILE = path.resolve(
  import.meta.dirname,
  "../../assets/orchestrations/multi-actor-live-report.yaml.template",
);

describe("multi-Actor live report asset", () => {
  let previousHome: string | undefined;
  let home: string;

  beforeEach(() => {
    closeDb();
    _clearActiveRuns();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-multi-actor-live-report-"));
    process.env.HOMERAIL_HOME = home;
    syncBuiltinPlugins();
  });

  afterEach(() => {
    _clearActiveRuns();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("compiles three stable presentation Actors into one supervised waiting round", () => {
    const source = fs.readFileSync(WORKFLOW_FILE, "utf8");
    const result = compileWorkflowSource(source);

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toEqual({
      workflow_id: "multi-actor-live-report",
      node_count: 8,
      edge_count: 11,
      entry_nodes: [...ACTORS].sort(),
      terminal_nodes: ACTORS.map((actor) => `${actor}_failed`).sort(),
    });
    expect(source).not.toMatch(/^\s*(?:provider|model|llm_setting_id|api_key|base_url):/m);

    const canonical = result.canonical!;
    for (const [index, actor] of ACTORS.entries()) {
      expect(canonical.agents[actor]).toMatchObject({
        skills: ["com.homerail.core:voice-generative-ui"],
        allowed_surface_views: [VIEWS[index]],
      });
      expect(canonical.nodes.find((node) => node.id === actor)).toMatchObject({
        kind: "agent",
        agent: actor,
        config: {
          allowed_builtin_tools: ["Bash", "Glob", "Grep", "LS", "Read"],
          allowed_dag_tools: ["handoff", "report_activity", "report_surface_state"],
        },
      });
      expect(canonical.agents[actor]?.system).toContain(
        "report_surface_state exactly three times",
      );
      expect(canonical.agents[actor]?.system).toMatch(/started,\s+partial,\s+final/);
      for (const field of VIEW_FIELDS[VIEWS[index]]) {
        expect(canonical.agents[actor]?.system).toContain(field);
      }
    }

    expect(canonical.nodes.find((node) => node.id === "collect_round")).toMatchObject({
      kind: "join",
      config: { mode: "all", field: "status", success_values: ["ready"] },
    });
    expect(canonical.nodes.find((node) => node.id === "wait_for_command")).toMatchObject({
      kind: "await_command",
      config: {
        primitive_version: 1,
        target_actors: [...ACTORS],
        command_port: "command",
      },
    });

    const parsed = parseWorkflowSource(source);
    const contexts = resolveDeclaredDagWorkerSkillContexts({
      agents: parsed.meta.agents ?? {},
    });
    for (const [index, actor] of ACTORS.entries()) {
      expect(contexts[actor]?.skills).toEqual([
        expect.objectContaining({
          id: "com.homerail.core:voice-generative-ui",
          source: "plugin",
          plugin: { id: "com.homerail.core", version: "0.1.8" },
          visual_profile: expect.objectContaining({
            views: expect.arrayContaining([
              expect.objectContaining({ id: VIEWS[index] }),
            ]),
          }),
        }),
      ]);
    }

    const dispatcher: DAGDispatcher = {
      dispatch: () => ({ status: "dispatched", targetType: "worker", targetId: "unused" }),
    };
    new GraphExecutor(dispatcher).createRun(
      "multi-actor-live-report-roster",
      parsed,
      "Investigate, synthesize, and present one current topic.",
    );
    expect(getDagLiveSurfaceDocument("multi-actor-live-report-roster")?.nodes.map((node) => node.id))
      .toEqual(ACTORS.map((actor) => `actor:${actor}`));
  });

  it("binds every declared view to the archived Core Skill visual profile", () => {
    const archived = readArchivedPluginSkill("com.homerail.core:voice-generative-ui");
    expect(archived?.descriptor.description).toContain("supervised multi-Actor live panels");
    expect(archived?.visual_profile?.views?.map((view) => view.id)).toEqual(VIEWS);
    for (const view of archived?.visual_profile?.views ?? []) {
      expect(view.data_contract?.required_phases).toEqual(["started", "partial", "final"]);
      expect(view.data_contract?.fields.every((field) => field.mode === "presentation")).toBe(true);
      expect(view.data_contract?.fields.map((field) => field.field)).toEqual(
        VIEW_FIELDS[view.id as (typeof VIEWS)[number]],
      );
      expect(view.data_contract?.fields.find((field) => field.field === "progress")?.value_schema)
        .toMatchObject({ type: "integer", enum: [5, 55, 100] });
      expect(view.a2ui.components.map((component) => component.component)).toEqual(expect.arrayContaining([
        "Icon",
        "HrDisclosure",
        "HrGrid",
        "HrMetric",
        "HrProgress",
        "HrStatusBadge",
      ]));
      const tonePaths = new Set(view.a2ui.components.flatMap((component) => {
        const tone = component.tone as { path?: string } | string | undefined;
        return typeof tone === "object" && typeof tone.path === "string" ? [tone.path] : [];
      }));
      expect(tonePaths).toEqual(new Set([
        "/actor_view/data/primary_tone",
        "/actor_view/data/secondary_tone",
        "/actor_view/data/accent_tone",
      ]));
      expect(view.a2ui.components.some((component) => typeof component.tone === "string")).toBe(false);
      for (const paletteField of ["primary_tone", "secondary_tone", "accent_tone"]) {
        expect(view.data_contract?.fields.find((field) => field.field === paletteField)?.value_schema)
          .toEqual({
            type: "string",
            enum: ["neutral", "info", "positive", "warning", "critical"],
          });
      }
      for (const field of view.data_contract?.fields ?? []) {
        if (field.value_schema?.type === "string" && field.value_schema.enum === undefined) {
          expect(field.value_schema.max_length).toBeLessThanOrEqual(320);
        }
      }
    }
  });
});
