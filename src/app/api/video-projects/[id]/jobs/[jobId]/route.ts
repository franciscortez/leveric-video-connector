import { videoRoute, operationResponse, connectorPreflight } from "@/features/video-to-variations";
export async function GET(req: Request, ctx: { params: Promise<{ id: string; jobId: string }> }) {
  const { id, jobId } = await ctx.params;
  return videoRoute(req, () => operationResponse(id, jobId));
}
export { connectorPreflight as OPTIONS };
