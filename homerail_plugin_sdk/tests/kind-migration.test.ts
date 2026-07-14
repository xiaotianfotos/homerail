import { describe, expect, it } from "vitest";
import { canonicalHrpJsonBytes } from "../src/archive.js";
import {
  applyHomerailKindMigrationV1,
  parseHomerailKindMigrationV1,
} from "../src/kind-migration.js";

function bytes(operations: unknown[]) {
  return canonicalHrpJsonBytes({
    migration_version: 1,
    type: "declarative_kind_content",
    from: 1,
    to: 2,
    operations,
  });
}

describe("declarative Kind migration DSL", () => {
  it("renames, defaults, and removes bounded object fields deterministically", () => {
    const migration = parseHomerailKindMigrationV1(bytes([
      { op: "rename", from: "/title", path: "/heading" },
      { op: "set_default", path: "/format", value: "markdown" },
      { op: "remove", path: "/legacy" },
    ]), { from: 1, to: 2 });
    const input = { title: "Release", legacy: true, nested: { keep: 1 } };
    expect(applyHomerailKindMigrationV1(input, migration)).toEqual({
      heading: "Release",
      format: "markdown",
      nested: { keep: 1 },
    });
    expect(input).toEqual({ title: "Release", legacy: true, nested: { keep: 1 } });
  });

  it("rejects noncanonical, extra, executable, URL, prototype, and mismatched declarations", () => {
    expect(() => parseHomerailKindMigrationV1(Buffer.from(JSON.stringify({
      migration_version: 1,
      type: "declarative_kind_content",
      from: 1,
      to: 2,
      operations: [{ op: "remove", path: "/legacy" }],
    })))).toThrow(/canonical JSON/);
    expect(() => parseHomerailKindMigrationV1(bytes([
      { op: "remove", path: "/legacy", command: "rm" },
    ]))).toThrow(/exact keys/);
    expect(() => parseHomerailKindMigrationV1(bytes([
      { op: "set_default", path: "/link", value: "https://example.com" },
    ]))).toThrow(/URL/);
    expect(() => parseHomerailKindMigrationV1(bytes([
      { op: "set_default", path: "/constructor", value: "unsafe" },
    ]))).toThrow(/unsafe/);
    expect(() => parseHomerailKindMigrationV1(bytes([
      { op: "set_default", path: "/metadata", value: { script: "alert(1)" } },
    ]))).toThrow(/forbidden field/);
    expect(() => parseHomerailKindMigrationV1(bytes([
      { op: "remove", path: "/legacy" },
    ]), { from: 2, to: 3 })).toThrow(/identity/);
  });

  it("fails safely on missing parents and rename collisions", () => {
    const missing = parseHomerailKindMigrationV1(bytes([
      { op: "set_default", path: "/missing/value", value: 1 },
    ]));
    expect(() => applyHomerailKindMigrationV1({}, missing)).toThrow(/parent does not exist/);

    const collision = parseHomerailKindMigrationV1(bytes([
      { op: "rename", from: "/title", path: "/heading" },
    ]));
    expect(() => applyHomerailKindMigrationV1({ title: "a", heading: "b" }, collision))
      .toThrow(/target already exists/);
  });
});
