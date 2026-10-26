import { chunkCaptions } from "@/features/video-to-variations/services/captions";
import type { Timeline, Word } from "@/features/video-to-variations/types";

const MIN_CLIP_S = 0.1;

/** A short random id for clips, cards and titles. Works in the browser and in Node. */
export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Caption cards for one video (its own seconds): up to 6 words, broken at pauses and sentence ends. */
export function buildCards(mediaId: string, words: Word[]): Timeline["captions"]["cards"] {
  return chunkCaptions(words).map((card) => ({ id: newId(), mediaId, start: card.start, end: card.end, text: card.words.map((w) => w.text).join(" "), emphasis: [] }));
}

/** A new edit: nothing on the timeline yet, 9:16, captions off. */
export function emptyTimeline(): Timeline {
  return { format: "9:16", clips: [], captions: { enabled: false, cards: [] }, titles: [] };
}

/** Puts a whole imported video at the end of the timeline, with caption cards from its transcript. */
export function appendMedia(t: Timeline, media: { id: string; durationS: number }, words: Word[]): Timeline {
  return {
    ...t,
    clips: [...t.clips, { id: newId(), mediaId: media.id, start: 0, end: media.durationS }],
    captions: { ...t.captions, cards: [...t.captions.cards.filter((c) => c.mediaId !== media.id), ...buildCards(media.id, words)] },
  };
}

/**
 * Makes a timeline safe to play and render: clamps each clip to its own video, drops slivers, unknown videos and
 * repeated ids. Keeps clip order. An empty edit is allowed.
 */
export function normaliseTimeline(t: Timeline, media: { id: string; durationS: number }[]): Timeline {
  const length = new Map(media.map((m) => [m.id, m.durationS]));
  const seen = new Set<string>();
  const clips = t.clips
    .filter((c) => length.has(c.mediaId))
    .map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(length.get(c.mediaId)!, c.end) }))
    .filter((c) => c.end - c.start >= MIN_CLIP_S)
    .map((c) => {
      const id = seen.has(c.id) ? newId() : c.id;
      seen.add(id);
      return { ...c, id };
    });
  const cards = t.captions.cards.filter((c) => length.has(c.mediaId) && c.end > c.start && c.start < length.get(c.mediaId)!);
  const titles = t.titles.filter((x) => x.end > x.start);
  return { ...t, clips, captions: { ...t.captions, cards }, titles };
}
