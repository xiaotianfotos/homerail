/** @version 0.1.0 */

import { describe, expect, it } from "vitest";

import {
  BROWSER_TOOLS_PROTOCOL_VERSION,
  HOMERAIL_UI_TOOL_CONTRACTS,
  browserPageToolDescriptorDigest,
  homeRailUiToolContract,
  uiToolContractDigest,
  validateBrowserToolsTurnBinding,
  validateHomeRailUiToolInput,
} from "./browser-tools.js";

describe("browser tools contracts", () => {
  it("requires an explicit fail-closed turn transport", () => {
    expect(validateBrowserToolsTurnBinding(undefined, undefined)).toEqual({
      browser_tools_transport: "none",
      browser_tools_target: null,
    });
    expect(validateBrowserToolsTurnBinding("desktop", undefined)).toEqual({
      browser_tools_transport: "desktop",
      browser_tools_target: null,
    });
    const target = {
      connection_id: "connection-a",
      ui_session_id: "ui-a",
      tab_id: "tab-a",
      navigation_id: "navigation-a",
    };
    expect(validateBrowserToolsTurnBinding("renderer", target)).toEqual({
      browser_tools_transport: "renderer",
      browser_tools_target: target,
    });
    expect(() => validateBrowserToolsTurnBinding("renderer", undefined)).toThrow(/connection/);
    expect(() => validateBrowserToolsTurnBinding("desktop", target)).toThrow(/forbidden/);
    expect(() => validateBrowserToolsTurnBinding("latest", undefined)).toThrow(/none, desktop, or renderer/);
  });

  it("publishes a small stable page-tool catalog", () => {
    expect(BROWSER_TOOLS_PROTOCOL_VERSION).toBe(1);
    expect(HOMERAIL_UI_TOOL_CONTRACTS.map((contract) => contract.name)).toEqual([
      "ui_get_state",
      "ui_open_surface",
      "ui_close_surface",
      "ui_describe_widget",
      "ui_focus_widget",
      "ui_set_widget_expanded",
    ]);
    expect(homeRailUiToolContract("ui_open_surface")?.effect).toBe("presentational");
    expect(homeRailUiToolContract("unknown")).toBeUndefined();
  });

  it("separates trusted contract and page descriptor digests", () => {
    const contract = homeRailUiToolContract("ui_open_surface")!;
    const contractDigest = uiToolContractDigest(contract);
    const descriptorDigest = browserPageToolDescriptorDigest({
      name: contract.name,
      description: contract.description,
      input_schema: contract.input_schema,
      frame_id: "frame-1",
      origin: "https://127.0.0.1:19192",
      navigation_id: "navigation-1",
      read_only: false,
      untrusted_content: true,
    });

    expect(contractDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(descriptorDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(descriptorDigest).not.toBe(contractDigest);
    expect(browserPageToolDescriptorDigest({
      name: contract.name,
      description: contract.description,
      input_schema: contract.input_schema,
      frame_id: "frame-1",
      origin: "https://127.0.0.1:19192",
      navigation_id: "navigation-2",
      read_only: false,
      untrusted_content: true,
    })).not.toBe(descriptorDigest);
  });

  it("freezes the cross-repository first-slice contract digests", () => {
    expect(Object.fromEntries(HOMERAIL_UI_TOOL_CONTRACTS.map((contract) => [
      contract.name,
      uiToolContractDigest(contract),
    ]))).toEqual({
      ui_get_state: "8834beb1707f006b5eb1af279e26d9c8badb206fa39571553819d0a8b02b72fa",
      ui_open_surface: "783158c38bf647ad841c277295413856b0c7e7f95c9d5a8a139b2e68a001cb7b",
      ui_close_surface: "79fe981d9a5325cdb29aead57672f2add1d101fb8228b5ae942142e4f1416053",
      ui_describe_widget: "1820f6e92499a1017887b944b1f23932317731d2d0ae40a3fad24bf6668836af",
      ui_focus_widget: "fb15d498024fe2bc6b80f9a9cb2362385e678dac3090e829299145b1445b8cbe",
      ui_set_widget_expanded: "74354281333a595580b81ae6aa4ee641dda7caecf766e66cbc13b06b3ed4f8ed",
    });
  });

  it("validates and normalizes every frozen tool input", () => {
    expect(validateHomeRailUiToolInput("ui_get_state", {})).toEqual({});
    expect(validateHomeRailUiToolInput("ui_open_surface", {
      surface: " dag_status ",
      entity_id: " run-001 ",
    })).toEqual({ surface: "dag_status", entity_id: "run-001" });
    expect(validateHomeRailUiToolInput("ui_close_surface", {
      surface: "dag_status",
    })).toEqual({ surface: "dag_status" });
    const widgetTarget = {
      document_id: " document-one ",
      document_revision: 4,
      widget_id: " widget-one ",
      widget_revision: 2,
    };
    expect(validateHomeRailUiToolInput("ui_describe_widget", widgetTarget)).toEqual(widgetTarget);
    expect(validateHomeRailUiToolInput("ui_set_widget_expanded", {
      ...widgetTarget,
      expanded: true,
    })).toEqual({
      ...widgetTarget,
      expanded: true,
    });
    expect(validateHomeRailUiToolInput("ui_describe_widget", {
      ...widgetTarget,
      widget_id: "widget-one",
    }).widget_id).toBe("widget-one");
    expect(validateHomeRailUiToolInput("ui_describe_widget", {
      ...widgetTarget,
      widget_id: " widget-one ",
    }).widget_id).toBe(" widget-one ");
    const maxUnicodeId = "😀".repeat(256);
    expect(validateHomeRailUiToolInput("ui_describe_widget", {
      ...widgetTarget,
      widget_id: maxUnicodeId,
    }).widget_id).toBe(maxUnicodeId);
  });

  it.each([
    ["ui_get_state", null, /must be an object/],
    ["ui_get_state", { extra: true }, /unsupported field: extra/],
    ["ui_open_surface", { surface: "dag_status", run_id: "run-001" }, /unsupported field: run_id/],
    ["ui_open_surface", { surface: "dag_status", entity_id: 1 }, /entity_id must be a string/],
    ["ui_open_surface", { surface: "dag_status", query: " " }, /1-256 printable/],
    ["ui_open_surface", { surface: "dag_status", entity_id: "run", query: "run" }, /not both/],
    ["ui_close_surface", { surface: "other" }, /requires surface=dag_status/],
    ["ui_focus_widget", {
      document_id: "document-one",
      document_revision: 4,
      widget_id: "widget-one",
    }, /widget_revision must be a non-negative safe integer/],
    ["ui_focus_widget", {
      document_id: "document-one",
      document_revision: -1,
      widget_id: "widget-one",
      widget_revision: 2,
    }, /document_revision must be a non-negative safe integer/],
    ["ui_focus_widget", {
      document_id: "   ",
      document_revision: 4,
      widget_id: "widget-one",
      widget_revision: 2,
    }, /document_id must contain 1-256 printable/],
    ["ui_focus_widget", {
      document_id: "document-one",
      document_revision: 4,
      widget_id: "   ",
      widget_revision: 2,
    }, /widget_id must contain 1-256 printable/],
    ["ui_focus_widget", {
      document_id: "document-one",
      document_revision: 4,
      widget_id: "😀".repeat(257),
      widget_revision: 2,
    }, /widget_id must contain 1-256 printable/],
    ["ui_set_widget_expanded", {
      document_id: "document-one",
      document_revision: 4,
      widget_id: "widget-one",
      widget_revision: 2,
      expanded: "yes",
    }, /expanded must be a boolean/],
  ] as const)("rejects invalid %s input", (name, input, error) => {
    expect(() => validateHomeRailUiToolInput(name, input)).toThrow(error);
  });
});
