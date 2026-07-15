export interface RegisterMessage {
  type: "register";
  node_id: string;
}

export interface ControlRegisterMessage {
  type: "control";
  action: "register";
  data: { node_id: string };
}

export interface StatusMessage {
  type: "status";
  data: { status: string };
}

export interface HeartbeatMessage {
  type: "heartbeat";
}

export interface CapabilitiesMessage {
  type: "capabilities";
  capabilities: string[];
}

export interface ResponseMessage {
  type: "response";
  session_id?: string;
  data?: unknown;
}

export interface StreamMessage {
  type: "stream";
  data: Record<string, unknown>;
}

export interface ContentMessage {
  type: "content";
  data: {
    text: string;
    run_id?: string;
    node_id?: string;
    session_id?: string;
    round_id?: string;
    actor_id?: string;
    generation?: number;
    lease_generation?: number;
    command_id?: string;
  };
}

export interface PongMessage {
  type: "pong";
}

export interface NodeErrorMessage {
  type: "node_error";
  data: {
    runId: string;
    nodeId: string;
    message: string;
    session_id?: string;
    round_id?: string;
    actor_id?: string;
    generation?: number;
    lease_generation?: number;
    command_id?: string;
  };
}

export type IncomingNodeMessage =
  | RegisterMessage
  | ControlRegisterMessage
  | StatusMessage
  | HeartbeatMessage
  | CapabilitiesMessage
  | ResponseMessage
  | StreamMessage
  | ContentMessage
  | NodeErrorMessage
  | PongMessage
  | LifecycleResponseMessage;

export interface PingMessage {
  type: "ping";
}

export interface TaskMessage {
  type: "task";
  data: { task: string; sender: string };
}

export interface InjectMessage {
  type: "inject";
  data: {
    runId: string;
    nodeId: string;
    instruction: string;
    mode: string;
  };
}

export interface LifecycleRequestMessage {
  type: "lifecycle_request";
  request_id: string;
  resource_type: string;
  operation: string;
  spec: Record<string, unknown>;
}

export interface LifecycleResponseMessage {
  type: "lifecycle_response";
  request_id: string;
  status: string;
  resource_data?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export type OutgoingNodeMessage = PingMessage | TaskMessage | InjectMessage | LifecycleRequestMessage;

export function parseIncomingNodeMessage(raw: unknown): IncomingNodeMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== "string") return null;

  switch (obj.type) {
    case "register":
      if (typeof obj.node_id !== "string") return null;
      return { type: "register", node_id: obj.node_id };
    case "control":
      if (obj.action !== "register") return null;
      if (typeof obj.data !== "object" || obj.data === null) return null;
      if (typeof (obj.data as Record<string, unknown>).node_id !== "string") return null;
      return {
        type: "control",
        action: "register",
        data: { node_id: (obj.data as Record<string, unknown>).node_id as string },
      };
    case "status":
      if (typeof obj.data === "object" && obj.data !== null) {
        const status = (obj.data as Record<string, unknown>).status;
        if (typeof status === "string") return { type: "status", data: { status } };
      }
      if (typeof obj.status === "string") return { type: "status", data: { status: obj.status } };
      return null;
    case "heartbeat":
      return { type: "heartbeat" };
    case "capabilities":
      if (Array.isArray(obj.capabilities)) {
        const caps = obj.capabilities.filter((c): c is string => typeof c === "string");
        return { type: "capabilities", capabilities: caps };
      }
      return null;
    case "response":
      return {
        type: "response",
        session_id: typeof obj.session_id === "string" ? obj.session_id : undefined,
        data: obj.data,
      };
    case "stream":
      if (typeof obj.data !== "object" || obj.data === null || Array.isArray(obj.data)) return null;
      return {
        type: "stream",
        data: obj.data as Record<string, unknown>,
      };
    case "content": {
      if (typeof obj.data !== "object" || obj.data === null || Array.isArray(obj.data)) return null;
      const data = obj.data as Record<string, unknown>;
      if (typeof data.text !== "string") return null;
      return {
        type: "content",
        data: {
          text: data.text,
          run_id: typeof data.run_id === "string" ? data.run_id : undefined,
          node_id: typeof data.node_id === "string" ? data.node_id : undefined,
          session_id: typeof data.session_id === "string" ? data.session_id : undefined,
          round_id: typeof data.round_id === "string" ? data.round_id : undefined,
          actor_id: typeof data.actor_id === "string" ? data.actor_id : undefined,
          generation: typeof data.generation === "number" ? data.generation : undefined,
          lease_generation: typeof data.lease_generation === "number" ? data.lease_generation : undefined,
          command_id: typeof data.command_id === "string" ? data.command_id : undefined,
        },
      };
    }
    case "node_error": {
      if (typeof obj.data !== "object" || obj.data === null) return null;
      const data = obj.data as Record<string, unknown>;
      if (typeof data.runId !== "string") return null;
      if (typeof data.nodeId !== "string") return null;
      if (typeof data.message !== "string") return null;
      return {
        type: "node_error",
        data: {
          runId: data.runId,
          nodeId: data.nodeId,
          message: data.message,
          session_id: typeof data.session_id === "string" ? data.session_id : undefined,
          round_id: typeof data.round_id === "string" ? data.round_id : undefined,
          actor_id: typeof data.actor_id === "string" ? data.actor_id : undefined,
          generation: typeof data.generation === "number" ? data.generation : undefined,
          lease_generation: typeof data.lease_generation === "number" ? data.lease_generation : undefined,
          command_id: typeof data.command_id === "string" ? data.command_id : undefined,
        },
      };
    }
    case "pong":
      return { type: "pong" };
    case "lifecycle_response":
      if (typeof obj.request_id !== "string") return null;
      if (typeof obj.status !== "string") return null;
      return {
        type: "lifecycle_response",
        request_id: obj.request_id,
        status: obj.status,
        resource_data: typeof obj.resource_data === "object" && obj.resource_data !== null
          ? obj.resource_data as Record<string, unknown>
          : undefined,
        error: typeof obj.error === "object" && obj.error !== null
          ? obj.error as Record<string, unknown>
          : undefined,
      };
    default:
      return null;
  }
}
