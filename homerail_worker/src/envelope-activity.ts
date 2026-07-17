import type { DagNodeConfig } from "homerail-protocol";

export type EnvelopeActivityDagConfig = Pick<
  DagNodeConfig,
  | "round_id"
  | "actor_id"
  | "generation"
  | "lease_generation"
  | "command_id"
  | "surface_id"
  | "activity_sequence_start"
  | "surface_patch_sequence_start"
  | "surface_reporting_complete"
>;

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0
    ? field
    : undefined;
}

function booleanField(value: Record<string, unknown>, key: string): boolean | undefined {
  return typeof value[key] === "boolean" ? value[key] : undefined;
}

export function envelopeActivityToDagConfig(activity: unknown): EnvelopeActivityDagConfig {
  const value = activity && typeof activity === "object" && !Array.isArray(activity)
    ? activity as Record<string, unknown>
    : {};
  return {
    round_id: stringField(value, "roundId"),
    actor_id: stringField(value, "actorId"),
    generation: numberField(value, "generation"),
    lease_generation: numberField(value, "leaseGeneration"),
    command_id: stringField(value, "commandId"),
    surface_id: stringField(value, "surfaceId"),
    activity_sequence_start: numberField(value, "sequenceStart") ?? 0,
    surface_patch_sequence_start: numberField(value, "surfacePatchSequenceStart") ?? 0,
    surface_reporting_complete: booleanField(value, "surfaceReportingComplete") ?? false,
  };
}
