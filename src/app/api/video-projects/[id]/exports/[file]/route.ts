import { videoRoute, connectorPreflight } from "@/features/video-to-variations";
import { exportFileResponse } from "@/features/video-to-variations";

/** An exported MP4, as a download. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await ctx.params;
  return videoRoute(req, () => exportFileResponse(req, id, file));
}

export { connectorPreflight as OPTIONS };
export { GET as HEAD };
