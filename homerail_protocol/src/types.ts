/**
 * HomeRail protocol types v0.1.0
 *
 * Single source of truth for all runtime communication types between
 * homerail_worker, homerail_node, and homerail_manager.
 */

// ── Enums ────────────────────────────────────────────────────────

/** @version 0.1.0 */
export const MessageRole = {
  ASSISTANT: "assistant",
  USER: "user",
  SYSTEM: "system",
  RESULT: "result",
} as const;
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

/** @version 0.1.0 */
export const MessageContentType = {
  TEXT: "text",
  TOOL_USE: "tool_use",
  TOOL_RESULT: "tool_result",
  THINKING: "thinking",
  ERROR: "error",
} as const;
export type MessageContentType = (typeof MessageContentType)[keyof typeof MessageContentType];

/** @version 0.1.0 */
export const AgentClientType = {
  CLAUDE: "claude",
  CODEX: "codex",
  CODEX_APPSERVER: "codex_appserver",
  KIMI: "kimi",
  PI_MONO: "pi_mono",
} as const;
export type AgentClientType = (typeof AgentClientType)[keyof typeof AgentClientType];

/** @version 0.1.0 */
export const MessageType = {
  REQUEST: "request",
  RESPONSE: "response",
  EVENT: "event",
  STREAM: "stream",
  ASYNC_REQUEST: "async_request",
  ASYNC_RESPONSE: "async_response",
  ASYNC_PROGRESS: "async_progress",
  ASYNC_CONTROL: "async_control",
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** @version 0.1.0 */
export const MessageStatus = {
  PENDING: "pending",
  SUCCESS: "success",
  ERROR: "error",
  TIMEOUT: "timeout",
} as const;
export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];

/** @version 0.1.0 */
export const ResourceType = {
  CONTAINER: "container",
  IMAGE: "image",
  NETWORK: "network",
  VOLUME: "volume",
  NODE: "node",
  AGENT: "agent",
  TEMPLATE: "template",
  BUILD: "build",
  OPERATION: "operation",
  POD: "pod",
  SERVICE: "service",
  DEPLOYMENT: "deployment",
  CONFIGMAP: "configmap",
  SECRET: "secret",
} as const;
export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

/** @version 0.1.0 */
export const Operation = {
  CREATE: "create",
  GET: "get",
  LIST: "list",
  UPDATE: "update",
  DELETE: "delete",
  START: "start",
  STOP: "stop",
  RESTART: "restart",
  PAUSE: "pause",
  UNPAUSE: "unpause",
  EXEC: "exec",
  LOGS: "logs",
  STATS: "stats",
  INSPECT: "inspect",
  PULL: "pull",
  PUSH: "push",
  BUILD: "build",
  TAG: "tag",
  REMOVE: "remove",
  VALIDATE: "validate",
  COMPILE: "compile",
  DEPLOY: "deploy",
  SET_VARIABLES: "set_variables",
  BUILD_START: "build_start",
  BUILD_STOP: "build_stop",
  BUILD_STATUS: "build_status",
  BUILD_LOGS: "build_logs",
  BUILD_PROGRESS: "build_progress",
  ASYNC_START: "async_start",
  ASYNC_STOP: "async_stop",
  ASYNC_STATUS: "async_status",
  ASYNC_PROGRESS: "async_progress",
  ASYNC_CANCEL: "async_cancel",
  INFO: "info",
  STATUS: "status",
  HEALTH: "health",
  CONNECT: "connect",
  DISCONNECT: "disconnect",
  SPAWN: "spawn",
  TERMINATE: "terminate",
  COMMAND: "command",
  STREAM: "stream",
  PING: "ping",
  VERSION: "version",
  CAPABILITIES: "capabilities",
} as const;
export type Operation = (typeof Operation)[keyof typeof Operation];

/** @version 0.1.0 */
export const EventType = {
  CREATED: "created",
  UPDATED: "updated",
  DELETED: "deleted",
  STARTED: "started",
  STOPPED: "stopped",
  FAILED: "failed",
  STATUS_CHANGED: "status_changed",
  HEALTH_CHANGED: "health_changed",
  PROGRESS_CHANGED: "progress_changed",
  TEMPLATE_VALIDATED: "template_validated",
  TEMPLATE_VALIDATION_FAILED: "template_validation_failed",
  TEMPLATE_DEPLOYED: "template_deployed",
  BUILD_STARTED: "build_started",
  BUILD_COMPLETED: "build_completed",
  BUILD_FAILED: "build_failed",
  BUILD_CANCELLED: "build_cancelled",
  BUILD_PROGRESS: "build_progress",
  OPERATION_QUEUED: "operation_queued",
  OPERATION_STARTED: "operation_started",
  OPERATION_COMPLETED: "operation_completed",
  OPERATION_FAILED: "operation_failed",
  OPERATION_CANCELLED: "operation_cancelled",
  OPERATION_TIMEOUT: "operation_timeout",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  ERROR: "error",
  WARNING: "warning",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

// ── Content block ────────────────────────────────────────────────

/** @version 0.1.0 */
export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image" | "error";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

// ── Agent / Tool types ───────────────────────────────────────────

/** @version 0.1.0 */
export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** @version 0.1.0 */
export interface AgentMessage {
  role: MessageRole;
  content_type: MessageContentType;
  content: unknown;
  metadata: Record<string, unknown>;
  usage?: AgentUsage;
  timestamp: number;
  session_id: string;
}

/** @version 0.1.0 */
export interface AgentToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** @version 0.1.0 */
export interface AgentSessionConfig {
  api_key: string;
  base_url: string;
  model: string;
  workspace: string;
  system_prompt?: string;
  system_prompt_mode: string;
  additional_prompt?: string;
  api_timeout_ms: number;
  session_store?: unknown;
  resume_key?: string;
  session_id?: string;
  environment_overrides?: Record<string, string>;
  tools?: AgentToolDefinition[];
  mcp_servers: Record<string, Record<string, unknown>>;
  extra: Record<string, unknown>;
  mcp_server_name: string;
  mcp_stdio_module: string;
  enable_monitoring_hooks: boolean;
  metadata: Record<string, string>;
  hook_event_handler?: unknown;
}

/** @version 0.1.0 */
export const AgentMessageType = {
  AGENT_RESPONSE: "agent_response",
  CLAUDE_RESPONSE: "claude_response",
} as const;
export type AgentMessageType = (typeof AgentMessageType)[keyof typeof AgentMessageType];

// ── DAG Tool Schemas ─────────────────────────────────────────────

/** @version 0.1.0 */
export interface HandoffRequest {
  port: string;
  content: unknown;
  summary?: string;
}

/** @version 0.1.0 */
export interface HandoffResponse {
  content: ContentBlock[];
  is_error?: boolean;
}

/** @version 0.1.0 */
export interface SendMessagePayload {
  to_node: string;
  content: unknown;
}

/** @version 0.1.0 */
export interface ReceiveMessagePayload {
  timeout?: number;
}

/** @version 0.1.0 */
export interface EdgeRef {
  node: string;
  from_port: string;
  to_port: string;
}

/** @version 0.1.0 */
export interface GraphContext {
  node_id: string;
  predecessors: EdgeRef[];
  successors: EdgeRef[];
  available_ports: string[];
  graph_nodes: string[];
}

/** @version 0.1.0 */
export interface DagResumeAtPayload {
  source_node: string;
  target_node: string;
  up_to_uuid?: string;
}

// ── Protocol Messages ────────────────────────────────────────────

/** @version 0.1.0 */
export interface Message {
  id: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/** @version 0.1.0 */
export interface Request extends Message {
  type: "request";
  resource_type: string;
  operation: string;
  resource_id?: string;
  spec: Record<string, unknown>;
  timeout?: number;
}

/** @version 0.1.0 */
export interface Response extends Message {
  type: "response";
  request_id: string;
  status: string;
  resource_data?: Record<string, unknown>;
  error?: Record<string, unknown>;
  execution_time?: number;
}

/** @version 0.1.0 */
export interface Event extends Message {
  type: "event";
  event_type?: string;
  resource_type?: string;
  resource_id?: string;
  metadata: Record<string, unknown>;
}

/** @version 0.1.0 */
export interface StreamMessage extends Message {
  type: "stream";
  request_id: string;
  sequence: number;
  finished: boolean;
  chunk?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

/** @version 0.1.0 */
export interface AsyncRequest extends Message {
  type: "async_request";
  resource_type: string;
  operation: string;
  resource_id?: string;
  spec: Record<string, unknown>;
  target_node_id?: string;
  timeout?: number;
  priority: string;
  callback_url?: string;
  parameters: Record<string, unknown>;
}

/** @version 0.1.0 */
export interface AsyncResponse extends Message {
  type: "async_response";
  request_id: string;
  operation_id: string;
  status: string;
  estimated_duration?: number;
  queue_position?: number;
  error?: Record<string, unknown>;
}

/** @version 0.1.0 */
export interface AsyncProgress extends Message {
  type: "async_progress";
  operation_id: string;
  progress_percentage: number;
  current_stage: string;
  message?: string;
  details: Record<string, unknown>;
  estimated_remaining?: number;
}

/** @version 0.1.0 */
export interface AsyncControl extends Message {
  type: "async_control";
  operation_id: string;
  control_action: string;
  reason?: string;
  force: boolean;
}

/** @version 0.1.0 */
export interface AsyncResult extends Message {
  type: "event";
  event_type: string;
  operation_id: string;
  request_id: string;
  status: string;
  result_data: Record<string, unknown>;
  error?: Record<string, unknown>;
  execution_time?: number;
  metrics: Record<string, unknown>;
}

// ── Node Communication ───────────────────────────────────────────

/** @version 0.1.0 */
export interface Port {
  name: string;
  direction: "in" | "out";
  message_type: string;
}

/** @version 0.1.0 */
export interface NodeMessage {
  msg_id: string;
  from_node: string;
  from_port: string;
  to_node: string;
  to_port: string;
  message_type: string;
  content: unknown;
  iteration: number;
  timestamp: number;
}

/** @version 0.1.0 */
export interface NodeOutput {
  port: string;
  content: unknown;
  message_type: string;
  metadata: Record<string, unknown>;
}

/** @version 0.1.0 */
export interface ContractSpec {
  type: string;
  min_length?: number;
  min_items?: number;
  required?: string[];
  description?: string;
}

// ── DAG Node Config ──────────────────────────────────────────────

/** @version 0.1.0 */
export interface Edge {
  from_node?: string;
  from_port: string;
  to_node?: string;
  to_port: string;
}

/** @version 0.1.0 */
export interface DagNodeConfig {
  node_id: string;
  agent_type: string;
  model: string;
  outgoing_edges: Edge[];
  incoming_edges: Edge[];
  graph_nodes: string[];
  session_id?: string;
  advisors?: DagAdvisorConfig[];
  workspace_access?: DagWorkspaceAccess;
}

export interface DagAdvisorConfig {
  id: string;
  agent_id: string;
  agent_type: string;
  provider?: string;
  protocol?: string;
  model: string;
  api_key?: string;
  base_url?: string;
  system_prompt?: string;
  max_calls: number;
  calls_used?: number;
  timeout_ms: number;
  max_tokens: number;
}

export interface DagWorkspaceAccess {
  writable_paths: string[];
  readonly_paths?: string[];
  max_snapshot_files?: number;
}

// ── Event Emitter Wire Types ─────────────────────────────────────

/** @version 0.1.0 */
export interface HandoffEvent {
  type: "node_handoff";
  from_node: string;
  from_port: string;
  content: unknown;
  summary: string;
}

/** @version 0.1.0 */
export interface SendMessageEvent {
  type: "node_send_message";
  run_id: string;
  from_node: string;
  to_node: string;
  content: unknown;
  session_id?: string;
}

/** @version 0.1.0 */
export interface ReceiveMessageEvent {
  type: "node_receive_message";
  from_node: string;
  run_id: string;
  session_id?: string;
}

/** @version 0.1.0 */
export interface ResumeRequestEvent {
  type: "node_resume_request";
  from_node: string;
  source_node: string;
  target_node: string;
  up_to_uuid?: string;
  run_id: string;
}

/** @version 0.1.0 */
export type WireEvent = HandoffEvent | SendMessageEvent | ReceiveMessageEvent | ResumeRequestEvent;
