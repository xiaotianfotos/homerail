/**
 * Durable Worker Activity Event contract.
 * @version 0.1.0
 */

export const DAG_ACTIVITY_EVENT_SCHEMA_VERSION = 1 as const;
export const DAG_ACTIVITY_EVENT_V1_SCHEMA_ID = "dag-activity-event-v1" as const;

export const DAG_ACTIVITY_TYPES = [
  "started",
  "progress",
  "finding",
  "tool_used",
  "blocked",
  "completed",
  "failed",
] as const;

export type DagActivityType = (typeof DAG_ACTIVITY_TYPES)[number];

export type DagActivityJsonPrimitive = string | number | boolean | null;
export type DagActivityJsonValue =
  | DagActivityJsonPrimitive
  | DagActivityJsonValue[]
  | { [key: string]: DagActivityJsonValue };
export type DagActivityPayload = Record<string, DagActivityJsonValue>;

/**
 * Versioned, append-only activity emitted by one logical DAG actor generation.
 * `sequence` is strictly increasing within `(run_id, actor_id, generation)`.
 */
export interface DagActivityEventV1 {
  schema_version: typeof DAG_ACTIVITY_EVENT_SCHEMA_VERSION;
  event_id: string;
  run_id: string;
  round_id: string;
  node_id: string;
  actor_id: string;
  generation: number;
  /** Physical Worker lease generation; required by transport-fence v2. */
  lease_generation?: number;
  surface_id?: string;
  sequence: number;
  /** Unix epoch milliseconds assigned at the activity source. */
  timestamp: number;
  type: DagActivityType;
  payload: DagActivityPayload;
}

const identifierSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
} as const;

const jsonValueSchema = {
  oneOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    {
      type: "array",
      items: { $ref: "#/definitions/jsonValue" },
    },
    {
      type: "object",
      additionalProperties: { $ref: "#/definitions/jsonValue" },
    },
  ],
} as const;

export const dagActivityEventV1Schema = {
  $id: DAG_ACTIVITY_EVENT_V1_SCHEMA_ID,
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  definitions: {
    jsonValue: jsonValueSchema,
  },
  properties: {
    schema_version: { type: "integer", const: DAG_ACTIVITY_EVENT_SCHEMA_VERSION },
    event_id: identifierSchema,
    run_id: identifierSchema,
    round_id: identifierSchema,
    node_id: identifierSchema,
    actor_id: identifierSchema,
    generation: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    lease_generation: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    surface_id: identifierSchema,
    sequence: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    timestamp: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    type: { type: "string", enum: DAG_ACTIVITY_TYPES },
    payload: {
      type: "object",
      additionalProperties: { $ref: "#/definitions/jsonValue" },
    },
  },
  required: [
    "schema_version",
    "event_id",
    "run_id",
    "round_id",
    "node_id",
    "actor_id",
    "generation",
    "sequence",
    "timestamp",
    "type",
    "payload",
  ],
  additionalProperties: false,
} as const;
