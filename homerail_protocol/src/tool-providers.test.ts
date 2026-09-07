/** @version 0.1.0 */

import { describe, expect, it } from "vitest";

import type { ToolProviderCatalog } from "./tool-providers.js";
import { TOOL_PROVIDER_CATALOG_VERSION } from "./tool-providers.js";

describe("tool provider catalog contract", () => {
  it("keeps configuration and runtime state on separate axes", () => {
    const catalog: ToolProviderCatalog = {
      version: TOOL_PROVIDER_CATALOG_VERSION,
      generated_at: new Date(0).toISOString(),
      providers: [{
        id: "homerail.browser-ui",
        name: "Browser UI",
        description: "Trusted UI actions",
        kind: "webmcp",
        configuration_state: "experimental",
        read_only_configuration: true,
        tools: [],
        bindings: [{
          harness: "manager_agent",
          execution_host: "renderer",
          transport: "browser_tools_ws",
          runtime_state: "disconnected",
        }],
      }],
    };

    expect(catalog.version).toBe(1);
    expect(catalog.providers[0]?.configuration_state).toBe("experimental");
    expect(catalog.providers[0]?.bindings[0]?.runtime_state).toBe("disconnected");
  });
});
