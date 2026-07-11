/**
 * JSON Schema definitions (Draft-07) for all protocol message types.
 * @version 0.1.0
 */

import {
  generativeUiSchemas,
} from "./generative-ui/schemas.js";
import { homerailPluginSchemas } from "./plugins/schemas.js";

// ── DAG Tool Schemas ─────────────────────────────────────────────

export const handoffRequestSchema = {
  $id: "handoff-request",
  type: "object" as const,
  properties: {
    port: { type: "string" },
    content: {},
    summary: { type: "string", nullable: true as const },
  },
  required: ["port", "content"],
  additionalProperties: true,
};

export const handoffResponseSchema = {
  $id: "handoff-response",
  type: "object",
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["text", "tool_use", "tool_result", "image", "error"] },
          text: { type: "string", nullable: true as const },
          id: { type: "string", nullable: true as const },
          name: { type: "string", nullable: true as const },
          input: { type: "object", nullable: true as const },
          tool_use_id: { type: "string", nullable: true as const },
          content: {},
          is_error: { type: "boolean", nullable: true as const },
        },
        required: ["type"],
        additionalProperties: true,
      },
    },
    is_error: { type: "boolean", nullable: true as const },
  },
  required: ["content"],
  additionalProperties: true,
};

export const toolCallSchema = {
  $id: "tool-call",
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    input_schema: { type: "object" },
  },
  required: ["name", "description", "input_schema"],
  additionalProperties: true,
};

export const toolResultSchema = {
  $id: "tool-result",
  type: "object",
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          text: { type: "string", nullable: true as const },
        },
        required: ["type"],
        additionalProperties: true,
      },
    },
    is_error: { type: "boolean", nullable: true as const },
  },
  required: ["content"],
  additionalProperties: true,
};

export const sendMessageSchema = {
  $id: "send-message",
  type: "object" as const,
  properties: {
    to_node: { type: "string" },
    content: {},
  },
  required: ["to_node", "content"],
  additionalProperties: true,
};

export const receiveMessageSchema = {
  $id: "receive-message",
  type: "object" as const,
  properties: {
    timeout: { type: "integer", nullable: true as const },
  },
  additionalProperties: true,
};

export const graphContextSchema = {
  $id: "graph-context",
  type: "object",
  properties: {
    node_id: { type: "string" },
    predecessors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          node: { type: "string" },
          from_port: { type: "string" },
          to_port: { type: "string" },
        },
        required: ["node", "from_port", "to_port"],
      },
    },
    successors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          node: { type: "string" },
          from_port: { type: "string" },
          to_port: { type: "string" },
        },
        required: ["node", "from_port", "to_port"],
      },
    },
    available_ports: { type: "array", items: { type: "string" } },
    graph_nodes: { type: "array", items: { type: "string" } },
  },
  required: ["node_id", "predecessors", "successors", "available_ports", "graph_nodes"],
  additionalProperties: true,
};

// ── Agent config schemas ─────────────────────────────────────────

export const agentConfigSchema = {
  $id: "agent-config",
  type: "object",
  properties: {
    api_key: { type: "string" },
    base_url: { type: "string" },
    model: { type: "string" },
    workspace: { type: "string" },
    system_prompt: { type: "string", nullable: true as const },
    system_prompt_mode: { type: "string" },
    additional_prompt: { type: "string", nullable: true as const },
    api_timeout_ms: { type: "integer" },
    mcp_server_name: { type: "string" },
    mcp_stdio_module: { type: "string" },
    enable_monitoring_hooks: { type: "boolean" },
    mcp_servers: { type: "object" },
    extra: { type: "object" },
    metadata: { type: "object" },
  },
  required: ["api_key", "base_url", "model", "workspace"],
  additionalProperties: true,
};

export const dagNodeConfigSchema = {
  $id: "dag-node-config",
  type: "object",
  properties: {
    node_id: { type: "string" },
    agent_type: { type: "string" },
    model: { type: "string" },
    outgoing_edges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from_port: { type: "string" },
          to_port: { type: "string" },
        },
        required: ["from_port", "to_port"],
        additionalProperties: true,
      },
    },
    incoming_edges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from_port: { type: "string" },
          to_port: { type: "string" },
        },
        required: ["from_port", "to_port"],
        additionalProperties: true,
      },
    },
    graph_nodes: { type: "array", items: { type: "string" } },
    session_id: { type: "string", nullable: true as const },
  },
  required: ["node_id", "agent_type", "model", "outgoing_edges", "incoming_edges", "graph_nodes"],
  additionalProperties: true,
};

// ── Protocol message schemas ─────────────────────────────────────

export const messageBaseSchema = {
  $id: "message-base",
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    timestamp: { type: "string" },
    data: { type: "object" },
  },
  required: ["id", "type", "timestamp"],
  additionalProperties: true,
};

export const requestSchema = {
  $id: "request",
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", const: "request" },
    timestamp: { type: "string" },
    data: { type: "object" },
    resource_type: { type: "string" },
    operation: { type: "string" },
    resource_id: { type: "string", nullable: true as const },
    spec: { type: "object" },
    timeout: { type: "number", nullable: true as const },
  },
  required: ["id", "type", "timestamp", "resource_type", "operation"],
  additionalProperties: true,
};

export const responseSchema = {
  $id: "response",
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", const: "response" },
    timestamp: { type: "string" },
    data: { type: "object" },
    request_id: { type: "string" },
    status: { type: "string" },
    resource_data: { type: "object", nullable: true as const },
    error: { type: "object", nullable: true as const },
    execution_time: { type: "number", nullable: true as const },
  },
  required: ["id", "type", "timestamp", "request_id", "status"],
  additionalProperties: true,
};

export const eventSchema = {
  $id: "event",
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", const: "event" },
    timestamp: { type: "string" },
    data: { type: "object" },
    event_type: { type: "string", nullable: true as const },
    resource_type: { type: "string", nullable: true as const },
    resource_id: { type: "string", nullable: true as const },
    metadata: { type: "object" },
  },
  required: ["id", "type", "timestamp"],
  additionalProperties: true,
};

export const streamMessageSchema = {
  $id: "stream-message",
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", const: "stream" },
    timestamp: { type: "string" },
    data: { type: "object" },
    request_id: { type: "string" },
    sequence: { type: "integer" },
    finished: { type: "boolean" },
    chunk: { type: "object", nullable: true as const },
    error: { type: "object", nullable: true as const },
  },
  required: ["id", "type", "timestamp", "request_id", "sequence"],
  additionalProperties: true,
};

export const asyncRequestSchema = {
  $id: "async-request",
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", const: "async_request" },
    timestamp: { type: "string" },
    data: { type: "object" },
    resource_type: { type: "string" },
    operation: { type: "string" },
    resource_id: { type: "string", nullable: true as const },
    spec: { type: "object" },
    target_node_id: { type: "string", nullable: true as const },
    timeout: { type: "number", nullable: true as const },
    priority: { type: "string" },
    callback_url: { type: "string", nullable: true as const },
    parameters: { type: "object" },
  },
  required: ["id", "type", "timestamp", "resource_type", "operation"],
  additionalProperties: true,
};

export const asyncResponseSchema = {
  $id: "async-response",
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", const: "async_response" },
    timestamp: { type: "string" },
    data: { type: "object" },
    request_id: { type: "string" },
    operation_id: { type: "string" },
    status: { type: "string" },
    estimated_duration: { type: "number", nullable: true as const },
    queue_position: { type: "integer", nullable: true as const },
    error: { type: "object", nullable: true as const },
  },
  required: ["id", "type", "timestamp", "request_id", "operation_id", "status"],
  additionalProperties: true,
};

export const asyncProgressSchema = {
  $id: "async-progress",
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", const: "async_progress" },
    timestamp: { type: "string" },
    data: { type: "object" },
    operation_id: { type: "string" },
    progress_percentage: { type: "number" },
    current_stage: { type: "string" },
    message: { type: "string", nullable: true as const },
    details: { type: "object" },
    estimated_remaining: { type: "number", nullable: true as const },
  },
  required: ["id", "type", "timestamp", "operation_id", "progress_percentage", "current_stage"],
  additionalProperties: true,
};

export const asyncControlSchema = {
  $id: "async-control",
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", const: "async_control" },
    timestamp: { type: "string" },
    data: { type: "object" },
    operation_id: { type: "string" },
    control_action: { type: "string" },
    reason: { type: "string", nullable: true as const },
    force: { type: "boolean" },
  },
  required: ["id", "type", "timestamp", "operation_id", "control_action"],
  additionalProperties: true,
};

export const asyncResultSchema = {
  $id: "async-result",
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", const: "event" },
    timestamp: { type: "string" },
    data: { type: "object" },
    event_type: { type: "string" },
    operation_id: { type: "string" },
    request_id: { type: "string" },
    status: { type: "string" },
    result_data: { type: "object" },
    error: { type: "object", nullable: true as const },
    execution_time: { type: "number", nullable: true as const },
    metrics: { type: "object" },
  },
  required: ["id", "type", "timestamp", "operation_id", "request_id", "status"],
  additionalProperties: true,
};

/** All schemas indexed by name for validator registration */
export const allSchemas: Record<string, Record<string, unknown>> = {
  ...generativeUiSchemas,
  ...homerailPluginSchemas,
  "handoff-request": handoffRequestSchema as Record<string, unknown>,
  "handoff-response": handoffResponseSchema as Record<string, unknown>,
  "tool-call": toolCallSchema as Record<string, unknown>,
  "tool-result": toolResultSchema as Record<string, unknown>,
  "send-message": sendMessageSchema as Record<string, unknown>,
  "receive-message": receiveMessageSchema as Record<string, unknown>,
  "graph-context": graphContextSchema,
  "agent-config": agentConfigSchema,
  "dag-node-config": dagNodeConfigSchema,
  "message-base": messageBaseSchema,
  request: requestSchema,
  response: responseSchema,
  event: eventSchema,
  "stream-message": streamMessageSchema,
  "async-request": asyncRequestSchema,
  "async-response": asyncResponseSchema,
  "async-progress": asyncProgressSchema,
  "async-control": asyncControlSchema,
  "async-result": asyncResultSchema,
};
