import { describe, expect, it } from "vitest";

import { buildToolProviderCatalog } from "../src/server/tool-providers.js";

describe("read-only tool provider catalog", () => {
  it("derives built-in declarations and browser runtime presence independently", () => {
    const disconnected = buildToolProviderCatalog({ browserConnected: false });
    const connected = buildToolProviderCatalog({ browserConnected: true });
    const builtIn = disconnected.providers.find((provider) => provider.id === "homerail.dag-control")!;
    const browserOff = disconnected.providers.find((provider) => provider.id === "homerail.browser-ui")!;
    const browserOn = connected.providers.find((provider) => provider.id === "homerail.browser-ui")!;

    expect(builtIn.configuration_state).toBe("built_in");
    expect(builtIn.read_only_configuration).toBe(true);
    expect(builtIn.tools.some((tool) => tool.name === "get_run_status")).toBe(true);
    expect(browserOff.configuration_state).toBe("experimental");
    expect(browserOff.bindings.every((binding) => binding.runtime_state === "disconnected")).toBe(true);
    expect(browserOn.bindings.every((binding) => binding.runtime_state === "connected")).toBe(true);
    expect(browserOn.tools.map((tool) => tool.name)).toEqual([
      "ui_close_surface",
      "ui_describe_widget",
      "ui_focus_widget",
      "ui_get_state",
      "ui_open_surface",
      "ui_set_widget_expanded",
    ]);
  });
});
