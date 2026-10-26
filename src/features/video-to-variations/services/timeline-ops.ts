import { newId } from "@/features/video-to-variations/services/timeline";
import type { Format, TimeRange, Timeline } from "@/features/video-to-variations/types";

// Pure timeline edits and time mapping, shared by the editor (browser) and the server.
// Every edit returns a new timeline, or the same object when nothing changes.

const MIN_CLIP_S = 0.1;
const MIN_VISIBLE_S = 0.05;

const len = (c: { start: number; end: number }) => c.end - c.start;

export function duration(t: Timeline): number {
  return t.clips.reduce((sum, c) => sum + len(c), 0);
}

/** Where each clip starts in output time. */
export function offsets(t: Timeline): number[] {
  let at = 0;
  return t.clips.map((c) => {
    const start = at;
    at += len(c);
    return start;
  });
}

/** The clip and source second playing at an output second. A clip boundary belongs to the next clip; the very end to the last. */
export function toSource(t: Timeline, outS: number): { clipIndex: number; sourceS: number } | null {
  let at = 0;
  for (let i = 0; i < t.clips.length; i++) {
    const c = t.clips[i];
    const last = i === t.clips.length - 1;
    if (outS >= at && (outS < at + len(c) || (last && outS <= at + len(c) + 1e-9))) return { clipIndex: i, sourceS: c.start + (outS - at) };
    at += len(c);
  }
  return null;
}

export function toOutput(t: Timeline, clipIndex: number, sourceS: number): number {
  return offsets(t)[clipIndex] + (sourceS - t.clips[clipIndex].start);
}

export function clipAt(t: Timeline, outS: number): number | null {
  return toSource(t, outS)?.clipIndex ?? null;
}

/** The source ranges that an output range covers, clip by clip, in playback order. */
export function outputRangeToSource(t: Timeline, range: TimeRange): (TimeRange & { mediaId: string })[] {
  const out: (TimeRange & { mediaId: string })[] = [];
  offsets(t).forEach((at, i) => {
    const c = t.clips[i];
    const start = Math.max(range.start, at);
    const end = Math.min(range.end, at + len(c));
    if (end - start > 0) out.push({ mediaId: c.mediaId, start: c.start + (start - at), end: c.start + (end - at) });
  });
  return out;
}

/** Splits the clip under the playhead. No change at or very near a clip edge. */
export function split(t: Timeline, outS: number): Timeline {
  const hit = toSource(t, outS);
  if (!hit) return t;
  const c = t.clips[hit.clipIndex];
  if (hit.sourceS - c.start < MIN_CLIP_S || c.end - hit.sourceS < MIN_CLIP_S) return t;
  const clips = [...t.clips];
  clips.splice(hit.clipIndex, 1, { ...c, end: hit.sourceS }, { ...c, id: newId(), start: hit.sourceS });
  return { ...t, clips };
}

/** Moves one edge of a clip to a second of its video, kept inside that video (`durationS`) and at least 0.1 s from the other edge. */
export function trim(t: Timeline, clipId: string, edge: "start" | "end", sourceS: number, durationS: number): Timeline {
  return {
    ...t,
    clips: t.clips.map((c) => {
      if (c.id !== clipId) return c;
      return edge === "start" ? { ...c, start: Math.min(Math.max(0, sourceS), c.end - MIN_CLIP_S) } : { ...c, end: Math.max(Math.min(durationS, sourceS), c.start + MIN_CLIP_S) };
    }),
  };
}

/** Removes a clip. Removing the last one leaves an empty edit. */
export function remove(t: Timeline, clipId: string): Timeline {
  return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
}

/** Adds a part of one video (its own seconds) as a new clip at `index` (past the end appends). */
export function insertClip(t: Timeline, mediaId: string, start: number, end: number, index: number): Timeline {
  const clips = [...t.clips];
  clips.splice(Math.max(0, Math.min(index, clips.length)), 0, { id: newId(), mediaId, start, end });
  return { ...t, clips };
}

export function move(t: Timeline, clipId: string, toIndex: number): Timeline {
  const from = t.clips.findIndex((c) => c.id === clipId);
  if (from < 0) return t;
  const clips = [...t.clips];
  const [clip] = clips.splice(from, 1);
  clips.splice(Math.max(0, Math.min(toIndex, clips.length)), 0, clip);
  return { ...t, clips };
}

export function editCaption(t: Timeline, cardId: string, text: string): Timeline {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return {
    ...t,
    captions: { ...t.captions, cards: t.captions.cards.map((c) => (c.id === cardId ? { ...c, text, emphasis: c.emphasis.filter((i) => i < words) } : c)) },
  };
}

export function setCaptions(t: Timeline, enabled: boolean): Timeline {
  return { ...t, captions: { ...t.captions, enabled } };
}

export function setFormat(t: Timeline, format: Format): Timeline {
  return { ...t, format };
}

export interface VisibleCaption {
  id: string;
  start: number;
  end: number;
  text: string;
  emphasis: number[];
}

/** Caption cards in output time, clip by clip. A card cut by an edit shows only for the part that still plays. */
export function visibleCaptions(t: Timeline): VisibleCaption[] {
  if (!t.captions.enabled) return [];
  const out: VisibleCaption[] = [];
  offsets(t).forEach((at, i) => {
    const c = t.clips[i];
    for (const card of t.captions.cards) {
      if (card.mediaId !== c.mediaId) continue;
      const start = Math.max(card.start, c.start);
      const end = Math.min(card.end, c.end);
      if (end - start >= MIN_VISIBLE_S) out.push({ id: card.id, start: at + (start - c.start), end: at + (end - c.start), text: card.text, emphasis: card.emphasis });
    }
  });
  return out.sort((a, b) => a.start - b.start);
}
