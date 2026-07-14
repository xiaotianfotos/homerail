import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyHomerailDirectUiProjection,
  buildHomerailDeclarativeRendererModel,
  validateHomerailDirectUiProjection,
  validateHomerailPluginToolInput,
  type HomerailDeclarativeRendererModelV1,
  type HomerailDeclarativeRendererV1,
  type HomerailA2uiSurfaceV1,
} from "homerail-protocol";
import { scanPluginSource } from "./project.js";

export interface PluginFixtureResult {
  file: string;
  tool: string;
  passed: boolean;
  message?: string;
  content?: Record<string, unknown>;
  renderer_models?: Array<{ renderer: string; model: HomerailDeclarativeRendererModelV1 }>;
  a2ui_surface?: HomerailA2uiSurfaceV1;
}

export interface PluginFixtureMatrixReport {
  valid: boolean;
  fixtures: PluginFixtureResult[];
  renderer_matrix: Array<{ renderer: string; surface: string; device: string; state: string }>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function partialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length <= actual.length
      && expected.every((entry, index) => partialMatch(actual[index], entry));
  }
  const actualObject = object(actual);
  return Boolean(actualObject) && Object.entries(expected as Record<string, unknown>)
    .every(([key, value]) => partialMatch(actualObject![key], value));
}

export function runPluginFixtureMatrix(
  rootValue: string,
  options: { locale?: string } = {},
): PluginFixtureMatrixReport {
  const root = path.resolve(rootValue);
  const snapshot = scanPluginSource(root);
  if (!snapshot.valid) throw new Error(`Plugin validation failed: ${JSON.stringify(snapshot.issues)}`);
  const fixtureRoot = path.join(root, "fixtures");
  const fixtureFiles = fs.existsSync(fixtureRoot)
    ? fs.readdirSync(fixtureRoot).filter((file) => file.endsWith(".json")).sort()
    : [];
  const schemas = new Map(snapshot.manifest.schemas.map((declaration) => [
    declaration.id,
    JSON.parse(snapshot.files.get(declaration.file)!.toString("utf8")) as Record<string, unknown>,
  ]));
  const fixtures: PluginFixtureResult[] = fixtureFiles.map((file) => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), "utf8")) as unknown;
      const fixture = object(value);
      if (!fixture || typeof fixture.tool !== "string" || !object(fixture.arguments)) throw new Error("fixture requires tool and object arguments");
      const tool = snapshot.manifest.tools.find((entry) => entry.id === fixture.tool);
      if (!tool || tool.handler.type !== "projection") throw new Error(`unknown declarative Tool: ${fixture.tool}`);
      const input = validateHomerailPluginToolInput(schemas.get(tool.input_schema)!, fixture.arguments);
      if (!input.valid || !input.value) throw new Error(`invalid fixture input: ${JSON.stringify(input.errors)}`);
      const rawProjection = JSON.parse(snapshot.files.get(tool.handler.file)!.toString("utf8")) as unknown;
      const projection = validateHomerailDirectUiProjection(rawProjection);
      if (!projection.valid || !projection.value) throw new Error(`invalid projector: ${JSON.stringify(projection.errors)}`);
      const result = applyHomerailDirectUiProjection({
        projection: projection.value,
        plugin: { id: snapshot.manifest.id, version: snapshot.manifest.version },
        arguments: input.value,
      });
      if (tool.output_schema) {
        const output = validateHomerailPluginToolInput(schemas.get(tool.output_schema)!, result.node.content);
        if (!output.valid) throw new Error(`invalid projected output: ${JSON.stringify(output.errors)}`);
      }
      if (fixture.expect !== undefined && !partialMatch(result.node.content, fixture.expect)) {
        throw new Error("projected content did not match fixture expectation");
      }
      const rendererModels = snapshot.manifest.renderers.flatMap((renderer) => {
        if (
          renderer.mode !== "declarative"
          || renderer.source.type !== "declarative"
          || renderer.kind !== result.node.kind
          || renderer.kind_version !== result.node.kind_version
        ) return [];
        return [{
          renderer: renderer.id,
          model: buildHomerailDeclarativeRendererModel(
            JSON.parse(snapshot.files.get(renderer.source.file)!.toString("utf8")) as HomerailDeclarativeRendererV1,
            result.node.content,
            options,
          ),
        }];
      });
      return {
        file,
        tool: fixture.tool,
        passed: true,
        content: structuredClone(result.node.content),
        renderer_models: rendererModels,
        ...(result.node.a2ui ? {
          a2ui_surface: structuredClone(result.node.a2ui),
        } : {}),
      };
    } catch (cause) {
      return {
        file,
        tool: "unknown",
        passed: false,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  const states = ["loading", "empty", "partial", "success", "error", "stale"];
  const rendererMatrix = snapshot.manifest.renderers.flatMap((renderer) => (
    renderer.surfaces.flatMap((surface) => renderer.devices.flatMap((device) => (
      states.map((state) => ({ renderer: renderer.id, surface, device, state }))
    )))
  ));
  return {
    valid: fixtures.length > 0 && fixtures.every((fixture) => fixture.passed),
    fixtures,
    renderer_matrix: rendererMatrix,
  };
}
