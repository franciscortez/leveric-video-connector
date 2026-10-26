import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { projectSchema } from "@/features/video-to-variations/schemas/project.schema";
import { timelineSchema } from "@/features/video-to-variations/schemas/timeline.schema";
import { emptyTimeline } from "@/features/video-to-variations/services/timeline";
import { operationContext } from "@/features/video-to-variations/services/operation-context";
import type { Media, Project, TimeRange, Timeline, Version } from "@/features/video-to-variations/types";

export type Workspace = ReturnType<typeof createWorkspace>;

const ID = /^[a-f0-9-]{36}$/;
const MEDIA_ID = /^m\d{1,2}$/;

export const versionName = (n: number) => `v${String(n).padStart(3, "0")}`;

/** Edit folders under one root. Every file an edit owns is reached through `path`, which never leaves the folder. */
export function createWorkspace(root: string) {
  function path(id: string, ...parts: string[]): string {
    if (!ID.test(id)) throw new Error("Invalid project id.");
    const base = resolve(root, id);
    const full = resolve(base, ...parts);
    const rel = relative(base, full);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path is outside the project folder.");
    return full;
  }

  /** A file of one imported video: media/<mediaId>/... */
  function mediaPath(id: string, mediaId: string, ...parts: string[]): string {
    if (!MEDIA_ID.test(mediaId)) throw new Error("Invalid media id.");
    return path(id, "media", mediaId, ...parts);
  }

  async function save(p: Project): Promise<void> {
    const file = path(p.id, "project.json");
    // Write then rename, so a crash never leaves half a project file.
    await writeFile(`${file}.tmp`, JSON.stringify(p, null, 2));
    await rename(`${file}.tmp`, file);
  }

  async function get(id: string): Promise<Project | null> {
    if (!ID.test(id)) return null;
    try {
      return projectSchema.parse(JSON.parse(await readFile(path(id, "project.json"), "utf8")));
    } catch {
      return null;
    }
  }

  async function mustGet(id: string): Promise<Project> {
    const p = await get(id);
    if (!p) throw new Error("Project not found.");
    return p;
  }

  /** A new, empty edit. Version 1 is the empty timeline. */
  async function create(name = "Untitled edit", id: string = randomUUID()): Promise<Project> {
    for (const dir of [["media"], ["timeline"], ["exports"]]) await mkdir(path(id, ...dir), { recursive: true });
    await writeFile(path(id, "timeline", `${versionName(1)}.json`), JSON.stringify(emptyTimeline(), null, 2));
    const p: Project = {
      id,
      createdAt: new Date().toISOString(),
      name,
      media: [],
      sessionId: null,
      versions: [{ n: 1, source: "upload", label: "New edit", summary: null, changedRange: null, createdAt: new Date().toISOString() }],
      current: 1,
      status: "DRAFT",
      job: null,
    };
    await save(p);
    return p;
  }

  /** The id the next imported video gets: m1, m2, ... */
  async function nextMediaId(id: string): Promise<string> {
    const p = await mustGet(id);
    const used = p.media.map((m) => Number(m.id.slice(1)));
    return `m${(used.length ? Math.max(...used) : 0) + 1}`;
  }

  async function addMedia(id: string, media: Media): Promise<Project> {
    const p = await mustGet(id);
    p.media = [...p.media.filter((m) => m.id !== media.id), media];
    await save(p);
    return p;
  }

  /**
   * Saves a new version and makes it current. A change made after an undo drops the versions that were ahead
   * of it (the redo branch), like any editor.
   */
  async function writeTimeline(id: string, t: Timeline, meta: { source: Version["source"]; label: string; summary?: string | null; changedRange?: TimeRange | null; media?: Media }): Promise<number> {
    const p = await mustGet(id);
    const kept = p.versions.filter((v) => v.n <= p.current);
    const n = (kept.at(-1)?.n ?? 0) + 1;
    await writeFile(path(id, "timeline", `${versionName(n)}.json`), JSON.stringify(t, null, 2));
    p.versions = [...kept, { n, source: meta.source, label: meta.label, summary: meta.summary ?? null, changedRange: meta.changedRange ?? null, createdAt: new Date().toISOString() }];
    p.revision = (p.revision ?? p.current) + 1;
    p.current = n;
    if (meta.media) p.media = [...p.media.filter((m) => m.id !== meta.media!.id), meta.media];
    const operationId = operationContext.getStore()?.operationId;
    if (operationId) {
      await mkdir(path(id, "jobs"), { recursive: true });
      const timelineFile = `${operationId}.timeline.json`;
      await writeFile(path(id, "jobs", timelineFile), JSON.stringify(t));
      p.completedOperations = { ...p.completedOperations, [operationId]: { version: n, timelineFile, summary: meta.summary, changedRange: meta.changedRange, mediaId: meta.media?.id } };
    }
    if (meta.source !== "upload") p.status = "EDITED";
    await save(p);
    return n;
  }

  async function readTimeline(id: string, n: number): Promise<Timeline> {
    return timelineSchema.parse(JSON.parse(await readFile(path(id, "timeline", `${versionName(n)}.json`), "utf8")));
  }

  async function setCurrent(id: string, n: number): Promise<Project> {
    const p = await mustGet(id);
    if (!p.versions.some((x) => x.n === n)) throw new Error("Version not found.");
    p.revision = (p.revision ?? p.current) + 1;
    p.current = n;
    await save(p);
    return p;
  }

  return { root, path, mediaPath, get, mustGet, save, create, nextMediaId, addMedia, writeTimeline, readTimeline, setCurrent };
}

export function defaultWorkspaceRoot(): string {
  return process.env.VIDEO_WORKSPACE || join(process.env.USERPROFILE || process.env.HOME || ".", "LevericWorkbench", "video");
}
