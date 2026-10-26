import { connectorResponse, connectorPreflight } from "@/features/video-to-variations";
async function handle(req: Request, ctx: { params: Promise<{ action: string }> }) {
  return connectorResponse(req, (await ctx.params).action);
}
export { handle as GET, handle as POST, handle as DELETE, connectorPreflight as OPTIONS };
