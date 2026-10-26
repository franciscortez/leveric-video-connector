import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { ClaudeModel } from "@/features/video-to-variations/types";

export class ClaudeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeUnavailableError";
  }
}

export interface ClaudeEvent {
  kind: "status" | "tool" | "text";
  label: string;
}

export const claudeBin = () => process.env.VIDEO_CLAUDE_BIN || "claude";

/**
 * Headless Claude Code on the user's own subscription. Read-only tools, no user or global
 * settings, hooks, skills or MCP servers, so the user's personal setup never changes the edit.
 * Never `--bare`: it skips the subscription sign-in.
 */
export function buildClaudeArgs(o: { prompt: string; model: ClaudeModel; sessionId: string; resume: boolean; schema: string; systemPath: string }): string[] {
  return [
    "-p", o.prompt,
    "--output-format", "stream-json", "--verbose",
    "--json-schema", o.schema,
    "--model", o.model,
    "--tools", "Read,Glob",
    "--permission-mode", "dontAsk",
    "--settings", JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true }, disableAllHooks: true }),
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--append-system-prompt-file", o.systemPath,
    ...(o.resume ? ["--resume", o.sessionId] : ["--session-id", o.sessionId]),
  ];
}

interface StreamLine {
  type?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  message?: { content?: { type: string; name?: string; text?: string; input?: { file_path?: string; pattern?: string } }[] };
}

function describe(line: StreamLine): ClaudeEvent | null {
  if (line.type === "system") return { kind: "status", label: "Claude is starting" };
  for (const part of line.message?.content ?? []) {
    if (part.type === "tool_use" && part.name === "Read") return { kind: "tool", label: `Reading ${basename(part.input?.file_path ?? "a file")}` };
    if (part.type === "tool_use" && part.name === "Glob") return { kind: "tool", label: "Looking at the project files" };
    if (part.type === "tool_use" && part.name === "StructuredOutput") return { kind: "status", label: "Writing the edit plan" };
    if (part.type === "text") return { kind: "text", label: "Claude is thinking" };
  }
  return null;
}

/** Runs the CLI and returns its structured output. Any failure (not installed, signed out, limit reached) is a ClaudeUnavailableError. */
export function runClaude(args: string[], cwd: string, onEvent: (e: ClaudeEvent) => void, signal?: AbortSignal): Promise<{ structured: unknown; sessionId: string }> {
  const bin = claudeBin();
  // Tests point VIDEO_CLAUDE_BIN at a Node script.
  const [cmd, cmdArgs] = /\.m?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("VIDEO_CONNECTOR_") || key === "VIDEO_CONNECTOR") delete env[key];
    const child = spawn(cmd, cmdArgs, { cwd, env, signal, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let result: StreamLine | null = null;

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!raw) continue;
        let line: StreamLine;
        try {
          line = JSON.parse(raw);
        } catch {
          continue;
        }
        if (line.type === "result") result = line;
        const event = describe(line);
        if (event) onEvent(event);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr = (stderr + d).slice(-5_000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(new ClaudeUnavailableError(error.code === "ENOENT" ? "Claude Code is not installed on this computer." : error.message));
    });
    child.on("close", (code) => {
      const r = result as StreamLine | null;
      if (code !== 0 || !r || r.is_error) {
        const reason = (r?.is_error && r.result) || stderr.trim().split(/\r?\n/).at(-1) || `Claude Code stopped (exit code ${code}).`;
        reject(new ClaudeUnavailableError(reason));
        return;
      }
      let structured = r.structured_output;
      if (structured === undefined) {
        try {
          structured = JSON.parse(r.result ?? "");
        } catch {
          structured = null;
        }
      }
      resolve({ structured, sessionId: r.session_id ?? "" });
    });
  });
}
