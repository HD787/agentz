import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";

const port = Number(process.env.PORT ?? 3000);
const openaiModel = process.env.OPENAI_MODEL ?? "gpt-5";

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

    if (!input) {
      res.status(400).json({ error: "Missing or empty 'input' string." });
      return;
    }

    const response = await openai.responses.create({
      model: openaiModel,
      input: [
        {
          role: "system",
          content: "You are a helpful AI agent. Be concise and action-oriented.",
        },
        { role: "user", content: input },
      ],
    });

    const outputText = response.output_text ?? "";

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
