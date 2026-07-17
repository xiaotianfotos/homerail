import { describe, expect, it, vi } from "vitest";
import {
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_VERSION,
  type DagActorSurfaceBodyV1,
  type DagNodeConfig,
} from "homerail-protocol";
import { createDagToolsState } from "../dag-tools/index.js";
import {
  brokerSurfaceMediaBody,
  createSurfaceMediaPublisher,
  isPublicSurfaceMediaAddress,
} from "../dag-tools/surface-media.js";

function config(): DagNodeConfig {
  return {
    node_id: "research",
    agent_type: "claude-sdk",
    model: "test",
    outgoing_edges: [],
    incoming_edges: [],
    graph_nodes: ["research"],
    session_id: "session-1",
    round_id: "round-1",
    actor_id: "actor-research",
    generation: 2,
    lease_generation: 3,
    surface_id: "surface:research",
  };
}

function templateBody(): DagActorSurfaceBodyV1 {
  return {
    a2ui: {
      version: HOMERAIL_A2UI_VERSION,
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [
        { id: "root", component: "Column", children: ["hero", "items"] },
        { id: "hero", component: "Image", url: { path: "/actor_view/data/hero_url" } },
        {
          id: "items",
          component: "List",
          children: { path: "/actor_view/data/items", componentId: "item" },
        },
        { id: "item", component: "Column", children: ["image", "source"] },
        { id: "image", component: "Image", url: { path: "pal/icon_url" } },
        { id: "source", component: "HrLink", label: "Source", url: { path: "source_url" } },
      ],
    },
    data: {
      hero_url: "https://cdn.example/hero.webp",
      items: [
        {
          pal: { icon_url: "https://cdn.example/a.webp" },
          source_url: "https://news.example/a",
        },
        {
          pal: { icon_url: "https://cdn.example/b.webp" },
          source_url: "https://news.example/b",
        },
      ],
    },
    fallback: { title: "Visual result" },
  };
}

describe("Actor surface media broker", () => {
  it("rejects private and special-use addresses while allowing public addresses", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.1.1", "192.168.1.1", "::1", "fe80::1", "fc00::1"]) {
      expect(isPublicSurfaceMediaAddress(address), address).toBe(false);
    }
    expect(isPublicSurfaceMediaAddress("8.8.8.8")).toBe(true);
    expect(isPublicSurfaceMediaAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("publishes a digest-addressed media event once per source URL", async () => {
    const state = createDagToolsState(config(), "run-media", vi.fn());
    const emitted: unknown[] = [];
    const download = vi.fn(async () => ({
      bytes: Buffer.from("webp-media"),
      media_type: "image/webp" as const,
    }));
    const publish = createSurfaceMediaPublisher(state, (media) => emitted.push(media), download);

    const first = await publish("https://cdn.example/pal.webp");
    const second = await publish("https://cdn.example/pal.webp");

    expect(first).toBe(second);
    expect(download).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      schema_version: 1,
      run_id: "run-media",
      actor_id: "actor-research",
      media_type: "image/webp",
      size_bytes: 10,
    });
    expect(JSON.stringify(emitted[0])).not.toContain("cdn.example");
    expect(first).toMatch(/^\/api\/runs\/run-media\/artifacts\/actor-media-[0-9a-f]{64}\.webp\/content$/);
  });

  it("rewrites direct, absolute, and template-relative media without touching normal links", async () => {
    const seen: string[] = [];
    const body = await brokerSurfaceMediaBody(templateBody(), async (url) => {
      seen.push(url);
      return `/api/runs/run-1/artifacts/${url.split("/").at(-1)}/content`;
    });

    expect(seen).toEqual([
      "https://cdn.example/hero.webp",
      "https://cdn.example/a.webp",
      "https://cdn.example/b.webp",
    ]);
    expect(body.data).toMatchObject({
      hero_url: "/api/runs/run-1/artifacts/hero.webp/content",
      items: [
        {
          pal: { icon_url: "/api/runs/run-1/artifacts/a.webp/content" },
          source_url: "https://news.example/a",
        },
        {
          pal: { icon_url: "/api/runs/run-1/artifacts/b.webp/content" },
          source_url: "https://news.example/b",
        },
      ],
    });
  });

  it("repairs scheme-less public media before the guarded publisher", async () => {
    const body = templateBody();
    body.data.hero_url = "cdn.example/hero.webp";
    const publish = vi.fn(async () => "/api/runs/run-1/artifacts/hero.webp/content");

    const brokered = await brokerSurfaceMediaBody(body, publish);

    expect(publish).toHaveBeenCalledWith("https://cdn.example/hero.webp");
    expect(brokered.data.hero_url).toBe("/api/runs/run-1/artifacts/hero.webp/content");
  });

  it("fails closed for unbrokered non-HTTPS media", async () => {
    const body = templateBody();
    body.data.hero_url = "http://127.0.0.1/private.png";
    await expect(brokerSurfaceMediaBody(body, vi.fn())).rejects.toMatchObject({ code: "unsafe_media_url" });

    body.data.hero_url = "localhost/private.png";
    await expect(brokerSurfaceMediaBody(body, vi.fn())).rejects.toMatchObject({ code: "unsafe_media_url" });
  });

  it("reports the exact missing pinned-view media path", async () => {
    const body = templateBody();
    delete body.data.hero_url;

    await expect(brokerSurfaceMediaBody(body, vi.fn())).rejects.toMatchObject({
      code: "missing_media_binding",
      message: "pinned view data must provide media path '/actor_view/data/hero_url' as a string",
    });
  });
});
