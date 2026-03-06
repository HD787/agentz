import { exec, execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a provided command as a subprocess and return stdout/stderr/exit code.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "Executable name or full command string when args is omitted.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Optional arguments passed to the command.",
          },
          cwd: {
            type: "string",
            description: "Optional working directory for the subprocess.",
          },
          timeoutMs: {
            type: "integer",
            description: "Optional timeout in milliseconds.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_script",
      description:
        "Run a script by path as a subprocess and return stdout/stderr/exit code.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Script path to execute.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Optional arguments passed to the script.",
          },
          cwd: {
            type: "string",
            description: "Optional working directory for the subprocess.",
          },
          timeoutMs: {
            type: "integer",
            description: "Optional timeout in milliseconds.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_setup",
      description:
        "Store bot profile name and sandbox path, and mark setup as complete.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Bot name to display for this instance.",
          },
          sandboxPath: {
            type: "string",
            description: "Root sandbox path for this bot instance.",
          },
        },
        required: ["name", "sandboxPath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_user_onboarding",
      description: "Store user display name and mark onboarding complete.",
      parameters: {
        type: "object",
        properties: {
          userId: {
            type: "string",
            description: "User id to update.",
          },
          name: {
            type: "string",
            description: "Display name for the user.",
          },
        },
        required: ["userId", "name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_downloaded_software",
      description: "Delete a downloaded software entry by id.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Downloaded software id to delete.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
] as const;

export type ToolName = (typeof toolDefinitions)[number]["function"]["name"];

export type RunCommandArgs = {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
};

export type RunScriptArgs = {
  path: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
};

export type CompleteSetupArgs = {
  name: string;
  sandboxPath: string;
};

export type CompleteUserOnboardingArgs = {
  userId: string;
  name: string;
};

export type DeleteDownloadedSoftwareArgs = {
  id: string;
};

export type RunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export async function runToolCall(
  name: ToolName,
  args: unknown,
  options?: { prisma?: PrismaClient }
) {
  switch (name) {
    case "run_command":
      return runCommand(coerceRunCommandArgs(args), options);
    case "run_script":
      return runScript(coerceRunScriptArgs(args), options);
    case "complete_setup":
      return completeSetup(coerceCompleteSetupArgs(args), options);
    case "complete_user_onboarding":
      return completeUserOnboarding(coerceCompleteUserOnboardingArgs(args), options);
    case "delete_downloaded_software":
      return deleteDownloadedSoftware(coerceDeleteDownloadedSoftwareArgs(args), options);
    default:
      throw new Error(`Unknown tool name: ${name}`);
  }
}

function coerceRunCommandArgs(value: unknown): RunCommandArgs {
  if (!value || typeof value !== "object") {
    throw new Error("run_command expects an object argument.");
  }

  const args = value as Partial<RunCommandArgs>;
  if (!args.command || typeof args.command !== "string") {
    throw new Error("run_command requires a string 'command'.");
  }

  if (args.args && !Array.isArray(args.args)) {
    throw new Error("run_command 'args' must be an array of strings when provided.");
  }

  return {
    command: args.command,
    args: args.args,
    cwd: typeof args.cwd === "string" ? args.cwd : undefined,
    timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
  };
}

function coerceRunScriptArgs(value: unknown): RunScriptArgs {
  if (!value || typeof value !== "object") {
    throw new Error("run_script expects an object argument.");
  }

  const args = value as Partial<RunScriptArgs>;
  if (!args.path || typeof args.path !== "string") {
    throw new Error("run_script requires a string 'path'.");
  }

  if (args.args && !Array.isArray(args.args)) {
    throw new Error("run_script 'args' must be an array of strings when provided.");
  }

  return {
    path: args.path,
    args: args.args,
    cwd: typeof args.cwd === "string" ? args.cwd : undefined,
    timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
  };
}

function coerceCompleteSetupArgs(value: unknown): CompleteSetupArgs {
  if (!value || typeof value !== "object") {
    throw new Error("complete_setup expects an object argument.");
  }

  const args = value as Partial<CompleteSetupArgs>;
  if (!args.name || typeof args.name !== "string") {
    throw new Error("complete_setup requires a string 'name'.");
  }

  if (!args.sandboxPath || typeof args.sandboxPath !== "string") {
    throw new Error("complete_setup requires a string 'sandboxPath'.");
  }

  return {
    name: args.name,
    sandboxPath: args.sandboxPath,
  };
}

function coerceCompleteUserOnboardingArgs(value: unknown): CompleteUserOnboardingArgs {
  if (!value || typeof value !== "object") {
    throw new Error("complete_user_onboarding expects an object argument.");
  }

  const args = value as Partial<CompleteUserOnboardingArgs>;
  if (!args.userId || typeof args.userId !== "string") {
    throw new Error("complete_user_onboarding requires a string 'userId'.");
  }

  if (!args.name || typeof args.name !== "string") {
    throw new Error("complete_user_onboarding requires a string 'name'.");
  }

  return {
    userId: args.userId,
    name: args.name,
  };
}

function coerceDeleteDownloadedSoftwareArgs(value: unknown): DeleteDownloadedSoftwareArgs {
  if (!value || typeof value !== "object") {
    throw new Error("delete_downloaded_software expects an object argument.");
  }

  const args = value as Partial<DeleteDownloadedSoftwareArgs>;
  if (!args.id || typeof args.id !== "string") {
    throw new Error("delete_downloaded_software requires a string 'id'.");
  }

  return { id: args.id };
}

async function runCommand(
  { command, args, cwd, timeoutMs }: RunCommandArgs,
  options?: { prisma?: PrismaClient }
): Promise<RunCommandResult> {
  try {
    if (args && args.length > 0) {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });

      const result = {
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        exitCode: 0,
      };
      await logCommandHistory(options, { command, args, cwd, status: "completed", ...result });
      return result;
    }

    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });

    const result = {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      exitCode: 0,
    };
    await logCommandHistory(options, { command, args, cwd, status: "completed", ...result });
    return result;
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | null;
    };

    const result = {
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
      exitCode: typeof error.code === "number" ? error.code : null,
    };
    await logCommandHistory(options, { command, args, cwd, status: "failed", ...result });
    return result;
  }
}

async function runScript(
  { path, args, cwd, timeoutMs }: RunScriptArgs,
  options?: { prisma?: PrismaClient }
): Promise<RunCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(path, args ?? [], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });

    const result = {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      exitCode: 0,
    };
    await logCommandHistory(options, {
      command: path,
      args,
      cwd,
      status: "completed",
      ...result,
    });
    return result;
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | null;
    };

    const result = {
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
      exitCode: typeof error.code === "number" ? error.code : null,
    };
    await logCommandHistory(options, {
      command: path,
      args,
      cwd,
      status: "failed",
      ...result,
    });
    return result;
  }
}

async function logCommandHistory(
  options: { prisma?: PrismaClient } | undefined,
  data: {
    command: string;
    args?: string[];
    cwd?: string;
    status: string;
    stdout?: string;
    stderr?: string;
    exitCode: number | null;
  }
) {
  if (!options?.prisma) {
    return;
  }

  await options.prisma.commandHistory.create({
    data: {
      command: data.command,
      args: data.args ? JSON.stringify(data.args) : null,
      cwd: data.cwd,
      status: data.status,
      stdout: data.stdout,
      stderr: data.stderr,
      exitCode: data.exitCode ?? null,
    },
  });
}

async function completeSetup(
  { name, sandboxPath }: CompleteSetupArgs,
  options?: { prisma?: PrismaClient }
) {
  if (!options?.prisma) {
    throw new Error("complete_setup requires database access.");
  }

  const preferredSandboxPath = expandHomePath(sandboxPath);
  const fallbackHomeSandboxPath = resolve(homedir(), "sandbox");
  const fallbackTmpSandboxPath = "/tmp/agentz-sandbox";
  const candidatePaths = Array.from(
    new Set([preferredSandboxPath, fallbackHomeSandboxPath, fallbackTmpSandboxPath])
  );

  let resolvedSandboxPath: string | null = null;
  let lastError: unknown;
  for (const candidatePath of candidatePaths) {
    try {
      await mkdir(candidatePath, { recursive: true });
      await mkdir(resolve(candidatePath, "scripts"), { recursive: true });
      await mkdir(resolve(candidatePath, "skills"), { recursive: true });
      resolvedSandboxPath = candidatePath;
      break;
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  if (!resolvedSandboxPath) {
    throw lastError ?? new Error("Unable to initialize sandbox path.");
  }

  const existing = await options.prisma.botProfile.findFirst({
    orderBy: { createdAt: "asc" },
  });

  if (existing) {
    return options.prisma.botProfile.update({
      where: { id: existing.id },
      data: {
        name,
        sandboxPath: resolvedSandboxPath,
        isSetup: true,
      },
    });
  }

  return options.prisma.botProfile.create({
    data: {
      name,
      sandboxPath: resolvedSandboxPath,
      isSetup: true,
    },
  });
}

function expandHomePath(inputPath: string) {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }

  const base = homedir();
  const remainder = inputPath.slice(1);
  return resolve(base, remainder);
}

async function completeUserOnboarding(
  { userId, name }: CompleteUserOnboardingArgs,
  options?: { prisma?: PrismaClient }
) {
  if (!options?.prisma) {
    throw new Error("complete_user_onboarding requires database access.");
  }

  return options.prisma.user.update({
    where: { id: userId },
    data: {
      name,
      isOnboarded: true,
    },
  });
}

async function deleteDownloadedSoftware(
  { id }: DeleteDownloadedSoftwareArgs,
  options?: { prisma?: PrismaClient }
) {
  if (!options?.prisma) {
    throw new Error("delete_downloaded_software requires database access.");
  }

  return options.prisma.downloadedSoftware.delete({
    where: { id },
  });
}
