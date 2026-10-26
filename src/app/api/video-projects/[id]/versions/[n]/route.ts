import { videoRoute, connectorPreflight } from "@/features/video-to-variations";
import { restoreResponse } from "@/features/video-to-variations";

/** Makes version n current (undo and redo). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await ctx.params;
  return videoRoute(req, () => restoreResponse(id, n));
}

export { connectorPreflight as OPTIONS };
