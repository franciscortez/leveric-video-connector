import { z } from "zod";

const seconds = z.number().min(0);
const id = z.string().min(1).max(40);
const mediaId = z.string().regex(/^m\d{1,2}$/).describe("Which imported video this comes from");

/** The edit. Clips and caption cards are in source seconds; titles are in output seconds. Clip order is playback order. */
export const timelineSchema = z.object({
  format: z.enum(["9:16", "16:9"]).describe("Output shape: 9:16 is 1080x1920, 16:9 is 1920x1080"),
  clips: z
    .array(z.object({ id, mediaId, start: seconds, end: seconds }))
    .max(300)
    .describe("Parts of the imported videos to keep, in each video's own seconds, in playback order. Reordering is allowed"),
  captions: z.object({
    enabled: z.boolean().describe("Whether captions are shown and burned in"),
    cards: z
      .array(
        z.object({
          id,
          mediaId,
          start: seconds,
          end: seconds,
          text: z.string().max(200),
          emphasis: z.array(z.number().int().min(0)).max(20).describe("Positions (0-based) of words in `text` to show in red"),
        }),
      )
      .max(2000)
      .describe("Caption cards in their video's own seconds; a card shows while that part of that video plays"),
  }),
  titles: z
    .array(z.object({ id, text: z.string().min(1).max(120), start: seconds, end: seconds }))
    .max(50)
    .describe("Title text over the video, in output seconds"),
});

export class TimelineInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineInvalidError";
  }
}
