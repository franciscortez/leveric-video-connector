import { videoRoute, connectorPreflight } from "@/features/video-to-variations";
import { putTimelineResponse } from "@/features/video-to-variations";

/** Body: { timeline, label }. Saves a hand edit as a new version. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return videoRoute(req, () => putTimelineResponse(req, id));
}

export { connectorPreflight as OPTIONS };
