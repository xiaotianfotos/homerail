import { describe, expect, it } from "vitest";

import {
  GENERATIVE_UI_COMPOSITION_VERSION,
  GenerativeUiAttention,
  GenerativeUiDensity,
  GenerativeUiDevice,
  GenerativeUiInputModality,
  GenerativeUiPlacement,
  GenerativeUiSurface,
  GenerativeUiViewport,
  GenerativeUiVisibility,
  validateGenerativeUiComposition,
  validateGenerativeUiCompositionContext,
  type GenerativeUiCompositionV1,
} from "../src/generative-ui/index.js";

function composition(): GenerativeUiCompositionV1 {
  return {
    composition_version: GENERATIVE_UI_COMPOSITION_VERSION,
    document_id: "voice-session-ui",
    document_revision: 2,
    context: {
      device: GenerativeUiDevice.DESKTOP,
      input: GenerativeUiInputModality.MOUSE,
      viewport: GenerativeUiViewport.WIDE,
      attention: GenerativeUiAttention.FOCUSED,
      surface_capacities: { task: 4, result: 6 },
    },
    items: [{
      node_id: "task-summary",
      node_revision: 1,
      surface: GenerativeUiSurface.TASK,
      variant: GenerativeUiDensity.SUMMARY,
      rank: 1,
      placement: GenerativeUiPlacement.PRIMARY,
      pinned: false,
      visibility: GenerativeUiVisibility.VISIBLE,
    }],
    hidden_node_ids: ["ambient-hidden"],
  };
}

describe("Generative UI composition protocol", () => {
  it("validates the strict versioned projection contract", () => {
    expect(validateGenerativeUiComposition(composition())).toEqual({
      valid: true,
      value: composition(),
      errors: [],
    });
    expect(validateGenerativeUiCompositionContext(composition().context).valid).toBe(true);
  });

  it("rejects unknown context fields and unbounded capacities", () => {
    expect(validateGenerativeUiCompositionContext({
      ...composition().context,
      plugin_layout: "freeform",
    }).valid).toBe(false);
    expect(validateGenerativeUiCompositionContext({
      ...composition().context,
      surface_capacities: { task: 129 },
    }).valid).toBe(false);
  });

  it("requires contiguous ranks and disjoint visible/hidden partitions", () => {
    const invalid = composition();
    invalid.items[0].rank = 2;
    invalid.hidden_node_ids.push("task-summary");
    expect(validateGenerativeUiComposition(invalid).errors.map((error) => error.keyword))
      .toEqual(expect.arrayContaining(["compositionRank", "compositionPartition"]));
  });
});
