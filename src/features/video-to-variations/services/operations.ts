import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { createWorkspace, defaultWorkspaceRoot } from "@/features/video-to-variations/services/workspace";
import { operationContext } from "@/features/video-to-variations/services/operation-context";
const schema = z.object({ id: z.string().uuid(), kind: z.string(), instance: z.string(), state: z.enum(["running", "completed", "failed", "interrupted"]), result: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
export type Operation = z.infer<typeof schema>;
const instance = () => process.env.VIDEO_CONNECTOR_INSTANCE ?? String(process.pid);
const ws = () => createWorkspace(defaultWorkspaceRoot());
function path(project: string, id: string) { z.uuid().parse(id); return ws().path(project, "jobs", `${id}.json`); }
async function save(project: string, op: Operation) {
  await mkdir(ws().path(project, "jobs"), { recursive: true });
  const file = path(project, op.id);
  await writeFile(`${file}.tmp`, JSON.stringify(op)); await rename(`${file}.tmp`, file);
}
export async function beginOperation(project: string, id: string, kind: string) {
  await save(project, { id, kind, instance: instance(), state: "running" });
}
export async function finishOperation(project: string, state: "completed" | "failed", result?: Record<string, unknown>, error?: { code: string; message: string }) {
  const context = operationContext.getStore();
  if (context?.operationId) await save(project, { id: context.operationId, kind: context.kind ?? "edit", instance: instance(), state, result, error });
}
export async function readOperation(project: string, id: string): Promise<Operation | null> {
  const file = path(project, id);
  const op = await readFile(file, "utf8").then((s) => schema.parse(JSON.parse(s)), () => null);
  if (!op || op.state !== "running") return op;
  const p = await ws().mustGet(project);
  const commit = p.completedOperations?.[id];
  if (commit) {
    const timeline = commit.timelineFile ? JSON.parse(await readFile(ws().path(project, "jobs", commit.timelineFile), "utf8")) : await ws().readTimeline(project, commit.version);
    return { ...op, state: "completed", result: { project: { ...p, job: null }, timeline, summary: commit.summary, changedRange: commit.changedRange, file: commit.file, media: p.media.find((m) => m.id === commit.mediaId) } };
  }
  return op.instance === instance() ? op : { ...op, state: "interrupted", error: { code: "job_interrupted", message: "The connector restarted. Your last saved edit is intact. Start a new request to retry." } };
}
