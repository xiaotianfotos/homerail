export interface DAGAgentConfig {
  agent_type?: string;
  llm_setting_id?: string;
  llm?: { provider?: string; model?: string; api_key?: string; base_url?: string; protocol?: string };
  model?: string;
  system?: string;
  description?: string;
  skills?: string[];
  extra?: Record<string, unknown>;
}

export interface DAGOutputRoute {
  to: string | string[];
  condition?: "on_success" | "on_failure" | "always" | string;
  retry_policy?: DAGEdgeRetryPolicy;
}

export interface DAGEdgeRetryPolicy {
  max_retries?: number;
}

export interface DAGNodeRequirements {
  capabilities?: string[];
}

export interface DAGGatewayConfig {
  type?: "loop" | "condition" | "join" | "while" | string;
  kind?: "loop" | "condition" | "join" | "while" | string;
  mode?: "all" | "any" | "n_of_m" | string;
  field?: string;
  routes?: Record<string, string>;
  cases?: Record<string, string>;
  default_port?: string;
  items?: unknown[];
  input?: string;
  item_port?: string;
  result_port?: string;
  done_port?: string;
  passed_port?: string;
  failed_port?: string;
  continue_port?: string;
  exhausted_port?: string;
  threshold?: number;
  success_values?: unknown[];
  operator?: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "truthy" | "falsy" | string;
  value?: unknown;
  max_iterations?: number;
  max_items?: number;
}

export interface DAGPatternInstanceMeta {
  id: string;
  version: string;
  source?: string;
  parameters?: Record<string, unknown>;
}

export interface DAGNodeConfig {
  agent?: string;
  type?: string;
  node_type?: string;
  gateway_config?: DAGGatewayConfig;
  gateway?: DAGGatewayConfig;
  after?: string[];
  outputs?: Record<string, DAGOutputRoute>;
  name?: string;
  description?: string;
  image?: string;
  container_group?: string;
  requires?: DAGNodeRequirements;
  max_rounds?: number;
  extra?: Record<string, unknown>;
}

export interface DAGEdge {
  from_node: string;
  from_port: string;
  to_node: string;
  to_port: string;
  condition: string;
  label?: string;
  retry_policy?: DAGEdgeRetryPolicy;
  terminal_outcome?: "success" | "failure" | "cancelled";
}

export interface RuntimeProfileAgentMapping {
  provider?: string;
  model?: string;
  agent_type?: string;
}

export interface RuntimeProfile {
  description?: string;
  llm?: { provider?: string; model?: string };
  agents?: Record<string, RuntimeProfileAgentMapping>;
}

export interface ProviderPolicyConfig {
  prohibited_providers?: string[];
  prohibited_models?: string[];
  reason?: string;
}

export interface ScorecardHandoffBlockersConfig {
  enabled?: boolean;
  statuses?: string[];
  fields?: string[];
  success_statuses?: string[];
  success_forbidden_terms?: string[];
}

export interface ScorecardHandoffHeaderConfig {
  enabled?: boolean;
  nodes?: string[];
  source_issue_label?: string;
  artifact_label?: string;
}

export interface ScorecardSourceIssueConfig {
  enabled?: boolean;
  nodes?: string[];
  label?: string;
  include_issue_urls?: boolean;
}

export interface ScorecardQualityGateConfig {
  enabled?: boolean;
  nodes?: string[];
  required_categories?: string[];
}

export interface ScorecardPolicyConfig {
  profile?: string;
  mode?: "off" | "advisory" | "strict";
  enforcement?: "off" | "advisory" | "strict";
  handoff_blockers?: ScorecardHandoffBlockersConfig;
  handoff_header?: ScorecardHandoffHeaderConfig;
  source_issue?: ScorecardSourceIssueConfig;
  quality_gate?: ScorecardQualityGateConfig;
}

export interface ResolvedWorkflowMeta {
  name: string;
  workflow_id?: string;
  workflow_revision?: number;
  canonical_hash?: string;
  compiler_version?: string;
  source_api_version?: string;
  contracts?: Record<string, unknown>;
  run_input_targets?: Array<{ node: string; port: string; contract?: string }>;
  description?: string;
  llm?: { provider?: string; model?: string };
  runtime_profiles?: Record<string, RuntimeProfile>;
  provider_policy?: ProviderPolicyConfig;
  scorecard?: ScorecardPolicyConfig;
  pattern?: DAGPatternInstanceMeta;
  image?: string;
  limits?: Record<string, unknown>;
  git?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  agents?: Record<string, DAGAgentConfig>;
  nodes?: Record<string, DAGNodeConfig>;
}

export interface DAGGraphNode {
  node_id: string;
  name: string;
  description: string;
  node_type: string;
  agent: string;
  after: string[];
  outputs: Record<string, DAGOutputRoute>;
  image?: string;
  container_group?: string;
  requires?: DAGNodeRequirements;
  gateway_config?: DAGGatewayConfig;
  extra?: Record<string, unknown>;
}

export interface DAGGraphData {
  nodes: DAGGraphNode[];
  edges: DAGEdge[];
}

export interface ParsedDAG {
  meta: ResolvedWorkflowMeta;
  graph: DAGGraphData;
  loop_sources: string[];
}
