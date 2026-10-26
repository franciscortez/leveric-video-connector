import type { z } from "zod";
import type { mediaSchema, projectSchema, versionSchema } from "@/features/video-to-variations/schemas/project.schema";
import type { timelineSchema } from "@/features/video-to-variations/schemas/timeline.schema";

export type Timeline = z.infer<typeof timelineSchema>;
export type Clip = Timeline["clips"][number];
export type CaptionCard = Timeline["captions"]["cards"][number];
export type Title = Timeline["titles"][number];
export type Format = Timeline["format"];
export type Project = z.infer<typeof projectSchema>;
export type Media = z.infer<typeof mediaSchema>;
export type Version = z.infer<typeof versionSchema>;
export type ClaudeModel = "opus" | "sonnet";

/** One transcript word, with its index in that video's transcript and times in seconds. */
export interface Word {
  i: number;
  text: string;
  start: number;
  end: number;
}

/** A time range in seconds. */
export interface TimeRange {
  start: number;
  end: number;
}
