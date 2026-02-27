import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import { runToolCall, toolDefinitions, ToolName } from "./tools";
import {
  coreSystemPrompt,
  onboardingSystemPrompt,
  outputFormatPrompt,
  setupSystemPrompt,
} from "./systemPrompt";
import { Message } from "./context";
import { appendTaskNote, appendToolOutput } from "./taskContext";

type ToolCallItem = {
  type: "function_call";
  name: string;
  arguments?: string;
  call_id: string;
};

type ResponseOutputItem = ToolCallItem | { type: string };

type ToolOutputItem = {
  type: "function_call_output";
  call_id: string;
  output: string;
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
    tools: toolDefinitions,
  });

  let outputText = await resolveToolLoop(openai, current, {
    model,
    maxToolCalls,
    prisma,
    conversationId,
    maxRetries,
  });

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
      tools: toolDefinitions,
      previous_response_id: current.id,
      input: [{ role: "user", content: "continue" }],
    });

    outputText = await resolveToolLoop(openai, current, {
      model,
      maxToolCalls,
      prisma,
      conversationId,
      maxRetries,
    });

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
): Promise<string> {
  let current = response;

  for (let i = 0; i < maxToolCalls; i += 1) {
    const toolCalls = extractToolCalls(current.output ?? []);
    if (toolCalls.length === 0) {
      return current.output_text ?? "";
    }

    const toolOutputs = await Promise.all(
      toolCalls.map(async (call) => {
        const args = safeParseJson(call.arguments ?? "{}");
        const result = await runToolCall(call.name as ToolName, args, {
          prisma,
        });
        if (conversationId) {
          appendToolOutput(
            conversationId,
            summarizeToolResult(call.name, args, result, maxRetries)
          );
        }

        return {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        } satisfies ToolOutputItem;
      })
    );

    current = await openai.responses.create({
      model,
      tools: toolDefinitions,
      previous_response_id: current.id,
      input: toolOutputs,
    });
  }

  return current.output_text ?? "";
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
