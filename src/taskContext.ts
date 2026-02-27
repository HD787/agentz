type TaskEntry = {
  timestamp: string;
  kind: "tool" | "note";
  content: string;
};

type TaskContext = {
  entries: TaskEntry[];
};

const taskContexts = new Map<string, TaskContext>();

function getContext(conversationId: string) {
  const existing = taskContexts.get(conversationId);
  if (existing) {
    return existing;
  }

  const created: TaskContext = { entries: [] };
  taskContexts.set(conversationId, created);
  return created;
}

export function appendToolOutput(
  conversationId: string,
  content: string
) {
  const ctx = getContext(conversationId);
  ctx.entries.push({
    timestamp: new Date().toISOString(),
    kind: "tool",
    content,
  });

  if (ctx.entries.length > 200) {
    ctx.entries.splice(0, ctx.entries.length - 200);
  }
}

export function appendTaskNote(conversationId: string, content: string) {
  const ctx = getContext(conversationId);
  ctx.entries.push({
    timestamp: new Date().toISOString(),
    kind: "note",
    content,
  });

  if (ctx.entries.length > 200) {
    ctx.entries.splice(0, ctx.entries.length - 200);
  }
}

export function getTaskContext(conversationId: string, limit = 50) {
  const ctx = taskContexts.get(conversationId);
  if (!ctx || ctx.entries.length === 0) {
    return "";
  }

  const slice = ctx.entries.slice(-limit);
  return slice
    .map((entry) => `[${entry.timestamp}] ${entry.kind.toUpperCase()}: ${entry.content}`)
    .join("\n");
}

export function clearTaskContext(conversationId: string) {
  taskContexts.delete(conversationId);
}
