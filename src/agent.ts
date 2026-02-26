import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import { runToolCall, toolDefinitions } from "./tools";
import { coreSystemPrompt, onboardingSystemPrompt, setupSystemPrompt } from "./systemPrompt";
import { Message } from "./context";

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
  }: AgentConfig
): Promise<string> {
  const resolvedSystemPrompt =
    systemPrompt ??
    (botProfile && !botProfile.isSetup
      ? setupSystemPrompt
      : user && !user.isOnboarded
        ? onboardingSystemPrompt
        : coreSystemPrompt);

  const inputMessages: OpenAI.Responses.ResponseInputItem[] = [
    {
      role: "system",
      content: resolvedSystemPrompt,
    },
  ];

  if (contextText) {
    inputMessages.push({ role: "system", content: `Context:\\n${contextText}` });
  }

  if (messages && messages.length > 0) {
    inputMessages.push(...messages);
  } else {
    inputMessages.push({ role: "user", content: input });
  }

  const response = await openai.responses.create({
    model,
    input: inputMessages,
    tools: toolDefinitions,
  });

  return handleToolLoop(openai, response, { model, maxToolCalls, prisma });
}

async function handleToolLoop(
  openai: OpenAI,
  response: OpenAI.Responses.Response,
  {
    model,
    maxToolCalls,
    prisma,
  }: { model: string; maxToolCalls: number; prisma?: PrismaClient }
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
        const result = await runToolCall(call.name as "run_command", args, {
          prisma,
        });

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
