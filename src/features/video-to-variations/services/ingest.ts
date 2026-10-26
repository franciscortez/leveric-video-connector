import { createWriteStream } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { FfmpegError, probe, runFfmpeg } from "@/features/video-to-variations/services/ffmpeg";
import { buildFramesArgs, buildProxyArgs, buildSilenceArgs, buildThumbsArgs, buildWaveformArgs, parseSilences } from "@/features/video-to-variations/services/ffmpeg-args";
import { DEFAULT_STYLE } from "@/features/video-to-variations/services/style";
import { appendMedia } from "@/features/video-to-variations/services/timeline";
import { NoSpeechError, transcribe } from "@/features/video-to-variations/services/transcribe";
import type { Workspace } from "@/features/video-to-variations/services/workspace";
import type { Media, Project, Word } from "@/features/video-to-variations/types";
import type { RunProgress } from "@/types/tool";

export const MAX_SOURCE_S = 20 * 60;
export const MAX_SOURCE_BYTES = 4 * 1024 ** 3;
export const MAX_MEDIA = 20;
export const MAX_TOTAL_S = 60 * 60;

export class IngestError extends Error {
  constructor(
    readonly code: "too_large" | "too_long" | "too_many" | "not_video" | "proxy_failed",
    message: string,
    readonly status: 413 | 422,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

const STEPS = 6;

/**
 * Imports one video into an edit: saves it, makes a browser-friendly proxy, thumbnails, a waveform, a transcript when
 * there is speech, and still frames for Claude, then appends it to the end of the timeline as a new version.
 * No sound or no speech is fine. On failure only this video's folder is removed; the edit is unchanged.
 */
export async function importMedia(
  ws: Workspace,
  id: string,
  body: ReadableStream<Uint8Array>,
  meta: { fileName: string },
  onProgress: (p: RunProgress) => void,
): Promise<{ project: Project; media: Media }> {
  const before = await ws.mustGet(id);
  if (before.media.length >= MAX_MEDIA) throw new IngestError("too_many", `An edit can hold up to ${MAX_MEDIA} videos.`, 413);
  const mediaId = await ws.nextMediaId(id);
  const ext = /^\.[a-z0-9]{2,5}$/i.test(extname(meta.fileName)) ? extname(meta.fileName).toLowerCase() : ".mp4";
  const file = `source${ext}`;
  const name = meta.fileName.slice(0, 120);
  const at = (...parts: string[]) => ws.mediaPath(id, mediaId, ...parts);
  const step = (done: number, label: string) => onProgress({ done, total: STEPS, label: `${name}: ${label}` });

  await mkdir(at("thumbs"), { recursive: true });
  await mkdir(at("frames"), { recursive: true });
  try {
    step(0, "saving");
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > MAX_SOURCE_BYTES) cb(new IngestError("too_large", "This video is over 4 GB.", 413));
        else cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), limit, createWriteStream(at(file)));

    step(1, "reading");
    const info = await probe(at(file)).catch((error) => {
      if (error instanceof FfmpegError) throw new IngestError("not_video", `${name} is not a video we can read.`, 422);
      throw error;
    });
    if (!info.hasVideo) throw new IngestError("not_video", `${name} has no video picture.`, 422);
    if (info.durationS > MAX_SOURCE_S) throw new IngestError("too_long", `${name} is over 20 minutes. Trim it first.`, 413);
    const total = before.media.reduce((sum, m) => sum + m.durationS, 0) + info.durationS;
    if (total > MAX_TOTAL_S) throw new IngestError("too_many", "An edit can hold up to an hour of video in total.", 413);

    step(2, "making a preview copy");
    await runFfmpeg(buildProxyArgs(at(file), at("proxy.mp4"), info.hasAudio)).catch((error) => {
      if (error instanceof FfmpegError) throw new IngestError("proxy_failed", `${name} could not be prepared for the editor (${error.message}).`, 422);
      throw error;
    });

    step(3, "drawing the timeline");
    await runFfmpeg(buildThumbsArgs(at(file), "thumbs"), { cwd: at() });
    await runFfmpeg(buildFramesArgs(at(file), "frames"), { cwd: at() });
    if (info.hasAudio) await runFfmpeg(buildWaveformArgs(at(file), "waveform.png", info.durationS), { cwd: at() });

    let words: Word[] = [];
    let language: string | null = null;
    if (info.hasAudio) {
      step(4, "transcribing on this computer");
      try {
        const transcript = await transcribe(ws, id, mediaId, at(file));
        words = transcript.words;
        language = transcript.language;
      } catch (error) {
        // Music or silence: keep going without captions.
        if (!(error instanceof NoSpeechError)) throw error;
      }
      const { stderr } = await runFfmpeg(buildSilenceArgs(at(file)));
      await writeFile(at("silences.json"), JSON.stringify(parseSilences(stderr, info.durationS)));
    }
    if (words.length === 0) await writeFile(at("transcript.json"), JSON.stringify({ language: null, words: [] }));
    if (!(await access(ws.path(id, "style.md")).then(() => true, () => false))) await writeFile(ws.path(id, "style.md"), DEFAULT_STYLE);

    step(5, "adding to the timeline");
    const media: Media = { id: mediaId, name, file, durationS: info.durationS, width: info.width, height: info.height, hasAudio: info.hasAudio, language };
    const project = await ws.mustGet(id);
    const current = await ws.readTimeline(id, project.current);
    await ws.writeTimeline(id, appendMedia(current, media, words), { source: "hand", label: `Added ${name}`, media });
    step(STEPS, "ready");
    return { project: await ws.mustGet(id), media };
  } catch (error) {
    await rm(at(), { recursive: true, force: true });
    throw error;
  }
}
