/**
 * Bounded media blobs transported from a fenced DAG Actor to the Manager.
 * @version 1
 */

export const DAG_ACTOR_SURFACE_MEDIA_SCHEMA_VERSION = 1 as const;
export const DAG_ACTOR_SURFACE_MEDIA_V1_SCHEMA_ID = "dag-actor-surface-media-v1" as const;
export const DAG_ACTOR_SURFACE_MEDIA_MAX_BYTES = 4 * 1024 * 1024;
export const DAG_ACTOR_SURFACE_MEDIA_MAX_BASE64_CHARS = Math.ceil(DAG_ACTOR_SURFACE_MEDIA_MAX_BYTES / 3) * 4;

export const DAG_ACTOR_SURFACE_MEDIA_TYPES = [
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
] as const;

export type DagActorSurfaceMediaTypeV1 = (typeof DAG_ACTOR_SURFACE_MEDIA_TYPES)[number];

export const DAG_ACTOR_SURFACE_MEDIA_EXTENSIONS: Readonly<Record<DagActorSurfaceMediaTypeV1, string>> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "weba",
};

export interface DagActorSurfaceMediaV1 {
  schema_version: typeof DAG_ACTOR_SURFACE_MEDIA_SCHEMA_VERSION;
  run_id: string;
  node_id: string;
  session_id: string;
  round_id: string;
  actor_id: string;
  generation: number;
  lease_generation: number;
  artifact_name: string;
  media_type: DagActorSurfaceMediaTypeV1;
  size_bytes: number;
  sha256: string;
  content_base64: string;
}

const identifierSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^(?!\\s*$)[^\\u0000-\\u001F\\u007F]+$",
} as const;

export const dagActorSurfaceMediaV1Schema = {
  $id: DAG_ACTOR_SURFACE_MEDIA_V1_SCHEMA_ID,
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    schema_version: { type: "integer", const: DAG_ACTOR_SURFACE_MEDIA_SCHEMA_VERSION },
    run_id: identifierSchema,
    node_id: identifierSchema,
    session_id: identifierSchema,
    round_id: identifierSchema,
    actor_id: identifierSchema,
    generation: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    lease_generation: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    artifact_name: {
      type: "string",
      pattern: "^actor-media-[0-9a-f]{64}\\.(?:avif|gif|jpg|png|webp|mp4|webm|mp3|m4a|ogg|wav|weba)$",
      maxLength: 96,
    },
    media_type: { type: "string", enum: DAG_ACTOR_SURFACE_MEDIA_TYPES },
    size_bytes: { type: "integer", minimum: 1, maximum: DAG_ACTOR_SURFACE_MEDIA_MAX_BYTES },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    content_base64: {
      type: "string",
      minLength: 4,
      maxLength: DAG_ACTOR_SURFACE_MEDIA_MAX_BASE64_CHARS,
      pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
    },
  },
  required: [
    "schema_version",
    "run_id",
    "node_id",
    "session_id",
    "round_id",
    "actor_id",
    "generation",
    "lease_generation",
    "artifact_name",
    "media_type",
    "size_bytes",
    "sha256",
    "content_base64",
  ],
  additionalProperties: false,
} as const;
