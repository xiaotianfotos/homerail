import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOMERAIL_WORKER_PROTOCOL_LABEL,
  HOMERAIL_WORKER_SOURCE_LABEL,
  HOMERAIL_WORKER_VERSION_LABEL,
  WORKER_CONTRACT_VERSION,
} from "homerail-protocol";

vi.mock("../src/events/bus.js", () => ({ emit: vi.fn() }));
vi.mock("../src/worker/registry.js", () => ({ getAllWorkers: vi.fn(() => []) }));

import {
  DagEnvironmentController,
  dagWorkerSourceFingerprint,
  type DagEnvironmentCommandRunner,
} from "../src/server/dag-environment.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const fp = dagWorkerSourceFingerprint(repoRoot);
if (!fp) throw new Error("dagWorkerSourceFingerprint must resolve in repo");

const IMAGE_ID = "sha256:aaaabbbbccccddddeeeeffff000011112222333344445555666677778888999a";
const FULL_DIGEST = "homerail-worker@sha256:111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000";

const VERSION_JSON = JSON.stringify({
  Client: { Version: "27.0.0" },
  Server: { Version: "27.0.0", Os: "linux", Arch: "amd64" },
});
const INFO_JSON = JSON.stringify({ OSType: "linux", Architecture: "amd64" });

function currentLabels(): Record<string, string> {
  return {
    [HOMERAIL_WORKER_SOURCE_LABEL]: fp,
    [HOMERAIL_WORKER_PROTOCOL_LABEL]: WORKER_CONTRACT_VERSION,
    [HOMERAIL_WORKER_VERSION_LABEL]: "0.1.0",
  };
}

function staleLabels(): Record<string, string> {
  return {
    [HOMERAIL_WORKER_SOURCE_LABEL]: "deadbeefcafebabe",
    [HOMERAIL_WORKER_PROTOCOL_LABEL]: WORKER_CONTRACT_VERSION,
    [HOMERAIL_WORKER_VERSION_LABEL]: "0.1.0",
  };
}

function incompatibleLabels(): Record<string, string> {
  return {
    [HOMERAIL_WORKER_SOURCE_LABEL]: fp,
    [HOMERAIL_WORKER_PROTOCOL_LABEL]: "v0-unsupported",
    [HOMERAIL_WORKER_VERSION_LABEL]: "0.0.1",
  };
}

function inspectJSON(opts: {
  id?: string;
  tags?: string[] | null;
  digests?: string[] | null;
  labels?: Record<string, string>;
}): string {
  return JSON.stringify([{
    Id: opts.id ?? IMAGE_ID,
    RepoTags: opts.tags ?? null,
    RepoDigests: opts.digests ?? null,
    Created: "2025-01-01T00:00:00Z",
    Size: 500_000_000,
    Os: "linux",
    Architecture: "amd64",
    Config: { Labels: opts.labels ?? {} },
  }]);
}

function inventoryRow(fields: {
  id?: string;
  repository?: string;
  tag?: string;
  labels?: string;
}): string {
  return JSON.stringify({
    Id: fields.id ?? IMAGE_ID,
    Repository: fields.repository ?? "<none>",
    Tag: fields.tag ?? "<none>",
    Labels: fields.labels ?? "",
    CreatedAt: "2025-01-01",
    Size: "500MB",
  });
}

function makeRunner(opts: {
  inventory?: string[];
  inspectMap?: Map<string, string>;
}): DagEnvironmentCommandRunner {
  return async (_cmd, args) => {
    if (args[0] === "version") return { stdout: VERSION_JSON, stderr: "" };
    if (args[0] === "info") return { stdout: INFO_JSON, stderr: "" };
    if (args[0] === "image" && args[1] === "ls") {
      return { stdout: (opts.inventory ?? []).join("\n"), stderr: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const ref = args[2]!;
      const response = opts.inspectMap?.get(ref);
      if (response === undefined) throw new Error(`Error: No such image: ${ref}`);
      return { stdout: response, stderr: "" };
    }
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
}

describe("dag-environment identity selection", () => {
  const tempDirs: string[] = [];
  let controller: DagEnvironmentController | undefined;

  afterEach(() => {
    controller?.shutdown();
    controller = undefined;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createController(config: {
    workerImage: string;
    inventory?: string[];
    inspectMap?: Map<string, string>;
  }): DagEnvironmentController {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dag-env-id-"));
    tempDirs.push(tmpDir);
    const spawnSpy = vi.fn(() => { throw new Error("spawn must not be called"); });
    controller = new DagEnvironmentController({
      env: {},
      platform: "linux",
      repoRoot,
      statusPath: path.join(tmpDir, "status.json"),
      workerImage: config.workerImage,
      commandRunner: makeRunner({
        inventory: config.inventory,
        inspectMap: config.inspectMap,
      }),
      spawnImpl: spawnSpy as any,
    });
    return controller;
  }

  const cases: Array<{
    name: string;
    workerImage: string;
    inventory: string[];
    inspectMap: Map<string, string>;
    expectStatus: "ready" | "error";
    expectReasonCode?: string;
    expectCompatibility?: string;
    expectSelectedIds?: string[];
    expectImageCount: number;
    expectMergedTags?: string[];
  }> = [
    {
      name: "exact tag match",
      workerImage: "homerail-worker:latest",
      inventory: [inventoryRow({ repository: "homerail-worker", tag: "latest" })],
      inspectMap: new Map([
        ["homerail-worker:latest", inspectJSON({ tags: ["homerail-worker:latest"], labels: currentLabels() })],
      ]),
      expectStatus: "ready",
      expectCompatibility: "current",
      expectSelectedIds: [IMAGE_ID],
      expectImageCount: 1,
    },
    {
      name: "full image ID match",
      workerImage: IMAGE_ID,
      inventory: [inventoryRow({ id: IMAGE_ID })],
      inspectMap: new Map([
        [IMAGE_ID, inspectJSON({ id: IMAGE_ID, tags: null, digests: null, labels: currentLabels() })],
      ]),
      expectStatus: "ready",
      expectCompatibility: "current",
      expectSelectedIds: [IMAGE_ID],
      expectImageCount: 1,
    },
    {
      name: "exact RepoDigest match",
      workerImage: FULL_DIGEST,
      inventory: [inventoryRow({ id: IMAGE_ID })],
      inspectMap: new Map([
        [FULL_DIGEST, inspectJSON({ id: IMAGE_ID, tags: null, digests: [FULL_DIGEST], labels: currentLabels() })],
      ]),
      expectStatus: "ready",
      expectCompatibility: "current",
      expectSelectedIds: [IMAGE_ID],
      expectImageCount: 1,
    },
    {
      name: "duplicate inspection objects merge tags and selection",
      workerImage: "homerail-worker:tag-a",
      inventory: [
        inventoryRow({ repository: "homerail-worker", tag: "tag-a" }),
        inventoryRow({ repository: "homerail-worker", tag: "tag-b" }),
      ],
      inspectMap: new Map([
        ["homerail-worker:tag-a", inspectJSON({ id: IMAGE_ID, tags: ["homerail-worker:tag-a"], labels: currentLabels() })],
        ["homerail-worker:tag-b", inspectJSON({ id: IMAGE_ID, tags: ["homerail-worker:tag-b"], labels: currentLabels() })],
      ]),
      expectStatus: "ready",
      expectCompatibility: "current",
      expectSelectedIds: [IMAGE_ID],
      expectImageCount: 1,
      expectMergedTags: ["homerail-worker:tag-a", "homerail-worker:tag-b"],
    },
    {
      name: "missing configured reference",
      workerImage: "homerail-worker:missing",
      inventory: [inventoryRow({ repository: "homerail-worker", tag: "other" })],
      inspectMap: new Map([
        ["homerail-worker:other", inspectJSON({ id: "sha256:otherid", tags: ["homerail-worker:other"], labels: currentLabels() })],
      ]),
      expectStatus: "error",
      expectReasonCode: "worker_image_missing",
      expectImageCount: 1,
    },
    {
      name: "ID prefix does not select",
      workerImage: "sha256:aaaa",
      inventory: [inventoryRow({ id: IMAGE_ID })],
      inspectMap: new Map([
        ["sha256:aaaa", inspectJSON({ id: IMAGE_ID, tags: null, labels: currentLabels() })],
      ]),
      expectStatus: "error",
      expectReasonCode: "worker_image_missing",
      expectImageCount: 1,
    },
    {
      name: "digest prefix does not select",
      workerImage: "homerail-worker@sha256:1111",
      inventory: [inventoryRow({ id: IMAGE_ID })],
      inspectMap: new Map([
        ["homerail-worker@sha256:1111", inspectJSON({ id: IMAGE_ID, tags: null, digests: [FULL_DIGEST], labels: currentLabels() })],
      ]),
      expectStatus: "error",
      expectReasonCode: "worker_image_missing",
      expectImageCount: 1,
    },
    {
      name: "stale image by ID",
      workerImage: IMAGE_ID,
      inventory: [inventoryRow({ id: IMAGE_ID })],
      inspectMap: new Map([
        [IMAGE_ID, inspectJSON({ id: IMAGE_ID, tags: null, labels: staleLabels() })],
      ]),
      expectStatus: "error",
      expectReasonCode: "worker_image_stale",
      expectCompatibility: "stale",
      expectSelectedIds: [IMAGE_ID],
      expectImageCount: 1,
    },
    {
      name: "incompatible image by digest",
      workerImage: FULL_DIGEST,
      inventory: [inventoryRow({ id: IMAGE_ID })],
      inspectMap: new Map([
        [FULL_DIGEST, inspectJSON({ id: IMAGE_ID, tags: null, digests: [FULL_DIGEST], labels: incompatibleLabels() })],
      ]),
      expectStatus: "error",
      expectReasonCode: "worker_image_incompatible",
      expectCompatibility: "incompatible",
      expectSelectedIds: [IMAGE_ID],
      expectImageCount: 1,
    },
  ];

  it.each(cases)("$name", async (tc) => {
    const ctrl = createController({
      workerImage: tc.workerImage,
      inventory: tc.inventory,
      inspectMap: tc.inspectMap,
    });
    const status = await ctrl.check();

    expect(status.docker.status).toBe("ready");
    expect(status.worker_image.status).toBe(tc.expectStatus);
    if (tc.expectReasonCode) {
      expect(status.worker_image.reason_code).toBe(tc.expectReasonCode);
    }
    if (tc.expectCompatibility) {
      expect(status.worker_image.compatibility).toBe(tc.expectCompatibility);
    }
    expect(status.images.length).toBe(tc.expectImageCount);
    if (tc.expectSelectedIds) {
      const selectedIds = status.images.filter((i) => i.selected).map((i) => i.id);
      expect(selectedIds).toEqual(expect.arrayContaining(tc.expectSelectedIds));
    } else {
      expect(status.images.every((i) => !i.selected)).toBe(true);
    }
    if (tc.expectMergedTags) {
      const img = status.images.find((i) => i.id === IMAGE_ID);
      expect(img).toBeDefined();
      expect([...img!.tags].sort()).toEqual([...tc.expectMergedTags].sort());
    }
    expect(status.build).toBeUndefined();
  });

  it("spawn is never called", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dag-env-id-"));
    tempDirs.push(tmpDir);
    const spawnSpy = vi.fn(() => { throw new Error("must not spawn"); });
    const ctrl = new DagEnvironmentController({
      env: {},
      platform: "linux",
      repoRoot,
      statusPath: path.join(tmpDir, "status.json"),
      workerImage: IMAGE_ID,
      commandRunner: makeRunner({
        inventory: [inventoryRow({ id: IMAGE_ID })],
        inspectMap: new Map([
          [IMAGE_ID, inspectJSON({ id: IMAGE_ID, tags: null, labels: currentLabels() })],
        ]),
      }),
      spawnImpl: spawnSpy as any,
    });
    await ctrl.check();
    expect(spawnSpy).not.toHaveBeenCalled();
    ctrl.shutdown();
  });
});
