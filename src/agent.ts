import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import { runToolCall, toolDefinitions, ToolName } from "./tools.js";
import {
  coreSystemPrompt,
  onboardingSystemPrompt,
  outputFormatPrompt,
  setupSystemPrompt,
} from "./systemPrompt.js";
import { Message } from "./context.js";
import { appendTaskNote, appendToolOutput } from "./taskContext.js";

const responseTools: OpenAI.Responses.Tool[] = toolDefinitions.map((tool) => ({
  type: "function",
  name: tool.function.name,
  description: tool.function.description,
  parameters: tool.function.parameters,
  strict: false,
}));

type ToolCallItem = {
  type: "function_call";
  name: string;
  arguments?: string;
  call_id?: string;
  id?: string;
};

type ResponseOutputItem = ToolCallItem | { type: string };

type ToolOutputItem = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

type ResolveToolLoopResult = {
  response: OpenAI.Responses.Response;
  outputText: string;
};

export type AgentConfig = {
  model: string;
  systemPrompt?: string;
  contextText?: string;
  messages?: Message[];
  prisma?: PrismaClient;
  botProfile?: {
    id: string;
    name: string;
    sandboxPath: string;
    isSetup: boolean;
  } | null;
  user?: {
    id: string;
    name: string | null;
    isOnboarded: boolean;
  } | null;
  maxToolCalls?: number;
  maxSteps?: number;
  maxRetries?: number;
  conversationId?: string;
};

export async function runAgent(
  openai: OpenAI,
  input: string,
  {
    model,
    systemPrompt,
    contextText,
    messages,
    prisma,
    botProfile,
    user,
    maxToolCalls = 4,
    maxSteps = 6,
    maxRetries = 1,
    conversationId,
  }: AgentConfig
): Promise<string> {
  const resolvedSystemPrompt =
    systemPrompt ??
    (botProfile && !botProfile.isSetup
      ? setupSystemPrompt
      : user && !user.isOnboarded
        ? onboardingSystemPrompt
        : coreSystemPrompt);

  const corePathsPrompt =
    botProfile?.sandboxPath && botProfile.isSetup
      ? [
          "Sandbox directories:",
          `Root: ${botProfile.sandboxPath}`,
          `Scripts: ${botProfile.sandboxPath}/scripts`,
          `Skills: ${botProfile.sandboxPath}/skills`,
        ].join(" ")
      : undefined;

  const baseInput = buildInputMessages({
    systemPrompt: resolvedSystemPrompt,
    contextText,
    messages,
    input,
    extraSystem: corePathsPrompt
      ? `${outputFormatPrompt} ${corePathsPrompt}`
      : outputFormatPrompt,
  });

  let current = await openai.responses.create({
    model,
    input: baseInput,
    tools: responseTools,
  });

  let resolved = await resolveToolLoop(openai, current, {
    model,
    maxToolCalls,
    prisma,
    conversationId,
    maxRetries,
  });
  current = resolved.response;
  let outputText = resolved.outputText;

  let collected = collectTaggedMessages(outputText);
  if (collected.reasoning && conversationId) {
    appendTaskNote(conversationId, collected.reasoning);
  }

  for (let step = 0; step < maxSteps; step += 1) {
    if (hasDoneTag(outputText)) {
      return collected.message || outputText;
    }

    current = await openai.responses.create({
      model,
      tools: responseTools,
      previous_response_id: current.id,
      input: [{ role: "user", content: "continue" }],
    });

    resolved = await resolveToolLoop(openai, current, {
      model,
      maxToolCalls,
      prisma,
      conversationId,
      maxRetries,
    });
    current = resolved.response;
    outputText = resolved.outputText;

    const next = collectTaggedMessages(outputText);
    if (next.message) {
      collected.message = collected.message
        ? `${collected.message}\n${next.message}`
        : next.message;
    }
    if (next.reasoning && conversationId) {
      appendTaskNote(conversationId, next.reasoning);
    }
  }

  return collected.message || outputText;
}

async function resolveToolLoop(
  openai: OpenAI,
  response: OpenAI.Responses.Response,
  {
    model,
    maxToolCalls,
    prisma,
    conversationId,
    maxRetries,
  }: {
    model: string;
    maxToolCalls: number;
    prisma?: PrismaClient;
    conversationId?: string;
    maxRetries: number;
  }
): Promise<ResolveToolLoopResult> {
  let current = response;

  for (let i = 0; ; i += 1) {
    const toolCalls = extractToolCalls(current.output ?? []);
    if (toolCalls.length === 0) {
      return { response: current, outputText: current.output_text ?? "" };
    }

    if (i >= maxToolCalls) {
      const forcedOutputs = toolCalls
        .map((call) => {
          const callId = getToolCallId(call);
          if (!callId) {
            return null;
          }

          const limitResult = {
            ok: false,
            error: `Tool call limit reached (${maxToolCalls}).`,
            tool: call.name,
          };
          if (conversationId) {
            appendToolOutput(
              conversationId,
              summarizeToolResult(call.name, safeParseJson(call.arguments ?? "{}"), limitResult, maxRetries)
            );
          }

          return {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(limitResult),
          } satisfies ToolOutputItem;
        })
        .filter((item): item is ToolOutputItem => item !== null);

      if (forcedOutputs.length === 0) {
        return { response: current, outputText: current.output_text ?? "" };
      }

      current = await openai.responses.create({
        model,
        tools: responseTools,
        previous_response_id: current.id,
        input: forcedOutputs,
      });

      return { response: current, outputText: current.output_text ?? "" };
    }

    const toolOutputs = await Promise.all(
      toolCalls.map(async (call) => {
        const callId = getToolCallId(call);
        if (!callId) {
          const missingCallIdResult = {
            ok: false,
            error: "Missing tool call id from model response.",
            tool: call.name,
          };
          return {
            type: "function_call_output",
            call_id: "",
            output: JSON.stringify(missingCallIdResult),
          } satisfies ToolOutputItem;
        }

        const args = safeParseJson(call.arguments ?? "{}");
        let result: unknown;
        try {
          result = await runToolCall(call.name as ToolName, args, {
            prisma,
          });
        } catch (err) {
          const error = err as Error;
          result = {
            ok: false,
            error: error.message ?? String(err),
            tool: call.name,
          };
        }
        if (conversationId) {
          appendToolOutput(
            conversationId,
            summarizeToolResult(call.name, args, result, maxRetries)
          );
        }

        return {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(result),
        } satisfies ToolOutputItem;
      })
    );

    const validToolOutputs = toolOutputs.filter((item) => item.call_id);
    if (validToolOutputs.length === 0) {
      return { response: current, outputText: current.output_text ?? "" };
    }

    current = await openai.responses.create({
      model,
      tools: responseTools,
      previous_response_id: current.id,
      input: validToolOutputs,
    });
  }
}

function extractToolCalls(items: ResponseOutputItem[]): ToolCallItem[] {
  return items.filter((item): item is ToolCallItem => item.type === "function_call");
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function getToolCallId(call: ToolCallItem): string | null {
  if (typeof call.call_id === "string" && call.call_id.length > 0) {
    return call.call_id;
  }
  if (typeof call.id === "string" && call.id.length > 0) {
    return call.id;
  }
  return null;
}

function buildInputMessages(input: {
  systemPrompt: string;
  contextText?: string;
  messages?: Message[];
  input: string;
  extraSystem?: string;
}) {
  const items: OpenAI.Responses.ResponseInputItem[] = [
    {
      role: "system",
      content: input.systemPrompt,
    },
  ];

  if (input.extraSystem) {
    items.push({ role: "system", content: input.extraSystem });
  }

  if (input.contextText) {
    items.push({ role: "system", content: `Context:\n${input.contextText}` });
  }

  if (input.messages && input.messages.length > 0) {
    items.push(...input.messages);
  } else {
    items.push({ role: "user", content: input.input });
  }

  return items;
}

function summarizeToolResult(
  name: string,
  args: unknown,
  result: unknown,
  maxRetries: number
) {
  const argsText = truncate(JSON.stringify(args), 800);
  const resultText = truncate(JSON.stringify(result), 2000);
  return `Tool ${name} args=${argsText} result=${resultText} maxRetries=${maxRetries}`;
}

function truncate(value: string, max: number) {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function collectTaggedMessages(text: string) {
  const messageTags = extractTag(text, "message");
  const reasoningTags = extractTag(text, "reasoning");
  const message = messageTags.join("\n").trim();
  const reasoning = reasoningTags.join("\n").trim();

  if (message) {
    return { message, reasoning };
  }

  const fallback = stripTags(text, ["reasoning", "done"]).trim();
  return { message: fallback, reasoning };
}

function extractTag(text: string, tag: string) {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function hasDoneTag(text: string) {
  return /<done\s*\/?>/i.test(text) || /<done>[\s\S]*?<\/done>/i.test(text);
}

function stripTags(text: string, tags: string[]) {
  let output = text;
  for (const tag of tags) {
    const openClose = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "gi");
    const selfClosing = new RegExp(`<${tag}\\s*\\/?>`, "gi");
    output = output.replace(openClose, "").replace(selfClosing, "");
  }
  return output;
}
