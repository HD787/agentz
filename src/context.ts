import { PrismaClient } from "@prisma/client";
import { toolDefinitions } from "./tools";

export type MessageRole = "system" | "user" | "assistant";

export type Message = {
  role: MessageRole;
  content: string;
};

export type ContextResult = {
  contextText: string;
  messages: Message[];
  conversationId?: string;
  userId?: string;
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
};

export type ContextOptions = {
  conversationId?: string;
  userId?: string;
  conversationTitle?: string;
};

export async function buildContext(
  prisma: PrismaClient,
  options: ContextOptions
): Promise<ContextResult> {
  const botProfile = await resolveOrCreateBotProfile(prisma);
  const conversation = await getOrCreateConversation(prisma, {
    conversationId: options.conversationId,
    userId: options.userId,
    title: options.conversationTitle,
  });
  const user = conversation?.userId
    ? await prisma.user.findUnique({ where: { id: conversation.userId } })
    : null;

  const [messages, commandHistory, scripts, runningProcesses] = await Promise.all([
    getRecentMessages(prisma, conversation?.id),
    getRecentCommands(prisma),
    getScripts(prisma),
    getRunningProcesses(prisma),
  ]);

  const contextText = buildContextText({
    botProfile,
    conversation,
    user,
    commandHistory,
    scripts,
    runningProcesses,
  });

  return {
    contextText,
    messages,
    conversationId: conversation?.id,
    userId: conversation?.userId ?? options.userId,
    botProfile,
    user,
  };
}

export async function getOrCreateConversation(
  prisma: PrismaClient,
  options: {
    conversationId?: string;
    userId?: string;
    title?: string;
  }
) {
  if (options.conversationId) {
    const existing = await prisma.conversation.findUnique({
      where: { id: options.conversationId },
    });
    if (existing) {
      return existing;
    }
  }

  const existing = await prisma.conversation.findFirst({
    where: {
      userId: options.userId ?? undefined,
    },
    orderBy: { updatedAt: "desc" },
  });

  if (existing) {
    return existing;
  }

  return prisma.conversation.create({
    data: {
      userId: options.userId,
      title: options.title,
    },
  });
}

export async function getOrCreateUser(
  prisma: PrismaClient,
  options: { provider: string; externalId: string; name?: string }
) {
  const existing = await prisma.user.findFirst({
    where: {
      provider: options.provider,
      externalId: options.externalId,
    },
  });

  if (existing) {
    return existing;
  }

  return prisma.user.create({
    data: {
      provider: options.provider,
      externalId: options.externalId,
      name: options.name,
    },
  });
}

async function resolveOrCreateBotProfile(prisma: PrismaClient) {
  const existing = await prisma.botProfile.findFirst({ orderBy: { createdAt: "asc" } });
  if (existing) {
    return existing;
  }

  return prisma.botProfile.create({
    data: {
      name: "Unnamed Bot",
      sandboxPath: "",
      isSetup: false,
    },
  });
}

async function getRecentMessages(prisma: PrismaClient, conversationId?: string) {
  if (!conversationId) {
    return [] as Message[];
  }

  const items = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return items
    .reverse()
    .map((item) => ({ role: item.role as MessageRole, content: item.content }));
}

async function getRecentCommands(prisma: PrismaClient) {
  return prisma.commandHistory.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      command: true,
      args: true,
      cwd: true,
      status: true,
      exitCode: true,
      createdAt: true,
    },
  });
}

async function getScripts(prisma: PrismaClient) {
  return prisma.script.findMany({
    orderBy: { path: "asc" },
    select: {
      id: true,
      path: true,
      expectedParams: true,
      description: true,
      updatedAt: true,
    },
  });
}

async function getRunningProcesses(prisma: PrismaClient) {
  return prisma.runningProcess.findMany({
    where: {
      OR: [{ endedAt: null }, { status: "running" }],
    },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      pid: true,
      command: true,
      args: true,
      cwd: true,
      status: true,
      startedAt: true,
    },
  });
}

function buildContextText(input: {
  botProfile: {
    id: string;
    name: string;
    sandboxPath: string;
    isSetup: boolean;
  } | null;
  conversation: { id: string; userId: string | null; title: string | null } | null;
  user?: { id: string; name: string | null; isOnboarded: boolean } | null;
  commandHistory: unknown[];
  scripts: unknown[];
  runningProcesses: unknown[];
}) {
  const sections: string[] = [];

  sections.push(
    `Bot profile: ${
      input.botProfile
        ? JSON.stringify({
            id: input.botProfile.id,
            name: input.botProfile.name,
            sandboxPath: input.botProfile.sandboxPath,
            isSetup: input.botProfile.isSetup,
          })
        : "none"
    }`
  );

  sections.push(
    `User: ${
      input.user
        ? JSON.stringify({
            id: input.user.id,
            name: input.user.name,
            isOnboarded: input.user.isOnboarded,
          })
        : "none"
    }`
  );

  sections.push(
    `Conversation: ${
      input.conversation
        ? JSON.stringify({
            id: input.conversation.id,
            userId: input.conversation.userId,
            title: input.conversation.title,
          })
        : "none"
    }`
  );

  sections.push(`Running processes: ${JSON.stringify(input.runningProcesses)}`);
  sections.push(`Recent commands: ${JSON.stringify(input.commandHistory)}`);
  sections.push(`Scripts: ${JSON.stringify(input.scripts)}`);

  const toolSummary = toolDefinitions.map((tool) => tool.function);
  sections.push(`Available tools: ${JSON.stringify(toolSummary)}`);

  return sections.join("\n");
}
