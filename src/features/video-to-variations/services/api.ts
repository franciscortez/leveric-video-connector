import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import { fail, ok } from "@/lib/api/respond";
import { TimelineInvalidError, timelineSchema } from "@/features/video-to-variations/schemas/timeline.schema";
import { claudeEditor } from "@/features/video-to-variations/services/editor-provider";
import { guard, isRunning, jobRunning, ndjson, startJob, workspace } from "@/features/video-to-variations/services/http";
import { importMedia } from "@/features/video-to-variations/services/ingest";
import { EmptyTimelineError, renderExport } from "@/features/video-to-variations/services/render";
import { MAX_STYLE_CHARS } from "@/features/video-to-variations/services/style";
import { normaliseTimeline } from "@/features/video-to-variations/services/timeline";
import type { Project, Word } from "@/features/video-to-variations/types";
import { operationContext } from "@/features/video-to-variations/services/operation-context";
import { beginOperation, finishOperation } from "@/features/video-to-variations/services/operations";
import { errorEvent } from "@/features/video-to-variations/services/http";
import { claudeReadiness } from "@/features/video-to-variations/services/connector-status";

const notFound = () => fail("project_not_found", "This edit was not found.", 404);

/** Clears a job left in project.json by a server that stopped mid-run. */
function live(p: Project): Project {
  return p.job && !isRunning(p.id) ? { ...p, job: null } : p;
}

async function setJob(id: string, kind: string | null): Promise<Project> {
  const ws = workspace();
  const p = { ...(await ws.mustGet(id)), job: kind ? { kind, startedAt: new Date().toISOString() } : null };
  await ws.save(p);
  return p;
}

/** Runs a long job under the edit's lock, streaming NDJSON; the job marker is always cleared. */
function job(id: string, kind: string, release: () => void, run: (send: (e: Record<string, unknown>) => void) => Promise<Record<string, unknown>>): Response {
  return ndjson(async (send) => {
    const context = operationContext.getStore();
    let failed = false;
    let stage = "record operation";
    try {
      if (context?.operationId) await beginOperation(id, context.operationId, context.kind ?? kind);
      stage = "save job marker";
      await setJob(id, kind);
      stage = "process media";
      const result = await run(send);
      await finishOperation(id, "completed", result);
      return result;
    } catch (error) {
      failed = true;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      console.error("Video operation failed", { stage, code });
      try { await finishOperation(id, "failed", undefined, errorEvent(error)); }
      catch { console.error("Could not persist failed video operation"); }
      throw error;
    } finally {
      try { await setJob(id, null); }
      catch (error) { console.error("Could not clear video job marker"); if (!failed) throw error; }
    }
  }, release);
}

export async function healthResponse(): Promise<Response> {
  return (await guard()) ?? ok({ ok: true });
}

const nameSchema = z.object({ name: z.string().trim().min(1, "Give the edit a name.").max(80) });

/** A new, empty edit. Body (optional): { name }. */
export async function createEditResponse(req: Request): Promise<Response> {
  const blocked = await guard();
  if (blocked) return blocked;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : undefined;
  const ws = workspace();
  const project = await ws.create(name);
  return ok({ project, timeline: await ws.readTimeline(project.id, 1) });
}

export async function getEditResponse(id: string): Promise<Response> {
  const blocked = await guard();
  if (blocked) return blocked;
  const ws = workspace();
  const p = await ws.get(id);
  if (!p) return notFound();
  const words: Record<string, Word[]> = {};
  for (const m of p.media) {
    const t = JSON.parse(await readFile(ws.mediaPath(id, m.id, "transcript.json"), "utf8").catch(() => '{"words":[]}')) as { words: Word[] };
    words[m.id] = t.words;
  }
  const style = await readFile(ws.path(id, "style.md"), "utf8").catch(() => "");
  return ok({ project: live(p), timeline: await ws.readTimeline(id, p.current), words, style });
}

export async function renameEditResponse(req: Request, id: string): Promise<Response> {
  const blocked = await guard();
  if (blocked) return blocked;
  const ws = workspace();
  const p = await ws.get(id);
  if (!p) return notFound();
  const body = nameSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return fail("invalid_input", body.error.issues[0]?.message ?? "Give the edit a name.", 400);
  const project = { ...p, name: body.data.name };
  await ws.save(project);
  return ok({ project: live(project) });
}

/** Body: the raw video file. Header: x-file-name (URI-encoded). Streams NDJSON; the video is added to the end of the timeline. */
export async function importMediaResponse(req: Request, id: string): Promise<Response> {
  const blocked = await guard();
  if (blocked) return blocked;
  const ws = workspace();
  if (!(await ws.get(id))) return notFound();
  if (!req.body) return fail("invalid_input", "Choose a video file.", 400);
  const release = startJob(id);
  if (!release) return jobRunning();
  const fileName = decodeURIComponent(req.headers.get("x-file-name") ?? "video.mp4");
  const body = req.body;
  return job(id, "import", release, async (send) => {
    const { project, media } = await importMedia(ws, id, body, { fileName }, (p) => send({ type: "progress", ...p }));
    return { project: { ...project, job: null }, media, timeline: await ws.readTimeline(id, project.current) };
  });
}

const handEditSchema = z.object({ timeline: timelineSchema, label: z.string().trim().min(1).max(80) });

/** A hand edit from the editor: saved as a new version. */
export async function putTimelineResponse(req: Request, id: string): Promise<Response> {
  const blocked = await guard();
  if (blocked) return blocked;
  const ws = workspace();
  const p = await ws.get(id);
  if (!p) return notFound();
  if (isRunning(id)) return jobRunning();
  const body = handEditSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return fail("invalid_timeline", body.error.issues[0]?.message ?? "The edit is not valid.", 400);
  const timeline = normaliseTimeline(body.data.timeline, p.media);
  await ws.writeTimeline(id, timeline, { source: "hand", label: body.data.label });
  return ok({ project: live(await ws.mustGet(id)), timeline });
}

const promptSchema = z.object({
  prompt: z.string().trim().min(1, "Write what to change.").max(1000, "Keep the request under 1,000 characters."),
  range: z
    .object({ start: z.number().min(0), end: z.number().min(0) })
    .refine((r) => r.end > r.start, "The range must end after it starts.")
    .nullable()
    .optional(),
  model: z.enum(["opus", "sonnet"]).default("opus"),
});

/** Claude edits the current timeline. Streams NDJSON: progress, then the new timeline with Claude's summary. */
export async function promptResponse(req: Request, id: string): Promise<Response> {
  const blocked = await guard();
  if (blocked) return blocked;
  if (process.env.VIDEO_CONNECTOR === "1") {
    const claude = await claudeReadiness();
    if (!claude.ready) return fail("claude_unavailable", claude.message, 503);
  }
  const body = promptSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return fail("invalid_input", body.error.issues[0]?.message ?? "Write what to change.", 400);
  const ws = workspace();
  if (!(await ws.get(id))) return notFound();
  const release = startJob(id);
  if (!release) return jobRunning();
  return job(id, "prompt", release, async (send) => {
    const { summary, changedRange } = await claudeEditor.edit(ws, id, { prompt: body.data.prompt, range: body.data.range ?? null, model: body.data.model }, (x) => send({ type: "progress", ...x }));
    const project = await ws.mustGet(id);
    return { project: { ...project, job: null }, timeline: await ws.readTimeline(id, project.current), summary, changedRange };
  });
}

/** Undo and redo: make version n current. */
export async function restoreResponse(id: string, nRaw: string): Promise<Response> {
  const blocked = await guard();
  if (blocked) return blocked;
  const ws = workspace();
  const p = await ws.get(id);
  if (!p) return notFound();
  const n = Number(nRaw);
  if (!Number.isInteger(n) || !p.versions.some((v) => v.n === n)) return fail("version_not_found", "That version does not exist.", 404);
  if (isRunning(id)) return jobRunning();
  const restored = await ws.setCurrent(id, n);
  // An earlier version is no longer the exported one.
  if (restored.status === "APPROVED") restored.status = "EDITED";
  await ws.save(restored);
  return ok({ project: live(restored), timeline: await ws.readTimeline(id, n) });
}

/** Renders the current version at full quality and approves it. Streams NDJSON. */
export async function exportResponse(id: string): Promise<Response> {
  const blocked = await guard();
  if (blocked) return blocked;
  const ws = workspace();
  const p = await ws.get(id);
  if (!p) return notFound();
  if ((await ws.readTimeline(id, p.current)).clips.length === 0) return fail("empty_timeline", "The timeline is empty. Import a video first.", 409);
  const release = startJob(id);
  if (!release) return jobRunning();
  return job(id, "export", release, async (send) => {
    const file = await renderExport(ws, id, p.current, (x) => send({ type: "progress", ...x }));
    const after = await ws.mustGet(id);
    if (after.current === p.current) after.status = "APPROVED";
    const operationId = operationContext.getStore()?.operationId;
    if (operationId) after.completedOperations = { ...after.completedOperations, [operationId]: { version: p.current, file } };
    await ws.save(after);
    return { project: { ...after, job: null }, file };
  });
}

/** Streams a file with HTTP Range support so video can seek. */
async function serveFile(req: Request, path: string, type: string, extra: Record<string, string> = {}): Promise<Response> {
  const size = await stat(path).then((s) => s.size, () => null);
  if (size === null) return fail("file_not_found", "This file does not exist yet.", 404);
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", ...extra };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;
    return new Response(stream, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  return new Response(stream, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
}

const MEDIA_FILES: { pattern: RegExp; dir: string[]; type: string }[] = [
  { pattern: /^proxy\.mp4$/, dir: [], type: "video/mp4" },
  { pattern: /^waveform\.png$/, dir: [], type: "image/png" },
  { pattern: /^t\d{4}\.jpg$/, dir: ["thumbs"], type: "image/jpeg" },
];

/** A video's editor files: proxy (with Range), thumbnails, waveform. Never the original or any other file. */
export async function mediaFileResponse(req: Request, id: string, mediaId: string, file: string): Promise<Response> {
  const blocked = await guard();
  if (blocked) return blocked;
  const kind = MEDIA_FILES.find((a) => a.pattern.test(file));
  if (!kind || !/^m\d{1,2}$/.test(mediaId)) return fail("invalid_file", "Unknown file.", 400);
  const ws = workspace();
  if (!(await ws.get(id))) return notFound();
  return serveFile(req, ws.mediaPath(id, mediaId, ...kind.dir, file), kind.type, { "Cache-Control": "private, max-age=3600" });
}

/** An exported MP4, as a download. */
export async function exportFileResponse(req: Request, id: string, file: string): Promise<Response> {
  const blocked = await guard();
  if (blocked) return blocked;
  if (!/^v\d{3}-(916|169)\.mp4$/.test(file)) return fail("invalid_file", "Unknown file.", 400);
  const ws = workspace();
  const p = await ws.get(id);
  if (!p) return notFound();
  const base = p.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "edit";
  return serveFile(req, ws.path(id, "exports", file), "video/mp4", { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${base}-${file}"` });
}

export async function putStyleResponse(req: Request, id: string): Promise<Response> {
  const blocked = await guard();
  if (blocked) return blocked;
  const ws = workspace();
  if (!(await ws.get(id))) return notFound();
  const text = await req.text();
  if (text.length > MAX_STYLE_CHARS) return fail("style_too_long", "Keep the style guide under 20,000 characters.", 413);
  await writeFile(ws.path(id, "style.md"), text);
  return ok({ ok: true });
}

export { EmptyTimelineError, TimelineInvalidError };
