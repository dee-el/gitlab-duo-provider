import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";
import { createGitLab } from "@gitlab/gitlab-ai-provider";
import {
  streamText,
  jsonSchema,
  wrapLanguageModel,
  type CoreMessage,
  type ToolSet,
} from "ai";

const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
if (!GITLAB_TOKEN) {
  console.error("GITLAB_TOKEN is required. Copy .env.example to .env and set your token.");
  process.exit(1);
}

const INSTANCE_URL = process.env.GITLAB_INSTANCE_URL ?? "https://gitlab.com";
const AI_GATEWAY_URL = process.env.GITLAB_AI_GATEWAY_URL;
const PORT = parseInt(process.env.PORT ?? "4141", 10);
const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "claude-sonnet-4-5-20250929";

const gitlab = createGitLab({
  apiKey: GITLAB_TOKEN,
  instanceUrl: INSTANCE_URL,
  ...(AI_GATEWAY_URL && { aiGatewayUrl: AI_GATEWAY_URL }),
});

const SUPPORTED_MODELS: Record<string, { duoModelId: string; contextLimit: number }> = {
  "claude-opus-4-6": { duoModelId: "duo-chat-opus-4-6", contextLimit: 200000 },
  "claude-opus-4-5-20251101": { duoModelId: "duo-chat-opus-4-5", contextLimit: 200000 },
  "claude-sonnet-4-5-20250929": { duoModelId: "duo-chat-sonnet-4-5", contextLimit: 200000 },
  "claude-haiku-4-5-20251001": { duoModelId: "duo-chat-haiku-4-5", contextLimit: 200000 },
};

function resolveModel(requestedModel?: string) {
  const model = requestedModel ?? DEFAULT_MODEL;
  const mapping = SUPPORTED_MODELS[model];
  if (!mapping) {
    return { duoModelId: "duo-chat-sonnet-4-5", providerModel: DEFAULT_MODEL };
  }
  return { duoModelId: mapping.duoModelId, providerModel: model };
}

function ensureObject(val: unknown): Record<string, unknown> {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: { type: string; name?: string };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

function convertMessages(req: AnthropicRequest): CoreMessage[] {
  const messages: CoreMessage[] = [];

  if (req.system) {
    const systemText =
      typeof req.system === "string"
        ? req.system
        : req.system.map((s) => s.text).join("\n");
    messages.push({ role: "system", content: systemText });
  }

  const toolNameMap = new Map<string, string>();

  for (const msg of req.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id && block.name) {
          toolNameMap.set(block.id, block.name);
        }
      }
    }
  }

  for (const msg of req.messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
        continue;
      }

      const textParts: string[] = [];
      const toolResultParts: Array<{
        type: "tool-result";
        toolCallId: string;
        toolName: string;
        output: { type: "text"; value: string };
        isError?: boolean;
      }> = [];

      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_result" && block.tool_use_id) {
          const resultText =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((c) => c.type === "text")
                    .map((c) => c.text ?? "")
                    .join("")
                : "";
          toolResultParts.push({
            type: "tool-result",
            toolCallId: block.tool_use_id,
            toolName: toolNameMap.get(block.tool_use_id) ?? block.name ?? "unknown",
            output: { type: "text", value: resultText },
            ...(block.is_error && { isError: true }),
          });
        }
      }

      if (toolResultParts.length > 0) {
        messages.push({ role: "tool", content: toolResultParts } as CoreMessage);
      }
      if (textParts.length > 0) {
        messages.push({ role: "user", content: textParts.join("\n") });
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        messages.push({ role: "assistant", content: msg.content });
        continue;
      }

      const parts: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: Record<string, unknown> }
      > = [];

      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use" && block.id && block.name) {
          parts.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: ensureObject(block.input),
          });
        }
      }

      messages.push({ role: "assistant", content: parts } as CoreMessage);
    }
  }

  return messages;
}

function convertTools(tools?: AnthropicRequest["tools"]): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;

  const result: ToolSet = {};
  for (const tool of tools) {
    result[tool.name] = {
      description: tool.description,
      inputSchema: jsonSchema(tool.input_schema),
    };
  }
  return result;
}

type AiToolChoice = Parameters<typeof streamText>[0]["toolChoice"];

function convertToolChoice(
  choice?: AnthropicRequest["tool_choice"]
): AiToolChoice | undefined {
  if (!choice) return undefined;

  switch (choice.type) {
    case "auto":
      return { type: "auto" } as unknown as AiToolChoice;
    case "any":
      return { type: "required" } as unknown as AiToolChoice;
    case "tool":
      if (choice.name) {
        return { type: "tool", toolName: choice.name } as unknown as AiToolChoice;
      }
      return undefined;
    default:
      return undefined;
  }
}

function makeMessageId() {
  return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

const app = new Hono();

app.get("/", (c) =>
  c.json({
    name: "gitlab-duo-provider",
    description: "Anthropic-compatible proxy for GitLab Duo AI Gateway",
    endpoints: ["/v1/messages", "/v1/models"],
  })
);

app.get("/v1/models", (c) => {
  const models = Object.entries(SUPPORTED_MODELS).map(([id, info]) => ({
    id,
    object: "model",
    created: Date.now(),
    owned_by: "gitlab-duo",
    context_window: info.contextLimit,
  }));
  return c.json({ object: "list", data: models });
});

app.post("/v1/messages", async (c) => {
  const body = (await c.req.json()) as AnthropicRequest;

  if (process.env.DEBUG) {
    console.log("[DEBUG] Incoming request:");
    console.log(JSON.stringify(body.messages, null, 2));
  }
  const { duoModelId, providerModel } = resolveModel(body.model);
  const messages = convertMessages(body);
  const tools = convertTools(body.tools);
  const toolChoice = convertToolChoice(body.tool_choice);

  if (process.env.DEBUG) {
    console.log("[DEBUG] Converted messages:");
    console.log(JSON.stringify(messages, null, 2));
  }

  const rawModel = gitlab.agenticChat(duoModelId, {
    providerModel,
    maxTokens: body.max_tokens ?? 8192,
  });

  const model = wrapLanguageModel({
    model: rawModel as never,
    middleware: {
      transformParams: async ({ params }) => {
        const prompt = [...params.prompt];
        const last = prompt[prompt.length - 1];
        if (last?.role === "assistant") {
          const hasContent = last.content.some(
            (p: { type: string; text?: string }) =>
              (p.type === "text" && p.text !== "") || p.type === "tool-call"
          );
          if (!hasContent) {
            prompt.pop();
          }
        }
        return { ...params, prompt };
      },
    },
  });

  const result = streamText({
    model: model as never,
    messages,
    tools,
    toolChoice,
    temperature: body.temperature,
    topP: body.top_p,
    maxOutputTokens: body.max_tokens ?? 8192,
    abortSignal: c.req.raw.signal,
  });

  if (body.stream) {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return honoStream(c, async (stream) => {
      const msgId = makeMessageId();

      await stream.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model: providerModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })}\n\n`
      );

      let contentIndex = 0;
      let textBlockOpen = false;
      let toolBlockOpen = false;

      try {
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            if (!textBlockOpen) {
              await stream.write(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: contentIndex,
                  content_block: { type: "text", text: "" },
                })}\n\n`
              );
              textBlockOpen = true;
            }

            await stream.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "text_delta", text: part.text },
              })}\n\n`
            );
          } else if (part.type === "tool-input-start") {
            if (textBlockOpen) {
              await stream.write(
                `event: content_block_stop\ndata: ${JSON.stringify({
                  type: "content_block_stop",
                  index: contentIndex,
                })}\n\n`
              );
              contentIndex++;
              textBlockOpen = false;
            }

            toolBlockOpen = true;
            await stream.write(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: contentIndex,
                content_block: {
                  type: "tool_use",
                  id: part.id,
                  name: part.toolName,
                  input: {},
                },
              })}\n\n`
            );
          } else if (part.type === "tool-input-delta") {
            await stream.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "input_json_delta", partial_json: part.delta },
              })}\n\n`
            );
          } else if (part.type === "tool-input-end") {
            if (toolBlockOpen) {
              await stream.write(
                `event: content_block_stop\ndata: ${JSON.stringify({
                  type: "content_block_stop",
                  index: contentIndex,
                })}\n\n`
              );
              contentIndex++;
              toolBlockOpen = false;
            }
          } else if (part.type === "finish-step") {
            if (textBlockOpen) {
              await stream.write(
                `event: content_block_stop\ndata: ${JSON.stringify({
                  type: "content_block_stop",
                  index: contentIndex,
                })}\n\n`
              );
              contentIndex++;
              textBlockOpen = false;
            }

            let stopReason = "end_turn";
            if (part.finishReason === "tool-calls") stopReason = "tool_use";
            else if (part.finishReason === "length") stopReason = "max_tokens";

            await stream.write(
              `event: message_delta\ndata: ${JSON.stringify({
                type: "message_delta",
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: part.usage?.outputTokens ?? 0 },
              })}\n\n`
            );

            await stream.write(`event: message_stop\ndata: {}\n\n`);
          } else if (part.type === "finish") {
            if (textBlockOpen) {
              await stream.write(
                `event: content_block_stop\ndata: ${JSON.stringify({
                  type: "content_block_stop",
                  index: contentIndex,
                })}\n\n`
              );
              textBlockOpen = false;
            }
            if (toolBlockOpen) {
              await stream.write(
                `event: content_block_stop\ndata: ${JSON.stringify({
                  type: "content_block_stop",
                  index: contentIndex,
                })}\n\n`
              );
              toolBlockOpen = false;
            }
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error during streaming";
        console.error("Stream error:", errorMsg);
        await stream.write(
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            error: { type: "api_error", message: errorMsg },
          })}\n\n`
        );
      }
    });
  }

  try {
    const content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }> = [];

    let finishReason = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const part of result.fullStream) {
      if (part.type === "tool-call") {
        content.push({
          type: "tool_use",
          id: part.toolCallId,
          name: part.toolName,
          input: ensureObject(part.input),
        });
      } else if (part.type === "finish-step") {
        if (part.finishReason === "tool-calls") finishReason = "tool_use";
        else if (part.finishReason === "length") finishReason = "max_tokens";
        inputTokens += part.usage?.inputTokens ?? 0;
        outputTokens += part.usage?.outputTokens ?? 0;
      }
    }

    const text = await result.text;
    if (text) {
      content.unshift({ type: "text", text });
    }

    return c.json({
      id: makeMessageId(),
      type: "message",
      role: "assistant",
      model: providerModel,
      content,
      stop_reason: finishReason,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    console.error("Generate error:", errorMsg);
    return c.json(
      { type: "error", error: { type: "api_error", message: errorMsg } },
      500
    );
  }
});

console.log(`
  gitlab-duo-provider v1.0.0
  Anthropic-compatible proxy for GitLab Duo AI Gateway

  Instance:  ${INSTANCE_URL}
  Gateway:   ${AI_GATEWAY_URL ?? "https://cloud.gitlab.com"}
  Model:     ${DEFAULT_MODEL}
  Port:      ${PORT}

  Endpoints:
    POST http://localhost:${PORT}/v1/messages   (Anthropic Messages API)
    GET  http://localhost:${PORT}/v1/models     (List models)

  Configure Goose:
    goose configure -> Custom Providers -> gitlab_duo
`);

serve({ fetch: app.fetch, port: PORT });
