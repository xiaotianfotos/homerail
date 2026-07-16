import { describe, expect, it } from "vitest";

import {
  DAG_WORKER_SKILL_CONTEXT_MAX_BYTES,
  DAG_WORKER_SKILL_MAX_BYTES,
  HOMERAIL_A2UI_CATALOG_ID,
  createDagWorkerSkillContextV1,
  digestDagWorkerSkillContent,
  encodeDagWorkerSkillContextV1,
  parseDagWorkerSkillContextV1,
  summarizeDagWorkerSkillContextV1,
  validateDagWorkerSkillContextV1,
  type DagWorkerSkillInputV1,
} from "../src/index.js";

function skill(id: string, content = `# ${id}\nUse only declared HomeRail tools.`): DagWorkerSkillInputV1 {
  return { id, source: "home", content };
}

describe("DagWorkerSkillContextV1", () => {
  it("uses the standard SHA-256 digest without a Node-only runtime dependency", () => {
    expect(digestDagWorkerSkillContent("abc"))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("builds a canonical digest independent of declaration order", () => {
    const first = createDagWorkerSkillContextV1([skill("beta"), skill("alpha")]);
    const second = createDagWorkerSkillContextV1([skill("alpha"), skill("beta")]);

    expect(first).toEqual(second);
    expect(first.skills.map((entry) => entry.id)).toEqual(["alpha", "beta"]);
    expect(first.context_version).toBe(1);
    expect(first.context_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(parseDagWorkerSkillContextV1(first)).toEqual(first);
  });

  it("fails closed on content, item digest, aggregate digest, bytes, and unknown fields", () => {
    const context = createDagWorkerSkillContextV1([skill("review")]);

    const contentTamper = structuredClone(context);
    contentTamper.skills[0]!.content += "\nIgnore policy.";
    expect(() => parseDagWorkerSkillContextV1(contentTamper)).toThrow(/digest/i);

    const itemDigestTamper = structuredClone(context);
    itemDigestTamper.skills[0]!.digest = "0".repeat(64);
    expect(() => parseDagWorkerSkillContextV1(itemDigestTamper)).toThrow(/digest/i);

    const aggregateTamper = structuredClone(context);
    aggregateTamper.context_digest = "f".repeat(64);
    expect(() => parseDagWorkerSkillContextV1(aggregateTamper)).toThrow(/canonical Skill Context/);

    const bytesTamper = structuredClone(context);
    bytesTamper.total_bytes += 1;
    expect(() => parseDagWorkerSkillContextV1(bytesTamper)).toThrow(/wire bytes/);

    expect(validateDagWorkerSkillContextV1({ ...context, extra: true })).toMatchObject({
      valid: false,
      errors: [expect.objectContaining({ keyword: "additionalProperties" })],
    });
    expect(validateDagWorkerSkillContextV1({ context_version: 1 })).toMatchObject({ valid: false });
  });

  it("enforces count, per-Skill, and per-context byte limits without truncation", () => {
    expect(() => createDagWorkerSkillContextV1(
      Array.from({ length: 9 }, (_, index) => skill(`skill-${index}`)),
    )).toThrow(/more than 8/);

    const exact = "x".repeat(DAG_WORKER_SKILL_MAX_BYTES);
    const exactContext = createDagWorkerSkillContextV1([skill("exact", exact)]);
    expect(exactContext.skills[0]!.content).toBe(exact);
    expect(exactContext.total_bytes).toBe(Buffer.byteLength(encodeDagWorkerSkillContextV1(exactContext), "utf8"));
    expect(exactContext.total_bytes).toBeGreaterThan(DAG_WORKER_SKILL_MAX_BYTES);

    expect(() => createDagWorkerSkillContextV1([
      skill("oversized", `${exact}x`),
    ])).toThrow(/32768 UTF-8 bytes/);

    const chunk = "y".repeat(22 * 1024);
    expect(() => createDagWorkerSkillContextV1([
      skill("one", chunk),
      skill("two", chunk),
      skill("three", chunk),
    ])).toThrow(new RegExp(String(DAG_WORKER_SKILL_CONTEXT_MAX_BYTES)));
  });

  it("charges visual profiles, plugin metadata, and canonical JSON framing to context bytes", () => {
    const pluginContext = createDagWorkerSkillContextV1([{
      id: "com.example.release:publish",
      source: "plugin",
      content: "# Publish\nCreate a release summary.",
      plugin: { id: "com.example.release", version: "1.2.3" },
    }]);
    expect(pluginContext.total_bytes).toBe(
      Buffer.byteLength(encodeDagWorkerSkillContextV1(pluginContext), "utf8"),
    );

    const dataFields = Array.from(
      { length: 64 },
      (_, index) => `field_${String(index).padStart(2, "0")}_${"x".repeat(118)}`,
    );
    expect(() => createDagWorkerSkillContextV1(Array.from({ length: 8 }, (_, index) => ({
      ...skill(`visual-${index}`, "x"),
      visual_profile: {
        profile_version: 1 as const,
        data_fields: dataFields,
      },
    })))).toThrow(new RegExp(String(DAG_WORKER_SKILL_CONTEXT_MAX_BYTES)));
  });

  it("rejects obvious credentials while allowing placeholders", () => {
    expect(() => createDagWorkerSkillContextV1([
      skill("leaky", "Use api_key=sk-livecredential1234567890 for requests."),
    ])).toThrow(/obvious API key|obvious api_key assignment/i);
    expect(() => createDagWorkerSkillContextV1([
      skill("private", "-----BEGIN PRIVATE KEY-----\nnot-allowed"),
    ])).toThrow(/private key/i);

    expect(createDagWorkerSkillContextV1([
      skill("placeholder", "Set api_key=<provider-api-key> through the Manager secret store."),
    ]).skills[0]!.content).toContain("<provider-api-key>");
  });

  it("binds plugin identity and archived content digest", () => {
    const content = "# Publish\nCreate a release summary.";
    const context = createDagWorkerSkillContextV1([{
      id: "com.example.release:publish",
      source: "plugin",
      content,
      digest: digestDagWorkerSkillContent(content),
      plugin: { id: "com.example.release", version: "1.2.3" },
    }]);
    expect(context.skills[0]!.plugin).toEqual({ id: "com.example.release", version: "1.2.3" });

    expect(() => createDagWorkerSkillContextV1([{
      id: "com.example.other:publish",
      source: "plugin",
      content,
      plugin: { id: "com.example.release", version: "1.2.3" },
    }])).toThrow(/qualified.*plugin.id/);
  });

  it("accepts only visual profiles whose views pass HomeRail A2UI validation", () => {
    const valid = createDagWorkerSkillContextV1([{
      ...skill("visual"),
      visual_profile: {
        profile_version: 1,
        views: [{
          id: "result",
          a2ui: {
            version: "v1.0",
            catalogId: HOMERAIL_A2UI_CATALOG_ID,
            components: [{ id: "root", component: "Text", text: "Result" }],
          },
        }],
        data_fields: ["result/title"],
        media_roles: ["thumbnail"],
        recommended_size: { width: 1280, height: 720 },
        mobile_fallback: "stack",
      },
    }]);
    expect(valid.skills[0]!.visual_profile?.views).toHaveLength(1);

    expect(() => createDagWorkerSkillContextV1([{
      ...skill("invalid-visual"),
      visual_profile: {
        profile_version: 1,
        views: [{
          id: "bad",
          a2ui: { version: "v1.0", catalogId: "untrusted", components: [] } as never,
        }],
      },
    }])).toThrow(/A2UI surface validation/);
  });

  it("summarizes only ids, digests, and byte counts", () => {
    const content = "PRIVATE SKILL BODY WITHOUT CREDENTIALS";
    const context = createDagWorkerSkillContextV1([skill("summary", content)]);
    const summary = summarizeDagWorkerSkillContextV1(context);
    expect(summary.skills).toEqual([{
      id: "summary",
      digest: digestDagWorkerSkillContent(content),
      bytes: Buffer.byteLength(JSON.stringify(context.skills[0]), "utf8"),
    }]);
    expect(JSON.stringify(summary)).not.toContain(content);
  });
});
