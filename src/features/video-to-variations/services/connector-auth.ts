import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CONNECTOR_PROTOCOL = 1;
export const SESSION_MS = 8 * 60 * 60 * 1000;
export const ASSET_MS = 5 * 60 * 1000;
const production = "https://leveric-workbench.vercel.app";
const assetPath = /^\/api\/video-projects\/[a-f0-9-]{36}\/(?:media\/m\d{1,2}\/(?:proxy\.mp4|waveform\.png|t\d{4}\.jpg)|exports\/v\d{3,}-(?:916|169)\.mp4)$/;
type Session = { origin: string; expiresAt: number };
type State = { sessions: Map<string, Session>; paired: boolean; attempts: number; window: number };
const globalState = globalThis as typeof globalThis & { videoConnectorSessions?: State };
const state = () => globalState.videoConnectorSessions ??= { sessions: new Map(), paired: false, attempts: 0, window: Date.now() };
export function resetConnectorSessions() { delete globalState.videoConnectorSessions; }
export const connectorEnabled = () => process.env.VIDEO_CONNECTOR === "1" && !process.env.VERCEL;
export const connectorId = () => process.env.VIDEO_CONNECTOR_ID ?? "local";

export function allowedOrigin(origin: string | null): boolean {
  if (!origin || origin === "null") return false;
  return [production, ...(process.env.VIDEO_CONNECTOR_ORIGINS ?? "").split(",")].includes(origin);
}

function validHost(req: Request): boolean {
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? url.host;
  // Next.js normalises the internal URL to localhost; the wire Host remains authoritative.
  return ["127.0.0.1", "localhost"].includes(url.hostname) && host === `127.0.0.1:${process.env.VIDEO_CONNECTOR_PORT ?? "43127"}`;
}

function equal(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function signature(value: string): string {
  const key = process.env.VIDEO_CONNECTOR_SECRET;
  if (!key || key.length < 64) throw new Error("Start the connector with pnpm video:connector.");
  return createHmac("sha256", key).update(value).digest("base64url");
}
function sessionFor(id: string): Session | undefined {
  const s = state().sessions.get(id);
  if (s && s.expiresAt > Date.now()) return s;
  state().sessions.delete(id);
}

export function pairConnector(req: Request, code: string) {
  if (!connectorEnabled() || !validHost(req) || !allowedOrigin(req.headers.get("origin"))) throw new Error("This origin cannot connect to this computer.");
  const store = state();
  if (Date.now() - store.window > 60_000) { store.window = Date.now(); store.attempts = 0; }
  if (++store.attempts > 5) throw new Error("Too many pairing attempts. Wait one minute.");
  const started = Number(process.env.VIDEO_CONNECTOR_STARTED);
  if (!started || Date.now() - started > 600_000 || store.paired || !equal(digest(code), process.env.VIDEO_CONNECTOR_CODE_HASH ?? "")) throw new Error("The pairing code is invalid or expired. Restart the connector for a new code.");
  signature("check configuration");
  store.paired = true;
  const token = randomBytes(32).toString("base64url");
  const id = digest(token);
  const expiresAt = Date.now() + SESSION_MS;
  store.sessions.set(id, { origin: req.headers.get("origin")!, expiresAt });
  return { token, expiresAt, connectorId: connectorId(), protocol: CONNECTOR_PROTOCOL };
}

export type ConnectorAccess = { ok: true; sessionId: string; origin: string } | { ok: false };
export function connectorAccess(req: Request): ConnectorAccess {
  if (!connectorEnabled() || !validHost(req)) return { ok: false };
  const origin = req.headers.get("origin");
  const bearer = req.headers.get("authorization")?.match(/^Bearer ([\w-]{43})$/)?.[1];
  if (bearer) {
    const id = digest(bearer); const s = sessionFor(id);
    if (s && s.origin === origin && allowedOrigin(origin)) return { ok: true, sessionId: id, origin: s.origin };
  }
  const url = new URL(req.url);
  if (!["GET", "HEAD"].includes(req.method) || !assetPath.test(url.pathname)) return { ok: false };
  const id = url.searchParams.get("sid") ?? "";
  const expiry = Number(url.searchParams.get("exp"));
  const s = sessionFor(id);
  if (!s || expiry <= Date.now() || expiry > Date.now() + ASSET_MS || !Number.isSafeInteger(expiry)) return { ok: false };
  if (origin !== null && (origin !== s.origin || !allowedOrigin(origin))) return { ok: false };
  const expected = signature(`${id}\n${url.pathname}\n${expiry}`);
  return equal(expected, url.searchParams.get("sig") ?? "") ? { ok: true, sessionId: id, origin: s.origin } : { ok: false };
}

export function signAssets(req: Request, paths: string[]): Record<string, string> {
  const access = connectorAccess(req);
  if (!access.ok || !req.headers.has("authorization")) throw new Error("Connect your computer again.");
  if (paths.length > 2500 || paths.some((p) => !assetPath.test(p))) throw new Error("Unknown media resource.");
  const expiry = Math.min(Date.now() + ASSET_MS, sessionFor(access.sessionId)!.expiresAt);
  return Object.fromEntries(paths.map((path) => [path, `${path}?sid=${access.sessionId}&exp=${expiry}&sig=${signature(`${access.sessionId}\n${path}\n${expiry}`)}`]));
}

export function revokeConnector(req: Request) {
  const access = connectorAccess(req);
  if (access.ok) state().sessions.delete(access.sessionId);
}

export function connectorCors(req: Request, response: Response): Response {
  const origin = req.headers.get("origin");
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  if (allowedOrigin(origin) && validHost(req)) {
    response.headers.set("Access-Control-Allow-Origin", origin!);
    response.headers.set("Vary", "Origin");
    response.headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-File-Name, Range, Idempotency-Key, X-Expected-Version");
    response.headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Disposition");
  }
  return response;
}

export function connectorPreflight(req: Request): Response {
  return connectorCors(req, new Response(null, { status: connectorEnabled() && validHost(req) && allowedOrigin(req.headers.get("origin")) ? 204 : 403 }));
}
