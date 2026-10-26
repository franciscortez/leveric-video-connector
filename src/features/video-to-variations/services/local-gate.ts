import { claudeBin } from "@/features/video-to-variations/services/claude-cli";
import { binaries, runProcess } from "@/features/video-to-variations/services/ffmpeg";
import { pythonBin } from "@/features/video-to-variations/services/transcribe";

export type GateResult = { ok: true } | { ok: false; code: "local_only" | "claude_missing" | "ffmpeg_missing" | "python_missing" };

const CACHE_MS = 60_000;
let cached: { at: number; result: GateResult } | null = null;

export function resetGateCache(): void {
  cached = null;
}

async function works(bin: string, args: string[]): Promise<boolean> {
  const [cmd, cmdArgs] = /\.m?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
  return runProcess(cmd, cmdArgs).then(
    () => true,
    () => false,
  );
}

/** Tool 06 runs only on a computer with Claude Code, FFmpeg and the faster-whisper Python. Never on Vercel. */
export async function localGate(): Promise<GateResult> {
  if (process.env.VERCEL) return { ok: false, code: "local_only" };
  // Connector capabilities are checked per operation; manual edits do not need an AI login.
  if (process.env.VIDEO_CONNECTOR === "1") return { ok: true };
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.result;
  let result: GateResult = { ok: true };
  if (!(await works(claudeBin(), ["--version"]))) result = { ok: false, code: "claude_missing" };
  else if (!(await works(binaries.ffmpeg(), ["-version"]))) result = { ok: false, code: "ffmpeg_missing" };
  else if (!(await works(pythonBin(), ["-I", "-c", "import faster_whisper"]))) result = { ok: false, code: "python_missing" };
  cached = { at: Date.now(), result };
  return result;
}
