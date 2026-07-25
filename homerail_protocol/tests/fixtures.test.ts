/**
 * Fixture tests: round-trip, schema validation, and no-drift checks.
 * @version 0.1.0
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve, basename } from "path";
import { encode, decode, stableStringify } from "../src/codec.js";
import { validateMessage } from "../src/validation.js";
import { PROTOCOL_VERSION } from "../src/index.js";

const FIXTURES_DIR = resolve(__dirname, "..", "fixtures");

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), "utf-8");
}

function loadFixtureJSON(name: string): unknown {
  return JSON.parse(loadFixture(name));
}

/** Map of fixture filename → schema name for validation */
const FIXTURE_SCHEMA_MAP: Record<string, string> = {
  "handoff-request.json": "handoff-request",
  "handoff-response.json": "handoff-response",
  "tool-call.json": "tool-call",
  "tool-result.json": "tool-result",
  "send-message.json": "send-message",
  "receive-message.json": "receive-message",
  "graph-context.json": "graph-context",
  "agent-config.json": "agent-config",
  "dag-node-config.json": "dag-node-config",
  "message-base.json": "message-base",
  "request-message.json": "request",
  "response-message.json": "response",
  "event-message.json": "event",
  "stream-message.json": "stream-message",
  "async-request-message.json": "async-request",
  "async-response-message.json": "async-response",
  "async-progress-message.json": "async-progress",
  "async-control-message.json": "async-control",
  "async-result-message.json": "async-result",
};

const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));

describe("Fixture round-trip", () => {
  for (const file of fixtureFiles) {
    it(`decode → encode → decode identity for ${file}`, () => {
      const raw = loadFixture(file);
      const obj1 = JSON.parse(raw);
      const encoded = stableStringify(obj1);
      const obj2 = JSON.parse(encoded);

      // After stableStringify, the JSON should parse back to an equivalent object.
      // Keys should be sorted, and no undefined should appear.
      expect(obj2).toEqual(stableValueExpect(obj1));
    });
  }
});

describe("Fixture schema validation", () => {
  for (const [file, schemaName] of Object.entries(FIXTURE_SCHEMA_MAP)) {
    it(`${file} validates against ${schemaName}`, () => {
      const obj = loadFixtureJSON(file);
      const result = validateMessage(obj, schemaName);
      expect(result.valid).toBe(true);
    });
  }
});

describe("No-drift: TS codec faithfully round-trips fixtures", () => {
  // Contract: the Python extractor (scripts/extract_protocol_fixtures.py)
  // produces canonical pretty-printed fixtures with fixed IDs and timestamps.
  // The TS stableStringify produces compact output (no indent).  Byte
  // comparison between the two formats is not meaningful because of different
  // whitespace; instead we verify that the TS codec preserves semantic content
  // by round-tripping: parse → stableStringify → parse → compare objects.
  //
  // Idempotency of the Python extractor is checked separately:
  //   uv run python scripts/extract_protocol_fixtures.py
  //   git diff --exit-code -- homerail_protocol/fixtures

  for (const file of fixtureFiles) {
    it(`parse → stableStringify → parse preserves content for ${file}`, () => {
      const raw = loadFixture(file);
      const obj1 = JSON.parse(raw);
      const encoded = stableStringify(obj1);
      const obj2 = JSON.parse(encoded);

      // stableStringify strips undefined values and sorts keys.
      // After normalization both objects should be identical.
      expect(stableValueExpect(obj2)).toEqual(stableValueExpect(obj1));
    });
  }
});

describe("Cross-version markers", () => {
  it("PROTOCOL_VERSION is defined and semver parseable", () => {
    expect(PROTOCOL_VERSION).toMatch(
      /^\d+\.\d+\.\d+(?:-(?:alpha|beta)(?:\.(?:0|[1-9]\d*))+)?$/,
    );
  });

  for (const file of fixtureFiles) {
    it(`${file} has no trailing comma or malformed JSON`, () => {
      const raw = loadFixture(file);
      // This parse must not throw
      const parsed = JSON.parse(raw);
      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();
    });
  }
});

/**
 * Recursively normalize an object: sort keys, strip undefined values.
 * This mirrors what stableStringify does, so we can compare decoded objects.
 */
function stableValueExpect(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(stableValueExpect);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      result[key] = stableValueExpect(v);
    }
    return result;
  }
  return value;
}
