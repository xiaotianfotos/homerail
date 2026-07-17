import { describe, expect, it } from "vitest";
import { envelopeActivityToDagConfig } from "../envelope-activity.js";

describe("dispatch envelope activity", () => {
  it("preserves both activity and Actor Surface sequence cursors across rounds", () => {
    expect(envelopeActivityToDagConfig({
      roundId: "round-0002",
      actorId: "research",
      generation: 2,
      leaseGeneration: 4,
      commandId: "command-1",
      surfaceId: "actor:research",
      sequenceStart: 12,
      surfacePatchSequenceStart: 3,
      surfaceReportingComplete: true,
    })).toEqual({
      round_id: "round-0002",
      actor_id: "research",
      generation: 2,
      lease_generation: 4,
      command_id: "command-1",
      surface_id: "actor:research",
      activity_sequence_start: 12,
      surface_patch_sequence_start: 3,
      surface_reporting_complete: true,
    });
  });

  it("fails closed to zero cursors for malformed activity", () => {
    expect(envelopeActivityToDagConfig({
      sequenceStart: -1,
      surfacePatchSequenceStart: Number.NaN,
      surfaceReportingComplete: "yes",
    })).toMatchObject({
      activity_sequence_start: 0,
      surface_patch_sequence_start: 0,
      surface_reporting_complete: false,
    });
  });
});
