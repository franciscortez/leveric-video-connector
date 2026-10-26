import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/respond";
import { connectorAccess, connectorCors, connectorEnabled } from "@/features/video-to-variations/services/connector-auth";
import { operationContext } from "@/features/video-to-variations/services/operation-context";
import { readOperation } from "@/features/video-to-variations/services/operations";
import { jobRunning, ndjson, startJob, workspace } from "@/features/video-to-variations/services/http";

export async function videoRoute(req: Request | undefined, handle: () => Promise<Response>): Promise<Response> {
  if (!connectorEnabled()) {
    // Development remains same-origin. A public website cannot drive an unpaired dev server.
    if (req?.headers.has("origin") && req.headers.get("origin") !== new URL(req.url).origin) return fail("origin_denied", "Use the paired connector.", 403);
    return handle();
  }
  if (!req) return fail("connector_unauthorised", "Connect your computer again.", 401);
  const reply = (r: Response) => connectorCors(req, r);
  if (!connectorAccess(req).ok) return reply(fail("connector_unauthorised", "Connect your computer again.", 401));
  const url = new URL(req.url);
  const project = /^\/api\/video-projects\/([a-f0-9-]{36})(?:\/|$)/.exec(url.pathname)?.[1];
  const mutation = !["GET", "HEAD"].includes(req.method);
  const kind = /\/(media|prompt|export)$/.exec(url.pathname)?.[1];
  const operationId = kind && mutation ? req.headers.get("idempotency-key") ?? undefined : undefined;
  if (kind && mutation && !/^[a-f0-9-]{36}$/.test(operationId ?? "")) return reply(fail("request_id_required", "An operation ID is required.", 400));
  return operationContext.run({ owner: randomUUID(), operationId, kind }, async () => {
    const release = mutation && project ? startJob(project) : () => {};
    if (!release) return reply(jobRunning());
    try {
      if (project && operationId) {
        const prior = await readOperation(project, operationId);
        if (prior) {
          if (prior.kind !== kind) return reply(fail("request_id_conflict", "Use a new operation ID.", 409));
          if (prior.state === "completed" && prior.result) return reply(ndjson(async () => prior.result!));
          return reply(fail(prior.error?.code ?? "job_running", prior.error?.message ?? "This request is already running.", 409));
        }
      }
      if (mutation && project) {
        const p = await workspace().get(project);
        if (!p) return reply(fail("project_not_found", "This edit was not found.", 404));
        const raw = req.headers.get("x-expected-version");
        if (!raw || !/^\d+$/.test(raw)) return reply(fail("version_required", "Reload the edit before changing it.", 400));
        if (Number(raw) !== (p.revision ?? p.current)) return reply(fail("version_conflict", "This edit changed elsewhere. Reload it before continuing.", 409));
      }
      return reply(await handle());
    } finally { release(); }
  });
}

export async function operationResponse(project: string, id: string): Promise<Response> {
  if (!/^[a-f0-9-]{36}$/.test(id)) return fail("invalid_job", "Unknown operation.", 400);
  const op = await readOperation(project, id);
  return op ? ok(op) : fail("job_not_found", "This operation was not started.", 404);
}
