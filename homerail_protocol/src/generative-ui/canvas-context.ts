/**
 * Bounded, read-only canvas state supplied to a Manager Agent turn.
 * @version 0.1.0
 */

import type {
  GenerativeUiCanvasSize,
  GenerativeUiSurface,
} from "./types.js";
import type { HomerailViewSpecV1 } from "./view-spec.js";

export const GENERATIVE_UI_CANVAS_CONTEXT_VERSION = 1 as const;
export const GENERATIVE_UI_CANVAS_CONTEXT_MAX_NODES = 8;
export const GENERATIVE_UI_CANVAS_CONTEXT_MAX_BYTES = 48 * 1024;

export interface GenerativeUiCanvasContextNodeV1 {
  id: string;
  revision: number;
  kind: string;
  surface: GenerativeUiSurface;
  title: string;
  summary?: string;
  canvas_size?: GenerativeUiCanvasSize;
  selected: boolean;
  content: Record<string, unknown>;
  view?: HomerailViewSpecV1;
  content_truncated?: boolean;
}

export interface GenerativeUiCanvasContextV1 {
  canvas_context_version: 1;
  document_id: string;
  document_revision: number;
  selected_node_id?: string;
  nodes: GenerativeUiCanvasContextNodeV1[];
}
