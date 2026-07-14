import {
  executeHomerailPluginTool,
  homerailPluginTurnContextDigestInput,
  validateHomerailPluginTurnContext,
  validateHomerailPluginToolExecutionEnvelope,
  type GenerativeUiNodeV1,
  type HomerailPluginTurnContextV1,
  type HomerailPluginToolExecutionEnvelopeV1,
} from "homerail-protocol";
import { isDeepStrictEqual } from "node:util";
import { getGenerativeUiKindRegistry } from "../generative-ui/kind-registry.js";
import { getPluginRegistryState } from "../persistence/plugins.js";
import { assemblePluginTurnContext } from "./context-assembler.js";
import { pluginJsonDigest } from "./descriptor.js";
import { ensureBuiltinPluginsSynced } from "./registry.js";

/** Accepts only envelopes emitted by a Tool in the current enabled snapshot. */
export function acceptPluginToolExecution(
  value: unknown,
  turnContext: HomerailPluginTurnContextV1,
): { envelope: HomerailPluginToolExecutionEnvelopeV1; node: GenerativeUiNodeV1 } {
  const validation = validateHomerailPluginToolExecutionEnvelope(value);
  if (!validation.valid || !validation.value) {
    throw new Error(`Invalid plugin Tool execution envelope: ${JSON.stringify(validation.errors)}`);
  }
  const contextValidation = validateHomerailPluginTurnContext(turnContext);
  if (
    !contextValidation.valid
    || !contextValidation.value
    || pluginJsonDigest(homerailPluginTurnContextDigestInput(contextValidation.value))
      !== contextValidation.value.context_digest
  ) {
    throw new Error("Plugin Tool turn Context failed validation or digest verification");
  }
  const frozenContext = contextValidation.value;
  const envelope = validation.value;
  const matchesEnvelope = (candidate: HomerailPluginTurnContextV1["tools"][number]) => (
    candidate.plugin_id === envelope.plugin.id
    && candidate.plugin_version === envelope.plugin.version
    && candidate.local_id === envelope.tool.local_id
    && candidate.qualified_id === envelope.tool.qualified_id
    && candidate.wire_id === envelope.tool.wire_id
    && candidate.handler.type === "projection"
    && candidate.handler.digest === envelope.tool.handler_digest
  );
  const frozenTool = frozenContext.tools.find(matchesEnvelope);
  if (!frozenTool) {
    throw new Error(`Plugin Tool was not available in this turn: ${envelope.tool.qualified_id}`);
  }

  ensureBuiltinPluginsSynced();
  const state = getPluginRegistryState();
  // Submission also requires the same exact Tool to remain enabled now.
  const currentContext = assemblePluginTurnContext(state, { modality: "voice" });
  const currentTool = currentContext.tools.find(matchesEnvelope);
  if (!currentTool || !isDeepStrictEqual(currentTool, frozenTool)) {
    throw new Error(`Plugin Tool is not enabled unchanged for this execution: ${envelope.tool.qualified_id}`);
  }
  const replayed = executeHomerailPluginTool(frozenTool, envelope.arguments);
  if (!isDeepStrictEqual(replayed, envelope)) {
    throw new Error(`Plugin Tool execution does not match deterministic replay: ${envelope.tool.qualified_id}`);
  }
  const node = envelope.projection.node;
  const kindErrors = getGenerativeUiKindRegistry().validateHistoricalNode({
    ...node,
    revision: 1,
    updated_at: "1970-01-01T00:00:00.000Z",
  });
  if (kindErrors.length) {
    throw new Error(`Plugin Tool projected an invalid Kind: ${JSON.stringify(kindErrors)}`);
  }
  const projectedKind = getGenerativeUiKindRegistry().uiProjection().kinds.find((kind) => (
    kind.enabled
    && kind.plugin_id === node.owner.id
    && kind.plugin_version === node.owner.version
    && kind.kind === node.kind
    && kind.kind_version === node.kind_version
  ));
  if (!projectedKind) throw new Error(`Plugin Kind is not enabled for this execution: ${node.kind}`);
  return { envelope, node: structuredClone(node) };
}
