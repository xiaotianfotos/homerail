/**
 * Immutable DAG run input contracts.
 * @version 0.1.0
 */

export const DAG_RUN_INPUT_MEDIA_TYPES = [
  "text/markdown",
  "text/plain",
  "application/json",
] as const;

export type DagRunInputMediaType = (typeof DAG_RUN_INPUT_MEDIA_TYPES)[number];

export interface StageDagRunInputRequest {
  scope_id: string;
  name: string;
  media_type: DagRunInputMediaType;
  content: string;
}

export interface DagRunInputArtifactDescriptor {
  artifact_id: string;
  scope_id: string;
  name: string;
  media_type: DagRunInputMediaType;
  sha256: string;
  size_bytes: number;
  created_at: number;
}

export interface DagRunInputBindingRequest {
  artifact_id: string;
  logical_name: string;
  mount_path: string;
}

export interface DagRunInputBinding extends DagRunInputArtifactDescriptor {
  run_id: string;
  logical_name: string;
  mount_path: string;
  bound_at: number;
}

/** Trusted Manager-to-Node projection; never exposed to a model prompt. */
export interface DagWorkspaceInputProjection {
  logical_name: string;
  mount_path: string;
  media_type: DagRunInputMediaType;
  sha256: string;
  size_bytes: number;
  content_base64: string;
}
