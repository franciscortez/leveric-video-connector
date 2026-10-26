import { videoRoute, connectorPreflight } from "@/features/video-to-variations";
import { putStyleResponse } from "@/features/video-to-variations";

/** Body: the style guide as plain text. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return videoRoute(req, () => putStyleResponse(req, id));
}

export { connectorPreflight as OPTIONS };
