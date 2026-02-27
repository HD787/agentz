import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import { runAgent } from "./agent";
import { buildContext, getOrCreateConversation, getOrCreateUser } from "./context";
import { getTaskContext } from "./taskContext";

const port = Number(process.env.PORT ?? 3000);
const openaiModel = process.env.OPENAI_MODEL ?? "gpt-5";
const telegramWebhookPath = process.env.TELEGRAM_WEBHOOK_PATH;
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const agentMaxToolCalls = Number(process.env.AGENT_MAX_TOOL_CALLS ?? 6);
const agentMaxSteps = Number(process.env.AGENT_MAX_STEPS ?? 6);
const agentMaxRetries = Number(process.env.AGENT_MAX_RETRIES ?? 1);

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY in environment.");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const prisma = new PrismaClient();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/agent", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = typeof req.body?.input === "string" ? req.body.input.trim() : "";
    const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : undefined;
    const conversationId =
      typeof req.body?.conversationId === "string" ? req.body.conversationId.trim() : undefined;

    if (!input) {
      res.status(400).json({ error: "Missing or empty 'input' string." });
      return;
    }

    const conversation = await getOrCreateConversation(prisma, {
      conversationId,
      userId,
    });

    await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        content: input,
      },
    });

    const context = await buildContext(prisma, {
      conversationId: conversation.id,
      userId: conversation.userId ?? userId,
    });

    const taskContext = getTaskContext(conversation.id);
    const contextText = taskContext
      ? `${context.contextText}\nTask context:\n${taskContext}`
      : context.contextText;

    const outputText = await runAgent(openai, input, {
      model: openaiModel,
      contextText,
      messages: context.messages,
      prisma,
      botProfile: context.botProfile ?? null,
      user: context.user ?? null,
      conversationId: conversation.id,
      maxToolCalls: agentMaxToolCalls,
      maxSteps: agentMaxSteps,
      maxRetries: agentMaxRetries,
    });

    await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        content: outputText,
      },
    });

    await prisma.agentRun.create({
      data: {
        input,
        output: outputText,
      },
    });

    res.json({ output: outputText });
  } catch (err) {
    next(err);
  }
});

if (telegramWebhookPath) {
  app.post(telegramWebhookPath, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const update = req.body;
      const messageText =
        typeof update?.message?.text === "string" ? update.message.text.trim() : "";
      const chatId = update?.message?.chat?.id;
      const username =
        typeof update?.message?.from?.username === "string"
          ? update.message.from.username
          : undefined;

      if (!messageText) {
        res.json({ ok: true });
        return;
      }

      const user =
        typeof chatId === "number"
          ? await getOrCreateUser(prisma, {
              provider: "telegram",
              externalId: String(chatId),
              name: username,
            })
          : null;

      const conversation = await getOrCreateConversation(prisma, {
        userId: user?.id,
        title: username ? `Telegram @${username}` : undefined,
      });

      await prisma.chatMessage.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          content: messageText,
        },
      });

      const context = await buildContext(prisma, {
        conversationId: conversation.id,
        userId: user?.id,
      });

      const taskContext = getTaskContext(conversation.id);
      const contextText = taskContext
        ? `${context.contextText}\nTask context:\n${taskContext}`
        : context.contextText;

      const outputText = await runAgent(openai, messageText, {
        model: openaiModel,
        contextText,
        messages: context.messages,
        prisma,
        botProfile: context.botProfile ?? null,
        user: context.user ?? null,
        conversationId: conversation.id,
        maxToolCalls: agentMaxToolCalls,
        maxSteps: agentMaxSteps,
        maxRetries: agentMaxRetries,
      });

      await prisma.chatMessage.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          content: outputText,
        },
      });

      if (telegramBotToken && typeof chatId === "number") {
        await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: outputText }),
        });
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

async function start() {
  await prisma.$connect();
  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
