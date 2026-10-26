import { spawn } from "node:child_process";

export interface ProbeResult {
  durationS: number;
  width: number;
  height: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

/** A local tool (ffmpeg, ffprobe, python, claude) failed. `exitCode` is null when it never started. */
export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

const ffmpegBin = () => process.env.VIDEO_FFMPEG_BIN || "ffmpeg";
const ffprobeBin = () => process.env.VIDEO_FFPROBE_BIN || "ffprobe";

interface RunOptions {
  cwd?: string;
  /** Output seconds written so far, from `-progress pipe:1`. */
  onProgress?: (outS: number) => void;
  signal?: AbortSignal;
}

/** Runs a command with an argument list (never a shell string). Resolves with stdout and stderr; rejects on a non-zero exit. */
export function runProcess(bin: string, args: string[], opts: { cwd?: string; signal?: AbortSignal; onStdout?: (chunk: string) => void } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, signal: opts.signal, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
      opts.onStdout?.(d);
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      // Keep the tail only: ffmpeg logs can be long.
      stderr = (stderr + d).slice(-20_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new FfmpegError(lastLine(stderr) || `${bin} exited with code ${code}.`, code));
    });
  });
}

export function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
}

export async function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<{ stderr: string }> {
  const { stderr } = await runProcess(ffmpegBin(), args, {
    cwd: opts.cwd,
    signal: opts.signal,
    onStdout: (chunk) => {
      if (!opts.onProgress) return;
      for (const m of chunk.matchAll(/out_time_ms=(\d+)/g)) opts.onProgress(Number(m[1]) / 1_000_000);
    },
  });
  return { stderr };
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await runProcess(ffprobeBin(), ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
  const data = JSON.parse(stdout) as { streams?: { codec_type?: string; width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[]; format?: { duration?: string } };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  // Phone videos store portrait as landscape plus a rotation.
  const rotation = Math.abs(Number(video?.tags?.rotate ?? video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0)) % 180;
  const [width, height] = rotation === 90 ? [video?.height ?? 0, video?.width ?? 0] : [video?.width ?? 0, video?.height ?? 0];
  return {
    durationS: Number(data.format?.duration ?? 0),
    width,
    height,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    hasVideo: Boolean(video),
  };
}

export const binaries = { ffmpeg: ffmpegBin, ffprobe: ffprobeBin };
