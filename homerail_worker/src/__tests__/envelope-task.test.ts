import { describe, expect, it } from "vitest";
import {
  envelopeInputsToTaskText,
  envelopeOutputContractsToSystemPrompt,
} from "../envelope-task.js";

describe("envelope task text", () => {
  it("serializes object handoff inputs as readable JSON sections", () => {
    const text = envelopeInputsToTaskText({
      source_audit: [
        {
          source_audit: "PASS",
          evidence: { public_head: "abc123", failures: [] },
        },
      ],
      build_audit: ["build ok"],
    });

    expect(text).toContain("## input:source_audit");
    expect(text).toContain('"source_audit": "PASS"');
    expect(text).toContain('"public_head": "abc123"');
    expect(text).toContain("## input:build_audit\nbuild ok");
    expect(text).not.toContain("[object Object]");
  });

  it("renders trusted exact output contracts before the first handoff", () => {
    const text = envelopeOutputContractsToSystemPrompt({
      reviewed: {
        contract: "ReviewDecision",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["verdict", "findings"],
          properties: {
            verdict: { enum: ["approve", "changes_requested"] },
            findings: { type: "array" },
          },
        },
      },
    });

    expect(text).toContain("trusted control-plane instructions");
    expect(text).toContain("Exact output contracts by port");
    expect(text).toContain('"contract": "ReviewDecision"');
    expect(text).toContain('"additionalProperties": false');
    expect(envelopeOutputContractsToSystemPrompt(undefined)).toBe("");
  });
});
