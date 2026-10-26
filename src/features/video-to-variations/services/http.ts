import { fail } from "@/lib/api/respond";
import { TimelineInvalidError } from "@/features/video-to-variations/schemas/timeline.schema";
import { ClaudeUnavailableError } from "@/features/video-to-variations/services/claude-cli";
import { FfmpegError } from "@/features/video-to-variations/services/ffmpeg";
import { IngestError } from "@/features/video-to-variations/services/ingest";
import { localGate } from "@/features/video-to-variations/services/local-gate";
import { createWorkspace, defaultWorkspaceRoot, type Workspace } from "@/features/video-to-variations/services/workspace";
import { randomUUID } from "node:crypto";
import { operationContext, projectWriters } from "@/features/video-to-variations/services/operation-context";

const GATE_MESSAGES = {
  local_only: "This tool runs only where the Workbench runs on your own computer (pnpm dev), not on Vercel.",
  claude_missing: "Claude Code is not installed or not on the PATH.",
  ffmpeg_missing: "FFmpeg is not installed or not on the PATH.",
  python_missing: "The faster-whisper Python environment was not found.",
} as const;

/** A 503 response when this computer cannot run tool 06, otherwise null. */
export async function guard(): Promise<Response | null> {
  const gate = await localGate();
  return gate.ok ? null : fail(gate.code, GATE_MESSAGES[gate.code], 503);
}

export function workspace(): Workspace {
  return createWorkspace(defaultWorkspaceRoot());
}


/** One long job per project at a time. Returns a release function, or null when a job is already running. */
export function startJob(id: string): (() => void) | null {
  const owner = operationContext.getStore()?.owner ?? randomUUID();
  const current = projectWriters.get(id);
  if (current && current.owner !== owner) return null;
  const lock = current ?? { owner, count: 0 };
  lock.count += 1;
  projectWriters.set(id, lock);
  return () => { if (--lock.count === 0) projectWriters.delete(id); };
}

export function isRunning(id: string): boolean {
  const lock = projectWriters.get(id);
  return !!lock && lock.owner !== operationContext.getStore()?.owner;
}

export const jobRunning = () => fail("job_running", "Another change to this project is still running. Wait for it to finish.", 409);

/** The error event a failed job sends. Messages are ours or the local tool's last line; never transcript text. */
export function errorEvent(error: unknown): { type: "error"; code: string; message: string } {
  if (error instanceof IngestError) return { type: "error", code: error.code, message: error.message };
  if (error instanceof ClaudeUnavailableError) return { type: "error", code: "claude_unavailable", message: `Claude Code could not finish: ${error.message}` };
  if (error instanceof TimelineInvalidError) return { type: "error", code: "edit_invalid", message: `Claude's edit was not usable twice in a row (${error.message}). Try rewording the request.` };
  if (error instanceof FfmpegError) return { type: "error", code: "render_failed", message: `FFmpeg could not finish: ${error.message}` };
  return { type: "error", code: "run_failed", message: "Something went wrong. Try again." };
}

/** Streams newline-delimited JSON events, like the shared runs route: `progress`, then `result` or `error`. */
export function ndjson(run: (send: (event: Record<string, unknown>) => void) => Promise<Record<string, unknown>>, release?: () => void): Response {
  const encoder = new TextEncoder();
  let connected = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        if (!connected) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch { connected = false; }
      };
      try {
        send({ type: "result", ...(await run(send)) });
      } catch (error) {
        send(errorEvent(error));
      } finally {
        release?.();
        if (connected) controller.close();
      }
    },
    cancel() { connected = false; },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
