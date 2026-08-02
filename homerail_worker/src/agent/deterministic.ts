/**
 * Deterministic agent backend — parses HANDOFF directives from the prompt
 * and executes them without any LLM call.
 * @version 0.1.0
 */

import type { AgentClient, AgentEvent, AgentRunContext, DagToolDefinition } from "./types.js";

const DIRECTIVE_RE = /(?:^|\n)\s*HANDOFF\s+port=(\S+)\s+content=([\s\S]+)$/;

export class DeterministicClient implements AgentClient {
  async *run(
    prompt: string,
    tools: DagToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    const directiveSource = [prompt, context.systemPrompt ?? ""].find((source) =>
      DIRECTIVE_RE.test(source),
    ) ?? prompt;
    const match = directiveSource.match(DIRECTIVE_RE);
    if (!match) {
      yield {
        type: "error",
        message: `Invalid deterministic directive. Expected "HANDOFF port=<name> content=<text>". Got: ${directiveSource}`,
      };
      yield { type: "done" };
      return;
    }

    const port = match[1]!;
    const content = match[2]!;

    yield { type: "text", text: `[deterministic] handoff port=${port} content=${content}` };

    const handoffTool = tools.find((t) => t.name === "handoff");
    if (!handoffTool) {
      yield { type: "error", message: "handoff tool not found in available tools" };
      yield { type: "done" };
      return;
    }

    const toolUseId = "det-handoff-1";
    yield {
      type: "tool_use",
      id: toolUseId,
      name: "handoff",
      input: { port, content },
    };

    const result = await handoffTool.handler({ port, content });
    const text =
      result.content
        ?.map((b: { type: string; text?: string }) => b.text ?? "")
        .join("") ?? "";

    yield {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: text,
      is_error: result.is_error === true,
    };

    yield {
      type: "done",
      termination: {
        stop_reason: "end_turn",
        output_tokens: 0,
        output_token_limit: null,
        tool_argument_parse: result.is_error === true ? "invalid" : "ok",
      },
    };
  }
}
