import { access, rename, writeFile } from "node:fs/promises";
import { toAss } from "@/features/video-to-variations/services/captions";
import { runFfmpeg } from "@/features/video-to-variations/services/ffmpeg";
import { buildLoudnessArgs, buildRenderArgs, parseLoudness, type RenderInput } from "@/features/video-to-variations/services/ffmpeg-args";
import { duration, visibleCaptions } from "@/features/video-to-variations/services/timeline-ops";
import { versionName, type Workspace } from "@/features/video-to-variations/services/workspace";
import type { Format } from "@/features/video-to-variations/types";
import type { RunProgress } from "@/types/tool";

const FORMAT_TAG: Record<Format, string> = { "9:16": "916", "16:9": "169" };

export const exportName = (n: number, format: Format) => `${versionName(n)}-${FORMAT_TAG[format]}.mp4`;

export class EmptyTimelineError extends Error {
  constructor() {
    super("The timeline is empty. Import a video first.");
    this.name = "EmptyTimelineError";
  }
}

/**
 * Renders one version at full quality into exports/ and returns the file name. An export that already exists
 * is reused; a half-written one never shows (written as .part, then renamed).
 */
export async function renderExport(ws: Workspace, id: string, n: number, onProgress: (p: RunProgress) => void): Promise<string> {
  const p = await ws.mustGet(id);
  const t = await ws.readTimeline(id, n);
  if (t.clips.length === 0) throw new EmptyTimelineError();
  const name = exportName(n, t.format);
  const out = ws.path(id, "exports", name);
  if (await access(out).then(() => true, () => false)) return name;

  // One ffmpeg input per video the edit uses.
  const used = [...new Set(t.clips.map((c) => c.mediaId))];
  const inputs: RenderInput[] = used.map((mediaId) => {
    const m = p.media.find((x) => x.id === mediaId)!;
    return { path: ws.mediaPath(id, m.id, m.file), w: m.width, h: m.height, hasAudio: m.hasAudio };
  });
  const clips = t.clips.map((c) => ({ input: used.indexOf(c.mediaId), start: c.start, end: c.end }));

  const assName = `${versionName(n)}.ass`;
  await writeFile(ws.path(id, "exports", assName), toAss(visibleCaptions(t), t.titles, t.format));

  const total = Math.round(duration(t));
  const label = `Rendering ${t.format}`;
  onProgress({ done: 0, total, label: "Measuring loudness" });
  // Two passes: one loudnorm pass undershoots speech by about 3 LU.
  const loudness = inputs.some((x) => x.hasAudio) ? (parseLoudness((await runFfmpeg(buildLoudnessArgs(inputs, clips))).stderr) ?? undefined) : undefined;
  const part = name.replace(/\.mp4$/, ".part.mp4");
  await runFfmpeg(buildRenderArgs({ inputs, clips, assName, format: t.format, out: part, loudness }), {
    cwd: ws.path(id, "exports"),
    onProgress: (s) => onProgress({ done: Math.min(Math.round(s), total), total, label }),
  });
  await rename(ws.path(id, "exports", part), out);
  return name;
}
