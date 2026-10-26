import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FfmpegError, runFfmpeg, runProcess } from "@/features/video-to-variations/services/ffmpeg";
import { buildWavArgs } from "@/features/video-to-variations/services/ffmpeg-args";
import type { Workspace } from "@/features/video-to-variations/services/workspace";
import type { Word } from "@/features/video-to-variations/types";

export class NoSpeechError extends Error {
  constructor() {
    super("No speech was found in this video.");
    this.name = "NoSpeechError";
  }
}

export const pythonBin = () => process.env.VIDEO_PYTHON || join(homedir(), ".video-tools", "venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
const script = () => join(process.cwd(), "src", "features", "video-to-variations", "scripts", "transcribe.py");

/** Word timings for one imported video, written to media/<id>/transcript.json. Runs faster-whisper on this computer. */
export async function transcribe(ws: Workspace, id: string, mediaId: string, sourcePath: string): Promise<{ language: string; words: Word[] }> {
  const wav = ws.mediaPath(id, mediaId, "audio.wav");
  const out = ws.mediaPath(id, mediaId, "transcript.json");
  await runFfmpeg(buildWavArgs(sourcePath, wav));
  try {
    await runProcess(pythonBin(), ["-I", script(), wav, out]);
  } catch (error) {
    if (error instanceof FfmpegError && error.exitCode === 3) throw new NoSpeechError();
    throw error;
  } finally {
    await rm(wav, { force: true });
  }
  return JSON.parse(await readFile(out, "utf8"));
}
