/**
 * handoff DAG tool — send work result to downstream node.
 * @version 0.1.0
 */

import type { DagToolDefinition } from "../agent/types.js";
import type { DagToolsState } from "./index.js";

function normalizeHandoffContent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if ((!trimmed.startsWith("{") || !trimmed.endsWith("}")) &&
      (!trimmed.startsWith("[") || !trimmed.endsWith("]"))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function createHandoffTool(state: DagToolsState): DagToolDefinition {
  return {
    name: "handoff",
    description:
      "将工作成果交接给下游节点。**每轮只能调用一次**，调用后本轮立即结束。" +
      "根据当前阶段选择正确的输出端口（port），提供交接内容（content）。" +
      "若 pinned Surface 合同声明 required_phases，必须先完成整段 report_surface_state 序列；否则 handoff 会被拒绝。",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        port: {
          type: "string",
          ...(state.availablePorts.length > 0 ? { enum: state.availablePorts } : {}),
          description: "输出端口名（必须是系统提示中列出的可用端口之一）",
        },
        content: {
          description:
            "完整交接内容（JSON 值，任意类型）。输出契约要求的所有字段都必须放在 content 内；" +
            "除 port、content 和可选 summary 外，不要把契约字段放在工具参数顶层。",
        },
        summary: {
          type: "string",
          description: "给下游的一句话摘要（可选）",
        },
      },
      required: ["port", "content"],
    },
    handler: async (args: Record<string, unknown>) => {
      if (state.yielded) {
        return {
          content: [
            {
              type: "text" as const,
              text: "错误：本轮已经调用过 handoff，不能重复调用。每轮只能调用一次 handoff，直接结束本轮即可。",
            },
          ],
          is_error: true,
        };
      }
      const unexpectedKeys = Object.keys(args).filter((key) => !["port", "content", "summary"].includes(key));
      if (unexpectedKeys.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `无效的 handoff 参数: ${unexpectedKeys.join(", ")}。` +
                "输出契约字段必须全部放入 content 对象；工具参数顶层只允许 port、content 和可选 summary。请修正后重新调用 handoff。",
            },
          ],
          is_error: true,
        };
      }
      const port = String(args.port ?? "");
      const content = normalizeHandoffContent(args.content ?? "");
      const summary = String(args.summary ?? "");

      // Validate port
      if (!state.availablePorts.includes(port)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `无效的输出端口: ${port}。可用端口: ${state.availablePorts.join(", ")}`,
            },
          ],
          is_error: true,
        };
      }

      if (state.surfaceReportingRequired && !state.surfaceReportingComplete) {
        const fatal = state.surfaceReportingFatalError;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "rejected",
              code: fatal ? "surface_reporting_blocked" : "surface_sequence_incomplete",
              message: fatal?.message ?? "required Actor Surface phases are incomplete",
              retryable: !fatal,
              ...(state.surfaceExpectedPhase ? { expected_phase: state.surfaceExpectedPhase } : {}),
              next_action: fatal
                ? "Do not claim a successful handoff. End this turn so the runtime records the immutable Surface input-contract failure."
                : `Call report_surface_state with phase ${state.surfaceExpectedPhase ?? "required by the pinned contract"} before handoff.`,
            }),
          }],
          is_error: true,
        };
      }

      // Include both TS Manager response-bridge fields and legacy Python
      // Manager DAG handoff fields while both runtimes coexist.
      const payload = {
        type: "node_handoff",
        runId: state.runId,
        nodeId: state.nodeId,
        port,
        from_node: state.nodeId,
        from_port: port,
        session_id: state.sessionId,
        ...(state.roundId !== undefined ? { round_id: state.roundId } : {}),
        ...(state.actorId !== undefined ? { actor_id: state.actorId } : {}),
        ...(state.generation !== undefined ? { generation: state.generation } : {}),
        ...(state.leaseGeneration !== undefined ? { lease_generation: state.leaseGeneration } : {}),
        ...(state.commandId !== undefined ? { command_id: state.commandId } : {}),
        content,
        summary,
      };

      // PromptRunner owns terminal transport so Manager contract correction
      // cannot race the still-active prompt lifecycle.
      state.yielded = true;
      state.handoffData = payload;

      // Build downstream info
      const edge = state.outgoingEdges.find((e) => e.from_port === port);
      let downstreamInfo = "";
      if (edge?.to_node) {
        downstreamInfo = `\n下游节点: ${edge.to_node} (端口: ${edge.to_port})`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `交接成功\n端口: ${port}${downstreamInfo}`,
          },
        ],
      };
    },
  };
}
