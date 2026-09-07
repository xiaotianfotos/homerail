/**
 * Read-only catalog for application-owned MCP and function-tool providers.
 * @version 0.1.0
 */

export const TOOL_PROVIDER_CATALOG_VERSION = 1 as const;

export type ToolProviderKind = "builtin_tools" | "webmcp";
export type ToolProviderConfigurationState = "built_in" | "experimental";
export type ToolProviderRuntimeState = "available" | "connected" | "disconnected" | "unavailable";

export interface ToolProviderToolDescriptor {
  name: string;
  description: string;
}

export interface ToolProviderBinding {
  harness: "manager_agent" | "gpt_live";
  execution_host: "manager" | "renderer";
  transport: "in_process" | "browser_tools_ws";
  runtime_state: ToolProviderRuntimeState;
}

export interface ToolProviderDescriptor {
  id: string;
  name: string;
  description: string;
  kind: ToolProviderKind;
  configuration_state: ToolProviderConfigurationState;
  read_only_configuration: true;
  tools: ToolProviderToolDescriptor[];
  bindings: ToolProviderBinding[];
}

export interface ToolProviderCatalog {
  version: typeof TOOL_PROVIDER_CATALOG_VERSION;
  generated_at: string;
  providers: ToolProviderDescriptor[];
}
