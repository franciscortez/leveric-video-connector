import { videoRoute, connectorPreflight } from "@/features/video-to-variations";
import { promptResponse } from "@/features/video-to-variations";

/** Body: { prompt, range?, model? } with range in output seconds. Streams NDJSON. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return videoRoute(req, () => promptResponse(req, id));
}

export { connectorPreflight as OPTIONS };
