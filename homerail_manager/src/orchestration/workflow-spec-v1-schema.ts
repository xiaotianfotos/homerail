import { Type, type Static, type TSchema } from "@sinclair/typebox";

export const WORKFLOW_API_VERSION = "homerail.ai/v1" as const;
export const WORKFLOW_KIND = "Workflow" as const;
export const WORKFLOW_COMPILER_VERSION = "2" as const;

const IDENTIFIER_PATTERN = "^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$";
const PORT_REFERENCE_PATTERN = "^(?:\\$run\\.input|[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*\\.[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)$";

const Identifier = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: IDENTIFIER_PATTERN,
});

const ContractIdentifier = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$",
});

const JsonPropertyName = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z_][A-Za-z0-9_-]*$",
});

const ShortText = Type.String({ maxLength: 512 });
const LongText = Type.String({ maxLength: 32_768 });

const StringMap = Type.Record(Identifier, Type.String({ maxLength: 1024 }), {
  maxProperties: 64,
});

const JsonValue = Type.Recursive((This) => Type.Union([
  Type.Null(),
  Type.Boolean(),
  Type.Number(),
  Type.String({ maxLength: 16_384 }),
  Type.Array(This, { maxItems: 256 }),
  Type.Record(Type.String({ minLength: 1, maxLength: 128 }), This, { maxProperties: 256 }),
]));

// Workflow contracts intentionally expose a bounded JSON Schema subset. This
// keeps contracts portable and makes runtime payload validation predictable.
const ContractSchema = Type.Recursive((This) => Type.Object({
  type: Type.Optional(Type.Union([
    Type.Literal("null"),
    Type.Literal("boolean"),
    Type.Literal("number"),
    Type.Literal("integer"),
    Type.Literal("string"),
    Type.Literal("array"),
    Type.Literal("object"),
  ])),
  description: Type.Optional(ShortText),
  enum: Type.Optional(Type.Array(JsonValue, { minItems: 1, maxItems: 64 })),
  const: Type.Optional(JsonValue),
  required: Type.Optional(Type.Array(JsonPropertyName, { uniqueItems: true, maxItems: 128 })),
  additionalProperties: Type.Optional(Type.Boolean()),
  properties: Type.Optional(Type.Record(JsonPropertyName, This, { maxProperties: 128 })),
  items: Type.Optional(This),
  oneOf: Type.Optional(Type.Array(This, { minItems: 2, maxItems: 8 })),
  minItems: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
  maxItems: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
  minLength: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  maxLength: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  minimum: Type.Optional(Type.Number()),
  maximum: Type.Optional(Type.Number()),
  pattern: Type.Optional(Type.String({ maxLength: 512 })),
}, { additionalProperties: false }));

const Port = Type.Object({
  contract: Type.Optional(ContractIdentifier),
  description: Type.Optional(ShortText),
}, { additionalProperties: false });

const PortMap = Type.Record(Identifier, Port, { maxProperties: 128 });

const NodeBase = {
  description: Type.Optional(ShortText),
  depends_on: Type.Optional(Type.Array(Identifier, {
    uniqueItems: true,
    maxItems: 256,
  })),
  inputs: Type.Optional(PortMap),
  outputs: Type.Optional(PortMap),
};

const AdvisorBinding = Type.Object({
  id: Identifier,
  agent: Identifier,
  max_calls: Type.Integer({ minimum: 1, maximum: 32 }),
  timeout_ms: Type.Integer({ minimum: 100, maximum: 3_600_000 }),
  max_tokens: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
}, { additionalProperties: false });

const WorkspaceAccess = Type.Object({
  writable_paths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), {
    uniqueItems: true,
    maxItems: 128,
  }),
  readonly_paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), {
    uniqueItems: true,
    maxItems: 128,
  })),
  max_snapshot_files: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
}, { additionalProperties: false });

const AgentNode = Type.Object({
  kind: Type.Literal("agent"),
  agent: Identifier,
  advisors: Type.Optional(Type.Array(AdvisorBinding, { uniqueItems: true, maxItems: 16 })),
  workspace_access: Type.Optional(WorkspaceAccess),
  ...NodeBase,
}, { additionalProperties: false });

const CommandNode = Type.Object({
  kind: Type.Literal("command"),
  ...NodeBase,
  config: Type.Object({
    input: Type.Optional(Identifier),
    command: Type.Optional(Type.Array(Type.String({ maxLength: 16_384 }), { minItems: 1, maxItems: 256 })),
    command_field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    stdin_field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    timeout_ms: Type.Integer({ minimum: 100, maximum: 3_600_000 }),
    success_exit_codes: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 255 }), {
      minItems: 1,
      uniqueItems: true,
      maxItems: 32,
    })),
    success_port: Identifier,
    failure_port: Identifier,
    capture_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
    parse_stdout: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json"), Type.Literal("number")])),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const ApprovalNode = Type.Object({
  kind: Type.Literal("approval"),
  ...NodeBase,
  config: Type.Object({
    approval_id: Identifier,
    proposal_field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    proposer_actor: Type.String({ minLength: 1, maxLength: 256 }),
    authorized_actors: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
      minItems: 1,
      uniqueItems: true,
      maxItems: 128,
    }),
    approved_port: Identifier,
    rejected_port: Identifier,
    expires_after_ms: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 31_536_000_000 })),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const StateNode = Type.Object({
  kind: Type.Literal("state"),
  ...NodeBase,
  config: Type.Object({
    namespace: Identifier,
    key: Type.String({ minLength: 1, maxLength: 256 }),
    key_field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    operation: Type.Union([
      Type.Literal("get"),
      Type.Literal("set"),
      Type.Literal("increment"),
      Type.Literal("compare_and_set"),
      Type.Literal("trust_update"),
      Type.Literal("budget_admit"),
    ]),
    value: Type.Optional(JsonValue),
    value_field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    expected_version: Type.Optional(Type.Integer({ minimum: 0 })),
    pass_field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    auto_min_runs: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
    auto_min_rate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    watch_min_rate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    budget_limit: Type.Optional(Type.Number({ minimum: 0 })),
    usage_field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    success_port: Identifier,
    conflict_port: Type.Optional(Identifier),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const FanoutNode = Type.Object({
  kind: Type.Literal("fanout"),
  ...NodeBase,
  config: Type.Object({
    input: Identifier,
    item_field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    context_field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    worker_agent: Identifier,
    max_items: Type.Integer({ minimum: 1, maximum: 256 }),
    max_parallelism: Type.Integer({ minimum: 1, maximum: 256 }),
    completion: Type.Union([Type.Literal("all"), Type.Literal("any"), Type.Literal("n_of_m")]),
    threshold: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
    result_contract: Type.Optional(ContractIdentifier),
    success_field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    success_values: Type.Optional(Type.Array(JsonValue, { minItems: 1, maxItems: 128 })),
    result_port: Identifier,
    failed_port: Identifier,
    cancel_remaining: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const ConditionNode = Type.Object({
  kind: Type.Literal("condition"),
  ...NodeBase,
  config: Type.Object({
    field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    routes: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Identifier, {
      minProperties: 1,
      maxProperties: 128,
    }),
    default: Type.Optional(Identifier),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const JoinNode = Type.Object({
  kind: Type.Literal("join"),
  ...NodeBase,
  config: Type.Object({
    mode: Type.Union([Type.Literal("all"), Type.Literal("any"), Type.Literal("n_of_m")]),
    field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    success_values: Type.Optional(Type.Array(JsonValue, { minItems: 1, maxItems: 128 })),
    threshold: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
    passed_port: Type.Optional(Identifier),
    failed_port: Type.Optional(Identifier),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const ForeachNode = Type.Object({
  kind: Type.Literal("foreach"),
  ...NodeBase,
  config: Type.Object({
    input: Identifier,
    field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    item_port: Identifier,
    result_port: Identifier,
    done_port: Identifier,
    max_items: Type.Integer({ minimum: 1, maximum: 10_000 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const WhileNode = Type.Object({
  kind: Type.Literal("while"),
  ...NodeBase,
  config: Type.Object({
    field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    operator: Type.Union([
      Type.Literal("eq"),
      Type.Literal("ne"),
      Type.Literal("gt"),
      Type.Literal("gte"),
      Type.Literal("lt"),
      Type.Literal("lte"),
      Type.Literal("truthy"),
      Type.Literal("falsy"),
    ]),
    value: Type.Optional(JsonValue),
    continue_port: Identifier,
    done_port: Identifier,
    exhausted_port: Type.Optional(Identifier),
    max_iterations: Type.Integer({ minimum: 1, maximum: 10_000 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const TerminalNode = Type.Object({
  kind: Type.Literal("terminal"),
  description: Type.Optional(ShortText),
  depends_on: Type.Optional(Type.Array(Identifier, {
    uniqueItems: true,
    maxItems: 256,
  })),
  inputs: Type.Optional(PortMap),
  outcome: Type.Union([
    Type.Literal("success"),
    Type.Literal("failure"),
    Type.Literal("cancelled"),
  ]),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false });

const WorkflowNode = Type.Union([
  AgentNode,
  CommandNode,
  ApprovalNode,
  StateNode,
  FanoutNode,
  ConditionNode,
  JoinNode,
  ForeachNode,
  WhileNode,
  TerminalNode,
]);

const DataEdge = Type.Object({
  from: Type.String({ pattern: PORT_REFERENCE_PATTERN, maxLength: 130 }),
  to: Type.String({ pattern: PORT_REFERENCE_PATTERN, maxLength: 130 }),
  condition: Type.Optional(Type.Union([
    Type.Literal("on_success"),
    Type.Literal("on_failure"),
    Type.Literal("always"),
  ])),
  retry: Type.Optional(Type.Object({
    max_retries: Type.Integer({ minimum: 0, maximum: 20 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const FeedbackEdge = Type.Object({
  kind: Type.Literal("feedback"),
  from: Type.String({ pattern: PORT_REFERENCE_PATTERN, maxLength: 130 }),
  to: Type.String({ pattern: PORT_REFERENCE_PATTERN, maxLength: 130 }),
  max_traversals: Type.Integer({ minimum: 1, maximum: 10_000 }),
}, { additionalProperties: false });

const WorkflowEdge = Type.Union([DataEdge, FeedbackEdge]);

export const WorkflowSpecV1Schema = Type.Object({
  api_version: Type.Literal(WORKFLOW_API_VERSION),
  kind: Type.Literal(WORKFLOW_KIND),
  metadata: Type.Object({
    id: Identifier,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    labels: Type.Optional(StringMap),
    annotations: Type.Optional(StringMap),
  }, { additionalProperties: false }),
  spec: Type.Object({
    description: Type.Optional(LongText),
    workspace: Type.Optional(Type.Object({
      mode: Type.Union([Type.Literal("isolated"), Type.Literal("shared")]),
    }, { additionalProperties: false })),
    contracts: Type.Optional(Type.Record(ContractIdentifier, ContractSchema, { maxProperties: 128 })),
    triggers: Type.Optional(Type.Record(Identifier, Type.Union([
      Type.Object({
        type: Type.Literal("interval"),
        every_ms: Type.Integer({ minimum: 1_000, maximum: 31_536_000_000 }),
        overlap: Type.Union([Type.Literal("skip"), Type.Literal("allow")]),
        max_concurrency: Type.Integer({ minimum: 1, maximum: 256 }),
        enabled: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }),
      Type.Object({
        type: Type.Literal("event"),
        event: Type.String({ minLength: 1, maxLength: 256 }),
        overlap: Type.Union([Type.Literal("skip"), Type.Literal("allow")]),
        max_concurrency: Type.Integer({ minimum: 1, maximum: 256 }),
        enabled: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }),
    ]), { maxProperties: 64 })),
    agents: Type.Record(Identifier, Type.Object({
      description: Type.Optional(ShortText),
      system: Type.Optional(LongText),
      skills: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
        uniqueItems: true,
        maxItems: 128,
      })),
    }, { additionalProperties: false }), { maxProperties: 256 }),
    nodes: Type.Record(Identifier, WorkflowNode, {
      minProperties: 1,
      maxProperties: 1000,
    }),
    edges: Type.Array(WorkflowEdge, { maxItems: 10_000 }),
    pattern: Type.Optional(Type.Object({
      id: Identifier,
      version: Type.String({ minLength: 1, maxLength: 64 }),
      source: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
      parameters: Type.Optional(Type.Record(Identifier, JsonValue, { maxProperties: 128 })),
    }, { additionalProperties: false })),
    policies: Type.Optional(Type.Object({
      max_nodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      max_edges: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
      max_parallelism: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
      max_dispatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      max_handoffs: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      max_corrections_per_node: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
      max_edge_traversals: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
      max_tool_calls_per_node: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
}, {
  $id: "https://homerail.ai/schemas/workflow/homerail.ai-v1.json",
  additionalProperties: false,
});

export type WorkflowSpecV1 = Static<typeof WorkflowSpecV1Schema>;
export type WorkflowSpecV1Node = Static<typeof WorkflowNode>;
export type WorkflowSpecV1Edge = Static<typeof WorkflowEdge>;
export type WorkflowContractSchema = Static<typeof ContractSchema>;

export function publicWorkflowSpecV1Schema(): TSchema {
  return WorkflowSpecV1Schema;
}
