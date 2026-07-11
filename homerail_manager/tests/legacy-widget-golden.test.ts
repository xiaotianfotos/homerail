import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { closeDb } from "../src/persistence/db.js";
import { _clearAllSettings } from "../src/persistence/llm-settings.js";
import { _clearNodes } from "../src/node/registry.js";
import type { CodexModelCatalog } from "../src/server/codex-models.js";
import {
  _invokeHostCodexVoiceToolForTest,
  _setHostCodexManagerAgentRunnerForTest,
  _setHostCodexManagerAgentStreamRunnerForTest,
} from "../src/server/host-codex-manager-agent.js";
import { createServer } from "../src/server/http.js";
import { _clearStoredVoiceSettings } from "../src/server/voice.js";
import { _clearStoredConfig } from "../src/server/voice-agent-bootstrap.js";
import {
  listWidgetFileTypes,
  validateWidgetToml,
  type WidgetFileType,
} from "../src/widgets/widget-file-protocol.js";

interface DynamicWidgetCase {
  name: string;
  input: Record<string, unknown>;
}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(testDir, "fixtures", "legacy-widgets");
const widgetFileTypes: WidgetFileType[] = [
  "memo",
  "task_draft",
  "progress_status",
  "checklist",
  "artifact_ref",
  "timeline",
];

const codexModelCatalog: CodexModelCatalog = {
  binary: "codex",
  models: [{
    id: "gpt-5.5",
    model: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "",
    is_default: true,
    default_reasoning_effort: "medium",
    supported_reasoning_efforts: ["low", "medium", "high", "xhigh"],
    service_tiers: [],
  }],
};

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(fixturesRoot, relativePath), "utf8");
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("legacy Widget File Protocol goldens", () => {
  const goldens = readJson<Record<WidgetFileType, Record<string, unknown>>>("widget-file-protocol.golden.json");

  it("freezes the six-type V1 catalog", () => {
    expect(listWidgetFileTypes()).toEqual(widgetFileTypes);
    expect(Object.keys(goldens)).toEqual(widgetFileTypes);
  });

  for (const widgetType of widgetFileTypes) {
    it(`freezes ${widgetType} TOML normalization`, () => {
      const result = validateWidgetToml(
        readText(`widget-file-protocol/${widgetType}.toml`),
        widgetType,
        { filePath: `/compat/widgets/${widgetType}.toml` },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      expect(result.widget_type).toBe(widgetType);
      expect(result.widget).toEqual(goldens[widgetType]);
    });
  }
});

describe("legacy show_dynamic_widget goldens", () => {
  const cases = readJson<DynamicWidgetCase[]>("show-dynamic-widget.cases.json");
  const goldens = readJson<Array<Record<string, unknown>>>("show-dynamic-widget.golden.json");

  it("freezes the core and specialized dynamic type payloads at the tool boundary", async () => {
    for (const fixture of cases) {
      const invoked = await _invokeHostCodexVoiceToolForTest("show_dynamic_widget", fixture.input);
      expect(invoked.result.is_error, fixture.name).toBeFalsy();
      expect(invoked.voiceSurface.widgets, fixture.name).toEqual([fixture.input]);
    }
  });

  it("freezes dynamic Widget normalization in a persisted voice workspace", async () => {
    const previousHome = process.env.HOMERAIL_HOME;
    const previousAutostart = process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    const previousRuntime = process.env.HOMERAIL_MANAGER_AGENT_RUNTIME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-legacy-widget-golden-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    process.env.HOMERAIL_MANAGER_AGENT_RUNTIME = "container";
    _clearStoredConfig();
    _clearStoredVoiceSettings();
    _clearAllSettings();
    _clearNodes();
    const server = createServer(0, undefined, undefined, false, {
      loadCodexModels: async () => codexModelCatalog,
      autoDetectCodex: true,
    });

    try {
      _setHostCodexManagerAgentRunnerForTest(async (input) => ({
        text: "动态组件已更新。",
        spoken_text: "动态组件已更新。",
        session_id: input.session_id || "host-session-dynamic-golden",
        run_id: null,
        run_ids: [],
        objective: { required: false, satisfied: true, tool_calls: [] },
        tool_calls: cases.map((fixture, index) => ({
          id: `dynamic-${index + 1}`,
          name: "show_dynamic_widget",
          input: fixture.input,
        })),
        tool_results: [],
        commentary_texts: [],
        voice_surface: {
          progress: null,
          task_draft: null,
          widgets: cases.map((fixture) => fixture.input),
          remove_widget_ids: [],
        },
        worker_id: "host-codex",
        container_name: null,
      }));

      const port = await listen(server);
      const baseUrl = `http://127.0.0.1:${port}`;
      const configured = await fetch(`${baseUrl}/api/voice-agent/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          harness: "codex_appserver",
          model_name: "gpt-5.5",
          reasoning_effort: "low",
        }),
      });
      expect(configured.status).toBe(200);

      const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const createdBody = await created.json() as { data: { session_id: string } };
      const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "展示生成式 UI 兼容场景。" }),
      });
      const turnBody = await turn.json() as {
        data: { workspace: { widgets: Array<Record<string, unknown>> } };
      };

      expect(turn.status).toBe(200);
      expect(turnBody.data.workspace.widgets).toEqual(goldens);
    } finally {
      _setHostCodexManagerAgentRunnerForTest();
      _setHostCodexManagerAgentStreamRunnerForTest();
      if (server.listening) await close(server);
      _clearStoredConfig();
      _clearStoredVoiceSettings();
      _clearAllSettings();
      _clearNodes();
      closeDb();
      if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
      else process.env.HOMERAIL_HOME = previousHome;
      if (previousAutostart === undefined) delete process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
      else process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = previousAutostart;
      if (previousRuntime === undefined) delete process.env.HOMERAIL_MANAGER_AGENT_RUNTIME;
      else process.env.HOMERAIL_MANAGER_AGENT_RUNTIME = previousRuntime;
      fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
