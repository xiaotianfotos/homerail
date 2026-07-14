import type { DagActivityType } from "homerail-protocol";
import type { DagToolDefinition } from "../agent/types.js";

type ReportableActivityType = Extract<DagActivityType, "progress" | "finding" | "blocked">;

export function createReportActivityTool(
  emit: (type: ReportableActivityType, payload: Record<string, unknown>) => void,
): DagToolDefinition {
  return {
    name: "report_activity",
    description: "Report meaningful progress, a finding, or a blocker to the durable DAG activity journal.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["progress", "finding", "blocked"] },
        message: { type: "string", minLength: 1, maxLength: 4000 },
        data: { type: "object", additionalProperties: true },
      },
      required: ["type", "message"],
      additionalProperties: false,
    },
    async handler(args: Record<string, unknown>) {
      const type = args.type;
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if ((type !== "progress" && type !== "finding" && type !== "blocked") || !message || message.length > 4000) {
        return {
          content: [{ type: "text", text: "type must be progress, finding, or blocked and message must contain 1 to 4000 characters" }],
          is_error: true,
        };
      }
      const data = args.data;
      emit(type, {
        message,
        ...(typeof data === "object" && data !== null && !Array.isArray(data) ? { data } : {}),
      });
      return {
        content: [{ type: "text", text: `Activity ${type} recorded.` }],
      };
    },
  };
}
