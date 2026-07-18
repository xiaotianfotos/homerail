export interface RegisterMessage {
  type: "register";
  worker_id: string;
  capabilities?: string[];
}

export interface ControlRegisterMessage {
  type: "control";
  action: "register";
  data: { worker_id: string; capabilities?: string[] };
}

export interface StatusMessage {
  type: "status";
  data: { status: string };
}

export interface HeartbeatMessage {
  type: "heartbeat";
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

export interface ManagerCommandMessage {
  type: "manager_command";
  data: Record<string, unknown>;
}

export interface CredentialBrokerCallMessage {
  type: "credential_broker_call";
  data: DagCredentialBrokerCallRequest;
}

export interface DagActorLiveCommandStatusMessage {
  type: "dag_actor_command_status";
  data: DagActorLiveCommandStatusData;
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

export interface PongMessage {
  type: "pong";
}

export interface SessionEndMessage {
  type: "SESSION_END";
  data: {
    run_id: string;
    node_id: string;
    session_id: string;
    round_id?: string;
    actor_id?: string;
    generation?: number;
    lease_generation?: number;
    command_id?: string;
  };
}

export type IncomingWorkerMessage =
  | RegisterMessage
  | ControlRegisterMessage
  | StatusMessage
  | HeartbeatMessage
  | ResponseMessage
  | StreamMessage
  | ContentMessage
  | ManagerCommandMessage
  | CredentialBrokerCallMessage
  | DagActorLiveCommandStatusMessage
  | NodeErrorMessage
  | SessionEndMessage
  | PongMessage;

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

export type OutgoingWorkerMessage = PingMessage | TaskMessage | InjectMessage;

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseIncomingMessage(raw: unknown): IncomingWorkerMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== "string") return null;

  switch (obj.type) {
    case "register":
      if (typeof obj.worker_id !== "string") return null;
      return {
        type: "register",
        worker_id: obj.worker_id,
        capabilities: stringList(obj.capabilities),
      };
    case "control":
      if (obj.action !== "register") return null;
      if (typeof obj.data !== "object" || obj.data === null) return null;
      if (typeof (obj.data as Record<string, unknown>).worker_id !== "string") return null;
      return {
        type: "control",
        action: "register",
        data: {
          worker_id: (obj.data as Record<string, unknown>).worker_id as string,
          capabilities: stringList((obj.data as Record<string, unknown>).capabilities),
        },
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
    case "manager_command":
      if (typeof obj.data !== "object" || obj.data === null) return null;
      return {
        type: "manager_command",
        data: obj.data as Record<string, unknown>,
      };
    case "credential_broker_call": {
      if (typeof obj.data !== "object" || obj.data === null || Array.isArray(obj.data)) return null;
      const data = obj.data as Record<string, unknown>;
      if (
        typeof data.request_id !== "string"
        || typeof data.run_id !== "string"
        || typeof data.node_id !== "string"
        || typeof data.session_id !== "string"
        || typeof data.credential_ref !== "string"
        || typeof data.broker !== "string"
        || typeof data.action !== "string"
        || typeof data.input !== "object"
        || data.input === null
        || Array.isArray(data.input)
      ) return null;
      return {
        type: "credential_broker_call",
        data: data as unknown as DagCredentialBrokerCallRequest,
      };
    }
    case "dag_actor_command_status":
      if (typeof obj.data !== "object" || obj.data === null || Array.isArray(obj.data)) return null;
      return {
        type: "dag_actor_command_status",
        data: obj.data as unknown as DagActorLiveCommandStatusData,
      };
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
    case "SESSION_END": {
      if (typeof obj.data !== "object" || obj.data === null || Array.isArray(obj.data)) return null;
      const data = obj.data as Record<string, unknown>;
      if (typeof data.run_id !== "string" || typeof data.node_id !== "string" || typeof data.session_id !== "string") {
        return null;
      }
      return {
        type: "SESSION_END",
        data: {
          run_id: data.run_id,
          node_id: data.node_id,
          session_id: data.session_id,
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
    default:
      return null;
  }
}
import type {
  DagActorLiveCommandStatusData,
  DagCredentialBrokerCallRequest,
} from "homerail-protocol";
