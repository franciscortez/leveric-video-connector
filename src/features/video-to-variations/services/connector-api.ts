import { z } from "zod";
import { fail, ok } from "@/lib/api/respond";
import { connectorAccess, connectorCors, connectorEnabled, CONNECTOR_PROTOCOL, pairConnector, revokeConnector, signAssets } from "@/features/video-to-variations/services/connector-auth";
import { connectorStatus } from "@/features/video-to-variations/services/connector-status";

export async function connectorResponse(req: Request, action: string): Promise<Response> {
  const reply = (r: Response) => connectorCors(req, r);
  if (!connectorEnabled()) return reply(fail("connector_unavailable", "Start the connector on your computer.", 503));
  if (action === "health" && req.method === "GET") return reply(ok({ protocol: CONNECTOR_PROTOCOL }));
  try {
    if (action === "pair" && req.method === "POST") {
      const body = z.object({ code: z.string().max(128) }).parse(await req.json());
      return reply(ok(pairConnector(req, body.code)));
    }
    if (!connectorAccess(req).ok) return reply(fail("connector_unauthorised", "Connect your computer again.", 401));
    if (action === "status" && req.method === "GET") return reply(ok(await connectorStatus()));
    if (action === "session" && req.method === "DELETE") { revokeConnector(req); return reply(ok({ ok: true })); }
    if (action === "assets" && req.method === "POST") {
      const body = z.object({ paths: z.array(z.string().max(200)).max(2500) }).parse(await req.json());
      return reply(ok({ urls: signAssets(req, body.paths) }));
    }
    return reply(fail("not_found", "Unknown connector endpoint.", 404));
  } catch (e) {
    return reply(fail("connector_request_failed", e instanceof z.ZodError ? "Invalid connector request." : e instanceof Error ? e.message : "The connection failed.", 400));
  }
}
