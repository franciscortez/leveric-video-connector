import { videoRoute, connectorPreflight } from "@/features/video-to-variations";
import { getEditResponse, renameEditResponse } from "@/features/video-to-variations";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return videoRoute(req, () => getEditResponse(id));
}

/** Body: { name }. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return videoRoute(req, () => renameEditResponse(req, id));
}

export { connectorPreflight as OPTIONS };
