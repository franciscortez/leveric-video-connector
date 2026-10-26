import type { Format, Title, Word } from "@/features/video-to-variations/types";

export interface WordGroup {
  start: number;
  end: number;
  words: Word[];
}

/** A caption ready to draw: output seconds, text, and positions of words to emphasise. */
export interface AssCaption {
  start: number;
  end: number;
  text: string;
  emphasis: number[];
}

const MAX_GAP_S = 0.6;
const SENTENCE_END = /[.?!…]$/;

/** Groups words into short caption cards: at most `maxWords`, broken at long pauses and sentence ends. */
export function chunkCaptions(words: Word[], maxWords = 6): WordGroup[] {
  const cards: WordGroup[] = [];
  let current: Word[] = [];
  for (const word of words) {
    const prev = current.at(-1);
    if (prev && (current.length >= maxWords || word.start - prev.end > MAX_GAP_S || SENTENCE_END.test(prev.text))) {
      cards.push(group(current));
      current = [];
    }
    current.push(word);
  }
  if (current.length) cards.push(group(current));
  return cards;
}

function group(words: Word[]): WordGroup {
  return { start: words[0].start, end: words.at(-1)!.end, words };
}

const WHITE = "&HFFFFFF&";
// #E0201B in ASS's blue-green-red order.
const RED = "&H1B20E0&";

export const FRAME: Record<Format, { w: number; h: number }> = { "9:16": { w: 1080, h: 1920 }, "16:9": { w: 1920, h: 1080 } };

function time(s: number): string {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** Text is data, never ASS override codes. */
function escapeText(text: string): string {
  return text.replaceAll("\\", "＼").replaceAll("{", "\\{").replaceAll("}", "\\}").replaceAll("\n", " ").toUpperCase();
}

/** An ASS subtitle file with captions and titles (output seconds), styled per the tool 06 spec for the chosen format. */
export function toAss(captions: AssCaption[], titles: Title[], format: Format): string {
  const { w, h } = FRAME[format];
  const vertical = format === "9:16";
  const side = Math.round(w * 0.08);
  const bottom = Math.round(h * (vertical ? 0.22 : 0.12));
  const top = Math.round(h * 0.12);
  const captionSize = Math.round(h * (vertical ? 0.044 : 0.06));
  const titleSize = Math.round(h * (vertical ? 0.05 : 0.075));
  const outline = Math.max(2, Math.round(Math.min(w, h) / 180));

  const lines = captions.map((c) => {
    const emphasised = new Set(c.emphasis);
    const text = c.text
      .trim()
      .split(/\s+/)
      .map((word, i) => (emphasised.has(i) ? `{\\c${RED}}${escapeText(word)}{\\c${WHITE}}` : escapeText(word)))
      .join(" ");
    return `Dialogue: 0,${time(c.start)},${time(c.end)},Caption,,0,0,0,,${text}`;
  });
  for (const t of titles) lines.unshift(`Dialogue: 1,${time(t.start)},${time(t.end)},Title,,0,0,0,,${escapeText(t.text)}`);

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,Arial Black,${captionSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,${side},${side},${bottom},1`,
    `Style: Title,Arial Black,${titleSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,8,${side},${side},${top},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...lines,
    "",
  ].join("\n");
}
