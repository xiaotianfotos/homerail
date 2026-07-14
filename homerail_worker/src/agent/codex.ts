/**
 * Codex adapter — OpenAI-compatible API with Codex tool-use conventions.
 *
 * Codex returns a single function_call per response (not parallel tool_calls).
 * We normalize this to the standard homerail-protocol tool_use/tool_result events.
 * @version 0.1.0
 */

import type { AgentClient, AgentEvent, AgentRunContext, DagToolDefinition } from "./types.js";

interface CodexMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  function_call?: { name: string; arguments: string };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildToolSchemas(tools: DagToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

async function callCodex(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: CodexMessage[],
  toolSchemas: ReturnType<typeof buildToolSchemas>,
): Promise<{
  content: string | null;
  function_call?: { name: string; arguments: string };
}> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: Record<string, unknown> = { model, messages, max_tokens: 4096 };
  if (toolSchemas.length > 0) body.tools = toolSchemas;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Codex API error ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as {
    choices: Array<{
      message: {
        content: string | null;
        function_call?: { name: string; arguments: string };
      };
    }>;
  };

  const msg = data.choices?.[0]?.message;
  return {
    content: msg?.content ?? null,
    function_call: msg?.function_call,
  };
}

export class CodexAdapter implements AgentClient {
  async *run(
    prompt: string,
    tools: DagToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    const maxIterations = context.maxIterations ?? 10;
    const toolSchemas = buildToolSchemas(tools);
    const toolMap = new Map<string, DagToolDefinition>();
    for (const t of tools) toolMap.set(t.name, t);

    const messages: CodexMessage[] = [];
    if (context.systemPrompt) {
      messages.push({ role: "system", content: context.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    for (let i = 0; i < maxIterations; i++) {
      let response: { content: string | null; function_call?: { name: string; arguments: string } };
      try {
        response = await callCodex(
          context.baseUrl,
          context.apiKey,
          context.model,
          messages,
          toolSchemas,
        );
      } catch (err) {
        yield {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        };
        return;
      }

      if (response.content) {
        yield { type: "text", text: response.content };
      }

      if (!response.function_call) {
        messages.push({
          role: "assistant",
          content: response.content ?? "",
        });
        yield { type: "done" };
        return;
      }

      // Codex single function_call → normalize to tool_use event
      const fc = response.function_call;
      const toolUseId = `codex-${Date.now()}-${i}`;
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(fc.arguments);
      } catch {
        yield {
          type: "error",
          message: `Codex returned unparseable tool arguments: ${fc.arguments.slice(0, 200)}`,
        };
        return;
      }

      yield {
        type: "tool_use",
        id: toolUseId,
        name: fc.name,
        input,
      };

      // Execute tool
      const def = toolMap.get(fc.name);
      let toolContent: string;
      let isError = false;
      if (!def) {
        toolContent = `Unknown tool: ${fc.name}`;
        isError = true;
      } else {
        try {
          const result = await def.handler(input, { tool_call_id: toolUseId });
          const blocks = result.content as Array<{ type: string; text?: string }> | undefined;
          toolContent = blocks?.map((b) => b.text ?? "").join("") ?? JSON.stringify(result);
          isError = result.is_error === true;
        } catch (err) {
          toolContent = `Tool ${fc.name} threw: ${err}`;
          isError = true;
        }
      }

      yield {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: toolContent,
        is_error: isError,
      };

      messages.push({
        role: "assistant",
        content: response.content ?? "",
        function_call: fc,
      });
      messages.push({
        role: "tool",
        content: toolContent,
        tool_call_id: toolUseId,
      });
    }

    yield { type: "error", message: `Exceeded max iterations (${maxIterations})` };
  }
}
