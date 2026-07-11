import type { DagAdvisorConfig } from "homerail-protocol";
import type { DagToolDefinition } from "../agent/types.js";
import { redactTelemetry } from "../telemetry-redaction.js";
import type { AdvisorCallResult, DagToolsState } from "./index.js";

function sendAdvisorEvent(state: DagToolsState, data: Record<string, unknown>): void {
  state.wsSend(JSON.stringify({
    type: "stream",
    data: redactTelemetry(data),
  }));
}

export function createConsultAdvisorTool(
  state: DagToolsState,
  runner: (advisor: DagAdvisorConfig, question: string) => Promise<AdvisorCallResult>,
): DagToolDefinition {
  return {
    name: "consult_advisor",
    description: "Consult one declared advisor at an ambiguity boundary, then continue this executor turn with the returned advice.",
    input_schema: {
      type: "object",
      properties: {
        advisor_id: { type: "string" },
        question: { type: "string", minLength: 1 },
        context: {},
      },
      required: ["advisor_id", "question"],
      additionalProperties: false,
    },
    async handler(args) {
      const advisorId = String(args.advisor_id ?? "").trim();
      const question = String(args.question ?? "").trim();
      const advisor = state.advisors.find((candidate) => candidate.id === advisorId);
      if (!advisor) {
        return {
          content: [{ type: "text", text: `Unknown advisor '${advisorId}'. Available: ${state.advisors.map((item) => item.id).join(", ")}` }],
          is_error: true,
        };
      }
      if (!question) return { content: [{ type: "text", text: "question must not be empty" }], is_error: true };
      const calls = state.advisorCalls.get(advisorId) ?? 0;
      if (!Number.isInteger(calls) || calls < 0) {
        return {
          content: [{ type: "text", text: `Advisor '${advisorId}' has an invalid persisted call count` }],
          is_error: true,
        };
      }
      if (!Number.isInteger(advisor.max_calls) || advisor.max_calls < 1) {
        return {
          content: [{ type: "text", text: `Advisor '${advisorId}' has an invalid call limit` }],
          is_error: true,
        };
      }
      if (calls >= advisor.max_calls) {
        return {
          content: [{ type: "text", text: `Advisor '${advisorId}' call limit (${advisor.max_calls}) exceeded` }],
          is_error: true,
        };
      }
      state.advisorCalls.set(advisorId, calls + 1);
      const request = { question, ...(Object.prototype.hasOwnProperty.call(args, "context") ? { context: args.context } : {}) };
      const startedAt = Date.now();
      sendAdvisorEvent(state, {
        event: "advisor_call_started",
        run_id: state.runId,
        node_id: state.nodeId,
        advisor_id: advisor.id,
        advisor_agent_id: advisor.agent_id,
        request,
        call: calls + 1,
      });
      try {
        const result = await runner(advisor, JSON.stringify(request));
        const totalTokens = (result.usage.input_tokens ?? 0) + (result.usage.output_tokens ?? 0);
        if (totalTokens > advisor.max_tokens) {
          throw new Error(`advisor token limit exceeded: ${totalTokens} > ${advisor.max_tokens}`);
        }
        sendAdvisorEvent(state, {
          event: "advisor_call_completed",
          run_id: state.runId,
          node_id: state.nodeId,
          advisor_id: advisor.id,
          advisor_agent_id: advisor.agent_id,
          response: result.text,
          usage: result.usage,
          duration_ms: Date.now() - startedAt,
          call: calls + 1,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ advisor_id: advisor.id, advisor_agent_id: advisor.agent_id, advice: result.text, usage: result.usage }) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendAdvisorEvent(state, {
          event: "advisor_call_failed",
          run_id: state.runId,
          node_id: state.nodeId,
          advisor_id: advisor.id,
          advisor_agent_id: advisor.agent_id,
          error: message,
          duration_ms: Date.now() - startedAt,
          call: calls + 1,
        });
        return { content: [{ type: "text", text: message }], is_error: true };
      }
    },
  };
}
