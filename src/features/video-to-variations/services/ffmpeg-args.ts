import { FRAME } from "@/features/video-to-variations/services/captions";
import type { Format, TimeRange } from "@/features/video-to-variations/types";

/** One imported video used by the export. */
export interface RenderInput {
  path: string;
  w: number;
  h: number;
  hasAudio: boolean;
}

/** A clip: a range of one input, in that input's seconds. */
export interface RenderClip {
  input: number;
  start: number;
  end: number;
}

export interface RenderOptions {
  inputs: RenderInput[];
  /** Clips in playback order. */
  clips: RenderClip[];
  /** ASS file name relative to the folder ffmpeg runs in, so no path ever needs filter escaping. */
  assName: string;
  format: Format;
  out: string;
  /** First-pass measurement. With it, loudness lands on -14 LUFS. */
  loudness?: Loudness;
}

export interface Loudness {
  I: number;
  TP: number;
  LRA: number;
  thresh: number;
  offset: number;
}

const n = (x: number) => String(Math.round(x * 1000) / 1000);
const TARGET = "loudnorm=I=-14:TP=-1:LRA=11";
const TARGET_LUFS = -14;
// Speech is peaky: loudnorm alone stops about 3 LU short to protect peaks. Compress, add the measured gain, then limit to -1 dBFS.
const COMPRESS = "acompressor=threshold=-24dB:ratio=4:attack=5:release=80:knee=4";
const LIMIT = "alimiter=limit=0.891:level=false";
const STEREO = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";

/** One clip's audio: the cut from its video, or silence of the same length when that video has no sound. */
function audioCut(inputs: RenderInput[], c: RenderClip, i: number): string {
  return inputs[c.input].hasAudio
    ? `[${c.input}:a]atrim=start=${n(c.start)}:end=${n(c.end)},asetpts=PTS-STARTPTS,${STEREO}[a${i}]`
    : `aevalsrc=0:channel_layout=stereo:sample_rate=48000:duration=${n(c.end - c.start)},aformat=sample_fmts=fltp[a${i}]`;
}

/** One clip's video: cut, then fill the output frame. A video of the other shape sits over a blurred, filled copy of itself. */
function videoCut(inputs: RenderInput[], c: RenderClip, i: number, format: Format): string[] {
  const { w, h } = FRAME[format];
  const src = inputs[c.input];
  const cut = `[${c.input}:v]trim=start=${n(c.start)}:end=${n(c.end)},setpts=PTS-STARTPTS`;
  const fill = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  const tail = `setsar=1,fps=30,format=yuv420p[v${i}]`;
  if (src.w > src.h === (format === "16:9")) return [`${cut},${fill},${tail}`];
  const fit = format === "16:9" ? `scale=-2:${h}` : `scale=${w}:-2`;
  return [`${cut},split[bg${i}][fg${i}]`, `[bg${i}]${fill},boxblur=20[bb${i}]`, `[fg${i}]${fit}[ff${i}]`, `[bb${i}][ff${i}]overlay=(W-w)/2:(H-h)/2,${tail}`];
}

/** One ffmpeg call: cut every clip from its video, frame each to the format, join in order, burn in captions, -14 LUFS. */
export function buildRenderArgs(o: RenderOptions): string[] {
  const anySound = o.inputs.some((x) => x.hasAudio);
  const l = o.loudness;
  const loudness = !anySound ? "" : l ? `${COMPRESS},volume=${n(TARGET_LUFS - l.I)}dB,${LIMIT},` : `${TARGET},`;
  const graph = [
    ...o.clips.flatMap((c, i) => [...videoCut(o.inputs, c, i, o.format), audioCut(o.inputs, c, i)]),
    `${o.clips.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${o.clips.length}:v=1:a=1[cv][ca]`,
    `[cv]subtitles=${o.assName},format=yuv420p[vout]`,
    `[ca]${loudness}aresample=48000[aout]`,
  ].join(";");

  return [
    "-hide_banner", "-nostats", "-y",
    ...o.inputs.flatMap((x) => ["-i", x.path]),
    "-filter_complex", graph,
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k",
    "-r", "30", "-movflags", "+faststart",
    "-progress", "pipe:1",
    o.out,
  ];
}

/** First loudness pass: the cut, compressed audio of every clip, measured by loudnorm and thrown away. */
export function buildLoudnessArgs(inputs: RenderInput[], clips: RenderClip[]): string[] {
  const graph = [
    ...clips.map((c, i) => audioCut(inputs, c, i)),
    `${clips.map((_, i) => `[a${i}]`).join("")}concat=n=${clips.length}:v=0:a=1[ca]`,
    `[ca]${COMPRESS},${TARGET}:print_format=json[aout]`,
  ].join(";");
  return ["-hide_banner", "-nostats", ...inputs.flatMap((x) => ["-i", x.path]), "-filter_complex", graph, "-map", "[aout]", "-f", "null", "-"];
}

/** The first pass's measurement from ffmpeg's log, or null when it is missing. */
export function parseLoudness(log: string): Loudness | null {
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(log);
  if (!json) return null;
  try {
    const m = JSON.parse(json[0]) as Record<string, string>;
    const out = { I: Number(m.input_i), TP: Number(m.input_tp), LRA: Number(m.input_lra), thresh: Number(m.input_thresh), offset: Number(m.target_offset) };
    return Object.values(out).every(Number.isFinite) ? out : null;
  } catch {
    return null;
  }
}

/** A 720p H.264 copy any browser can play, with a keyframe every second so seeking across cuts is quick. */
export function buildProxyArgs(source: string, out: string, hasAudio: boolean): string[] {
  return [
    "-hide_banner", "-nostats", "-y", "-i", source,
    "-vf", "scale='if(gt(iw,ih),-2,720)':'if(gt(iw,ih),720,-2)',fps=30,format=yuv420p",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-g", "30",
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "96k"] : ["-an"]),
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    out,
  ];
}

/** Timeline thumbnails: one every 2 seconds, 160 px high. */
export function buildThumbsArgs(source: string, outDir: string): string[] {
  return ["-hide_banner", "-nostats", "-y", "-i", source, "-vf", "fps=1/2,scale=-2:160", "-q:v", "6", `${outDir}/t%04d.jpg`];
}

export const WAVEFORM_PX_PER_S = 10;
export const WAVEFORM_MAX_PX = 12_000;

/** The audio waveform as one transparent PNG, 10 px per second (capped), drawn in ink. */
export function buildWaveformArgs(source: string, out: string, durationS: number): string[] {
  const width = Math.min(WAVEFORM_MAX_PX, Math.max(100, Math.round(durationS * WAVEFORM_PX_PER_S)));
  return ["-hide_banner", "-nostats", "-y", "-i", source, "-filter_complex", `aformat=channel_layouts=mono,showwavespic=s=${width}x80:colors=0x2a2a2a`, "-frames:v", "1", out];
}

/** Still frames for Claude to look at. */
export function buildFramesArgs(source: string, outDir: string, everyS = 5): string[] {
  return ["-hide_banner", "-nostats", "-y", "-i", source, "-vf", `fps=1/${everyS},scale=480:-2`, "-q:v", "4", `${outDir}/%04d.jpg`];
}

export function buildSilenceArgs(source: string): string[] {
  return ["-hide_banner", "-nostats", "-i", source, "-vn", "-af", "silencedetect=n=-35dB:d=0.4", "-f", "null", "-"];
}

export function buildWavArgs(source: string, out: string): string[] {
  return ["-hide_banner", "-nostats", "-y", "-i", source, "-vn", "-ac", "1", "-ar", "16000", out];
}

/** Pause ranges from silencedetect's log. A pause still open at the end runs to the end of the source. */
export function parseSilences(log: string, durationS: number): TimeRange[] {
  const out: TimeRange[] = [];
  let start: number | null = null;
  for (const m of log.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const t = Number(m[2]);
    if (m[1] === "start") start = Math.max(0, t);
    else if (start !== null) {
      out.push({ start, end: t });
      start = null;
    }
  }
  if (start !== null) out.push({ start, end: durationS });
  return out;
}
