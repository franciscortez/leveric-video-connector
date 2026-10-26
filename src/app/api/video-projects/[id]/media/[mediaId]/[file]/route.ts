import { videoRoute, connectorPreflight } from "@/features/video-to-variations";
import { mediaFileResponse } from "@/features/video-to-variations";

/** A video's proxy (with HTTP Range), thumbnails and waveform. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; mediaId: string; file: string }> }) {
  const { id, mediaId, file } = await ctx.params;
  return videoRoute(req, () => mediaFileResponse(req, id, mediaId, file));
}

export { connectorPreflight as OPTIONS };
export { GET as HEAD };
