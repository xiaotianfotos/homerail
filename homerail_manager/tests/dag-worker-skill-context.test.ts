import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAG_WORKER_SKILL_RUN_MAX_BYTES,
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_VERSION,
  createDagWorkerSkillContextV1,
  digestDagWorkerSkillContent,
} from "homerail-protocol";

import type { ActivePluginRecord } from "../src/persistence/plugins.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  DagRunSkillContextConflictError,
  getDagRunSkillContext,
  pinDagRunSkillContext,
  pinDagRunSkillContexts,
} from "../src/persistence/dag-run-skill-contexts.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import { getDagActorByNode } from "../src/persistence/dag-actors.js";
import { dispatchEnvelopeAuditView } from "../src/orchestration/ws-dispatch-adapter.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import {
  _clearActiveRuns,
  appendRunNode,
  buildCurrentDispatchEnvelope,
  createActiveRun,
  recoverAllActiveRuns,
} from "../src/runtime/active-runs.js";
import { buildDagActorCheckpoint } from "../src/runtime/dag-actor-checkpoint-builder.js";
import {
  resolveDagWorkerSkillContext,
  resolveDeclaredDagWorkerSkillContexts,
} from "../src/runtime/dag-worker-skill-context.js";

function writeSkill(root: string, id: string, content: string): void {
  const directory = path.join(root, "skills", id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), content, "utf8");
}

function insertRun(runId: string): void {
  getDb().prepare(`
    INSERT INTO dag_runs(run_id, status, created_at, updated_at, metadata)
    VALUES (?, 'active', ?, ?, '{}')
  `).run(runId, Date.now(), Date.now());
}

function activePlugin(
  pluginId: string,
  pluginVersion: string,
  source: ActivePluginRecord["source"] = "installed",
): ActivePluginRecord {
  return {
    plugin_id: pluginId,
    plugin_version: pluginVersion,
    source,
    package_digest: "a".repeat(64),
    installed_at: new Date(0).toISOString(),
    descriptor: {} as ActivePluginRecord["descriptor"],
    activation: {
      plugin_id: pluginId,
      active_version: pluginVersion,
      enabled: true,
      locked: false,
      revision: 1,
      updated_at: new Date(0).toISOString(),
    },
  };
}

function pinnedDag(skillId: string) {
  return parseDAGYaml(`
name: pinned-worker-skill
workflow_id: pinned-worker-skill
agents:
  worker:
    agent_type: deterministic
    system: "HANDOFF port=done content=ok"
    skills: [${skillId}]
nodes:
  work:
    agent: worker
    outputs:
      done:
        to: ""
`);
}

function requireEnvelope(runId: string, nodeId: string) {
  const result = buildCurrentDispatchEnvelope(runId, nodeId);
  if (!result.ok) throw new Error(result.reason);
  return result.envelope;
}

describe("digest-pinned DAG Worker Skill Context", () => {
  let previousHome: string | undefined;
  let home: string;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-skill-context-"));
    process.env.HOMERAIL_HOME = home;
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllPersistence();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("resolves only explicit home, repo, and trusted archived Plugin Skills", () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-skill-repo-"));
    try {
      const homeBody = "# Home\nUse the pinned home instructions.";
      const repoBody = "# Repo\nUse the pinned repository instructions.";
      const pluginBody = "# Plugin\nUse the trusted archived Plugin instructions.";
      writeSkill(home, "home-only", homeBody);
      writeSkill(home, "not-declared", "api_key=sk-undisclosedcredential1234567890");
      writeSkill(repository, "repo-only", repoBody);

      const pluginId = "com.example.worker";
      const pluginVersion = "1.2.3";
      const qualifiedId = `${pluginId}:archived`;
      const options = {
        homerail_home: home,
        repository_root: repository,
        read_archived_plugin_skill: (id: string) => id === qualifiedId ? {
          descriptor: {
            plugin_id: pluginId,
            plugin_version: pluginVersion,
            local_id: "archived",
            qualified_id: qualifiedId,
            digest: digestDagWorkerSkillContent(pluginBody),
          },
          content: pluginBody,
        } : undefined,
        get_active_plugin: (id: string) => id === pluginId
          ? activePlugin(pluginId, pluginVersion)
          : undefined,
        is_trusted_registry_plugin_asset: () => true,
      };

      const contexts = resolveDeclaredDagWorkerSkillContexts({
        agents: {
          home: { skills: ["home-only"] },
          repo: { skills: ["repo-only"] },
          plugin: { skills: [qualifiedId] },
          omitted: {},
        },
        options,
      });

      expect(Object.keys(contexts)).toEqual(["home", "omitted", "plugin", "repo"]);
      expect(contexts.home!.skills[0]).toMatchObject({ source: "home", content: homeBody });
      expect(contexts.repo!.skills[0]).toMatchObject({ source: "repo", content: repoBody });
      expect(contexts.plugin!.skills[0]).toMatchObject({
        source: "plugin",
        content: pluginBody,
        plugin: { id: pluginId, version: pluginVersion },
      });
      expect(contexts.omitted!.skills).toEqual([]);
      expect(JSON.stringify(contexts)).not.toContain("sk-undisclosedcredential");
      expect(() => resolveDagWorkerSkillContext({
        agent_id: "leaky",
        skills: ["not-declared"],
        options,
      })).toThrow(/obvious/i);

      expect(() => resolveDagWorkerSkillContext({
        agent_id: "plugin",
        skills: [qualifiedId],
        options: { ...options, is_trusted_registry_plugin_asset: () => false },
      })).toThrow(/not a trusted archived asset/);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  it("fails closed when an Agent allows a pinned Surface view its Skills do not provide", () => {
    writeSkill(home, "visual", "# Visual\nUse the pinned view selected by runtime.");
    const assetDirectory = path.join(home, "skills", "visual", "assets", "homerail");
    fs.mkdirSync(assetDirectory, { recursive: true });
    fs.writeFileSync(path.join(assetDirectory, "worker-visual-profile.json"), JSON.stringify({
      profile_version: 1,
      views: ["summary", "detail"].map((id) => ({
        id,
        a2ui: {
          version: HOMERAIL_A2UI_VERSION,
          catalogId: HOMERAIL_A2UI_CATALOG_ID,
          components: [{ id: "root", component: "Text", text: { path: "/actor_view/data/title" } }],
        },
        data_contract: {
          source: { input_port: "mission", encoding: "json", pointer: `/${id}` },
          fields: [{ field: "title", mode: "source", source_pointer: "/title" }],
        },
      })),
    }), "utf8");

    expect(resolveDeclaredDagWorkerSkillContexts({
      agents: {
        worker: { skills: ["visual"], allowed_surface_views: ["summary"] },
      },
    }).worker?.skills[0]?.visual_profile?.views).toHaveLength(2);

    expect(() => resolveDeclaredDagWorkerSkillContexts({
      agents: {
        worker: { skills: ["visual"], allowed_surface_views: ["missing"] },
      },
    })).toThrow(/unavailable pinned Surface view 'missing'/);
  });

  it("migrates old databases at 29, validates repeated startup, and prohibits UPDATE", () => {
    const initial = getDb();
    expect(initial.prepare("SELECT 1 FROM schema_migrations WHERE version = 29").get()).toBeTruthy();
    initial.exec(`
      DROP TABLE dag_run_skill_contexts;
      DELETE FROM schema_migrations WHERE version = 29;
    `);
    closeDb();

    const migrated = getDb();
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 29").get())
      .toEqual({ count: 1 });
    insertRun("migration-run");
    const context = createDagWorkerSkillContextV1([{
      id: "migration",
      source: "home",
      content: "# Migration\nPinned once.",
    }]);
    pinDagRunSkillContext({ run_id: "migration-run", agent_id: "worker", context });
    expect(() => migrated.prepare(`
      UPDATE dag_run_skill_contexts SET created_at = created_at + 1
      WHERE run_id = 'migration-run' AND agent_id = 'worker'
    `).run()).toThrow(/append-only/);

    closeDb();
    expect(getDagRunSkillContext("migration-run", "worker")?.context).toEqual(context);
    closeDb();
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 29").get())
      .toEqual({ count: 1 });
  });

  it("charges full context envelopes to the 1 MiB run aggregate", () => {
    insertRun("aggregate-run");
    const content = "x".repeat(30_000);
    const context = createDagWorkerSkillContextV1([{
      id: "aggregate",
      source: "home",
      content,
      visual_profile: {
        profile_version: 1,
        data_fields: Array.from(
          { length: 32 },
          (_, index) => `field_${String(index).padStart(2, "0")}_${"x".repeat(108)}`,
        ),
      },
    }]);
    const accepted = Math.floor(DAG_WORKER_SKILL_RUN_MAX_BYTES / context.total_bytes);
    expect((accepted + 1) * Buffer.byteLength(content, "utf8"))
      .toBeLessThan(DAG_WORKER_SKILL_RUN_MAX_BYTES);
    expect((accepted + 1) * context.total_bytes).toBeGreaterThan(DAG_WORKER_SKILL_RUN_MAX_BYTES);

    pinDagRunSkillContexts({
      run_id: "aggregate-run",
      contexts: Object.fromEntries(
        Array.from({ length: accepted }, (_, index) => [`agent-${index}`, context]),
      ),
    });
    expect(() => pinDagRunSkillContext({
      run_id: "aggregate-run",
      agent_id: "over-budget",
      context,
    })).toThrow(DagRunSkillContextConflictError);
  });

  it("keeps the admission snapshot across source changes, restart, and cold recovery", () => {
    const originalBody = "# Pinned\nORIGINAL_SKILL_BODY";
    writeSkill(home, "pinned", originalBody);
    createActiveRun("snapshot-run", pinnedDag("pinned"));

    const first = requireEnvelope("snapshot-run", "work");
    expect(first.skillContext?.skills[0]?.content).toBe(originalBody);
    const actor = getDagActorByNode("snapshot-run", "work")!;
    const checkpoint = buildDagActorCheckpoint({
      runId: "snapshot-run",
      actor,
      roundId: "round-0001",
    });
    expect(checkpoint.skill_context).toEqual({
      context_digest: first.skillContext!.context_digest,
      skills: [{
        id: "pinned",
        digest: first.skillContext!.skills[0]!.digest,
      }],
    });
    expect(JSON.stringify(checkpoint)).not.toContain(originalBody);
    fs.writeFileSync(
      path.join(home, "skills", "pinned", "SKILL.md"),
      "# Pinned\nCHANGED_AFTER_ADMISSION",
      "utf8",
    );
    expect(requireEnvelope("snapshot-run", "work").skillContext).toEqual(first.skillContext);

    _clearActiveRuns();
    closeDb();
    expect(recoverAllActiveRuns().recovered).toContain("snapshot-run");
    const recovered = requireEnvelope("snapshot-run", "work");
    expect(recovered.skillContext).toEqual(first.skillContext);

    const auditView = dispatchEnvelopeAuditView(recovered) as {
      skillContext: { skills: Array<Record<string, unknown>> };
    };
    const audit = JSON.stringify(auditView);
    expect(audit).toContain(first.skillContext!.context_digest);
    expect(audit).toContain("pinned");
    expect(audit).not.toContain("ORIGINAL_SKILL_BODY");
    expect(Object.keys(auditView.skillContext.skills[0]!).sort()).toEqual(["bytes", "digest", "id"]);
  });

  it("rejects dynamic nodes that try to change a same-run Agent digest", () => {
    writeSkill(home, "pinned", "# Dynamic\nORIGINAL_DYNAMIC_SKILL");
    const run = createActiveRun("dynamic-skill-run", pinnedDag("pinned"));
    const pinnedContext = getDagRunSkillContext("dynamic-skill-run", "worker")!.context;
    fs.writeFileSync(
      path.join(home, "skills", "pinned", "SKILL.md"),
      "# Dynamic\nREPLACEMENT_DYNAMIC_SKILL",
      "utf8",
    );

    expect(() => appendRunNode("dynamic-skill-run", {
      node: {
        node_id: "observer",
        name: "Observer",
        description: "Observe the pinned result",
        node_type: "task",
        agent: "worker",
        after: ["work"],
        outputs: { done: { to: "" } },
      },
      agentConfig: {
        agent_type: "deterministic",
        system: "HANDOFF port=done content=observed",
        skills: ["pinned"],
      },
    })).toThrow(/cannot replace pinned Skill Context/);
    expect(run.dagRun.graph.nodes.map((node) => node.node_id)).toEqual(["work"]);

    expect(appendRunNode("dynamic-skill-run", {
      node: {
        node_id: "observer-preserved",
        name: "Observer preserved",
        description: "Reuse the admission-time Skill snapshot",
        node_type: "task",
        agent: "worker",
        after: ["work"],
        outputs: { done: { to: "" } },
      },
      agentConfig: {
        agent_type: "deterministic",
        system: "HANDOFF port=done content=preserved",
      },
    })).toMatchObject({ nodeId: "observer-preserved", nodeCount: 2 });
    expect(getDagRunSkillContext("dynamic-skill-run", "worker")?.context).toEqual(pinnedContext);
  });

  it("changes a dynamic Agent Surface allowlist without replacing its pinned Skill snapshot", () => {
    writeSkill(home, "visual-pinned", "# Visual pinned\nORIGINAL_VISUAL_SKILL");
    const assetDirectory = path.join(home, "skills", "visual-pinned", "assets", "homerail");
    fs.mkdirSync(assetDirectory, { recursive: true });
    fs.writeFileSync(path.join(assetDirectory, "worker-visual-profile.json"), JSON.stringify({
      profile_version: 1,
      views: ["summary", "detail"].map((id) => ({
        id,
        a2ui: {
          version: HOMERAIL_A2UI_VERSION,
          catalogId: HOMERAIL_A2UI_CATALOG_ID,
          components: [{ id: "root", component: "Text", text: { path: "/actor_view/data/title" } }],
        },
        data_contract: {
          source: { input_port: "mission", encoding: "json", pointer: `/${id}` },
          fields: [{ field: "title", mode: "source", source_pointer: "/title" }],
        },
      })),
    }), "utf8");
    const parsed = parseDAGYaml(`
name: visual-pinned-worker
workflow_id: visual-pinned-worker
agents:
  worker:
    agent_type: deterministic
    system: "HANDOFF port=done content=ok"
    skills: [visual-pinned]
    allowed_surface_views: [summary]
nodes:
  work:
    agent: worker
    outputs:
      done:
        to: ""
`);
    createActiveRun("dynamic-surface-allowlist-run", parsed);
    const pinnedContext = getDagRunSkillContext("dynamic-surface-allowlist-run", "worker")!.context;
    writeSkill(home, "visual-pinned", "# Visual pinned\nCHANGED_AFTER_ADMISSION");

    expect(appendRunNode("dynamic-surface-allowlist-run", {
      node: {
        node_id: "detail",
        name: "Detail",
        description: "Reuse the pinned detail view",
        node_type: "task",
        agent: "worker",
        after: [],
        outputs: { done: { to: "" } },
      },
      agentConfig: {
        agent_type: "deterministic",
        system: "HANDOFF port=done content=detail",
        allowed_surface_views: ["detail"],
      },
    })).toMatchObject({ nodeId: "detail", nodeCount: 2 });
    expect(getDagRunSkillContext("dynamic-surface-allowlist-run", "worker")?.context).toEqual(pinnedContext);
    expect(requireEnvelope("dynamic-surface-allowlist-run", "detail").agentConfig.allowed_surface_views)
      .toEqual(["detail"]);
  });

  it("treats an initially empty Agent context as pinned during dynamic append", () => {
    writeSkill(home, "late-skill", "# Late\nThis must not replace the empty snapshot.");
    const parsed = parseDAGYaml(`
name: empty-worker-skill
workflow_id: empty-worker-skill
agents:
  worker:
    agent_type: deterministic
nodes:
  work:
    agent: worker
    outputs:
      done:
        to: ""
`);
    const run = createActiveRun("dynamic-empty-skill-run", parsed);
    expect(getDagRunSkillContext("dynamic-empty-skill-run", "worker")?.context.skills).toEqual([]);

    expect(() => appendRunNode("dynamic-empty-skill-run", {
      node: {
        node_id: "late",
        name: "Late",
        description: "Attempt a late Skill declaration",
        node_type: "task",
        agent: "worker",
        after: ["work"],
        outputs: { done: { to: "" } },
      },
      agentConfig: {
        agent_type: "deterministic",
        skills: ["late-skill"],
      },
    })).toThrow(/cannot replace pinned Skill Context/);
    expect(run.dagRun.graph.nodes.map((node) => node.node_id)).toEqual(["work"]);

    expect(appendRunNode("dynamic-empty-skill-run", {
      node: {
        node_id: "observer",
        name: "Observer",
        description: "Use a newly pinned Agent context",
        node_type: "task",
        agent: "observer",
        after: ["work"],
        outputs: { done: { to: "" } },
      },
      agentConfig: {
        agent_type: "deterministic",
        skills: ["late-skill"],
      },
    })).toMatchObject({ nodeId: "observer", nodeCount: 2 });
    expect(getDagRunSkillContext("dynamic-empty-skill-run", "observer")?.context.skills[0])
      .toMatchObject({ id: "late-skill", source: "home" });
  });
});
