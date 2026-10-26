import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { TimelineInvalidError, timelineSchema } from "@/features/video-to-variations/schemas/timeline.schema";
import { buildClaudeArgs, runClaude } from "@/features/video-to-variations/services/claude-cli";
import { buildCards, normaliseTimeline } from "@/features/video-to-variations/services/timeline";
import { versionName, type Workspace } from "@/features/video-to-variations/services/workspace";
import type { ClaudeModel, Project, TimeRange, Timeline, Word } from "@/features/video-to-variations/types";
import type { RunProgress } from "@/types/tool";

/** What Claude returns: the whole new timeline, a short report, and the output range it changed. */
export const claudeEditSchema = z.object({
  timeline: timelineSchema,
  summary: z.string().max(1000).describe("One or two plain sentences on what you changed"),
  changedRange: z.object({ start: z.number().min(0), end: z.number().min(0) }).nullable().describe("Output seconds you changed, or null"),
});

const systemPath = () => join(process.cwd(), "src", "features", "video-to-variations", "prompts", "system.md");

let schemaText: string | null = null;
function schema(): string {
  if (!schemaText) {
    const jsonSchema = z.toJSONSchema(claudeEditSchema) as Record<string, unknown>;
    delete jsonSchema.$schema;
    schemaText = JSON.stringify(jsonSchema);
  }
  return schemaText;
}

/** m:ss.s, as the timeline shows it. */
export function clock(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

function buildPrompt(p: Project, words: Map<string, Word[]>, request: string, range: TimeRange | null): string {
  const media = p.media.map((m) => {
    const speech = words.get(m.id)?.length ? `speech in ${m.language ?? "an unknown language"}, word timings in media/${m.id}/transcript.json, pauses in media/${m.id}/silences.json` : "no speech";
    return `- ${m.id} "${m.name}": ${m.durationS.toFixed(1)} s, ${m.width}x${m.height}, folder media/${m.id}/ (still frames in media/${m.id}/frames/), ${speech}`;
  });
  return [
    `Current timeline: timeline/${versionName(p.current)}.json. House style: style.md.`,
    `Imported videos:\n${media.join("\n")}`,
    `Request: ${request}`,
    range ? `Only change output time ${clock(range.start)}–${clock(range.end)}. Keep everything else exactly as it is.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Claude turned captions on but left out a video that has speech: fill that video's cards from its transcript. */
function fillCaptions(t: Timeline, words: Map<string, Word[]>): Timeline {
  if (!t.captions.enabled) return t;
  const used = new Set(t.clips.map((c) => c.mediaId));
  const missing = [...used].filter((m) => (words.get(m)?.length ?? 0) > 0 && !t.captions.cards.some((c) => c.mediaId === m));
  if (missing.length === 0) return t;
  return { ...t, captions: { ...t.captions, cards: [...t.captions.cards, ...missing.flatMap((m) => buildCards(m, words.get(m)!))] } };
}

async function readWords(ws: Workspace, p: Project): Promise<Map<string, Word[]>> {
  const entries = await Promise.all(
    p.media.map(async (m) => {
      const t = JSON.parse(await readFile(ws.mediaPath(p.id, m.id, "transcript.json"), "utf8").catch(() => '{"words":[]}')) as { words: Word[] };
      return [m.id, t.words] as const;
    }),
  );
  return new Map(entries);
}

/**
 * Asks Claude Code to edit the current timeline and saves its answer as a new version.
 * One repair round on an invalid answer; then TimelineInvalidError. Nothing is saved unless the answer is valid.
 */
export async function editWithClaude(
  ws: Workspace,
  id: string,
  req: { prompt: string; range: TimeRange | null; model: ClaudeModel },
  onProgress: (p: RunProgress) => void,
): Promise<{ version: number; summary: string; changedRange: TimeRange | null }> {
  const p = await ws.mustGet(id);
  if ((await ws.readTimeline(id, p.current)).clips.length === 0) throw new TimelineInvalidError("The timeline is empty. Import a video first.");
  const words = await readWords(ws, p);
  const previousSession = p.providerSessions?.claude ?? p.sessionId;
  const sessionId = previousSession ?? randomUUID();
  let resume = previousSession !== null && previousSession !== undefined;
  let prompt = buildPrompt(p, words, req.prompt, req.range);

  for (let attempt = 0; attempt < 2; attempt++) {
    const args = buildClaudeArgs({ prompt, model: req.model, sessionId, resume, schema: schema(), systemPath: systemPath() });
    const { structured } = await runClaude(args, ws.path(id), (e) => onProgress({ done: 0, total: 1, label: e.label }));
    resume = true;
    try {
      const parsed = claudeEditSchema.safeParse(structured);
      if (!parsed.success) throw new TimelineInvalidError(parsed.error.issues[0]?.message ?? "The answer does not match the schema.");
      const timeline = fillCaptions(normaliseTimeline(parsed.data.timeline, p.media), words);
      if (timeline.clips.length === 0) throw new TimelineInvalidError("The answer removed every clip.");
      const version = await ws.writeTimeline(id, timeline, { source: "claude", label: req.prompt, summary: parsed.data.summary, changedRange: parsed.data.changedRange });
      const saved = await ws.mustGet(id);
      await ws.save({ ...saved, sessionId, providerSessions: { ...saved.providerSessions, claude: sessionId } });
      return { version, summary: parsed.data.summary, changedRange: parsed.data.changedRange };
    } catch (error) {
      if (!(error instanceof TimelineInvalidError) || attempt === 1) throw error;
      prompt = `That timeline was not valid: ${error.message} Return a corrected answer for the same request.`;
      onProgress({ done: 0, total: 1, label: "Fixing the edit" });
    }
  }
  throw new TimelineInvalidError("The edit was not valid.");
}
