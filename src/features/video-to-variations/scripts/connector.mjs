import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const mode = process.argv[2] ?? "start";
const workspace = resolve(process.env.VIDEO_WORKSPACE || join(homedir(), "LevericWorkbench", "video"));
const port = Number(process.env.VIDEO_CONNECTOR_PORT || 43127);
const env = { ...process.env, VIDEO_CONNECTOR: "1", VIDEO_WORKSPACE: workspace, VIDEO_CONNECTOR_PORT: String(port) };
const next = require.resolve("next/dist/bin/next");

async function run(args, environment = env) {
  const child = spawn(process.execPath, [next, ...args], { cwd: root, env: environment, stdio: "inherit", windowsHide: true });
  const stop = () => child.kill();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); resolve(code ?? 1); });
  });
}
function doctor() {
  const python = env.VIDEO_PYTHON || join(homedir(), ".video-tools", "venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
  const checks = [["Claude Code", env.VIDEO_CLAUDE_BIN || "claude", ["--version"]], ["FFmpeg", env.VIDEO_FFMPEG_BIN || "ffmpeg", ["-version"]], ["ffprobe", env.VIDEO_FFPROBE_BIN || "ffprobe", ["-version"]], ["faster-whisper", python, ["-I", "-c", "import faster_whisper"]], ["Cached small speech model", python, ["-I", "-c", "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', local_files_only=True)"]]];
  for (const [label, binary, args] of checks) {
    const script = /\.m?js$/.test(binary);
    const result = spawnSync(script ? process.execPath : binary, script ? [binary, ...args] : args, { env, windowsHide: true, timeout: 20000, stdio: "pipe" });
    process.stdout.write(`${label}: ${result.status === 0 ? "ready" : "missing or unavailable ? see the website setup instructions"}\n`);
  }
  const ff = spawnSync(env.VIDEO_FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-filters"], { env, windowsHide: true, timeout: 15000, encoding: "utf8" });
  process.stdout.write(`FFmpeg subtitles: ${ff.status === 0 && /\bsubtitles\b/.test(ff.stdout || "") ? "ready" : "missing ? install a full FFmpeg build"}\n`);
  const bin = env.VIDEO_CLAUDE_BIN || "claude";
  const script = /\.m?js$/.test(bin);
  const version = spawnSync(script ? process.execPath : bin, script ? [bin, "--version"] : ["--version"], { env, windowsHide: true, timeout: 15000, encoding: "utf8" });
  const parts = (version.stdout || "").match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const supported = parts && (parts[0] > 2 || (parts[0] === 2 && (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 310))));
  process.stdout.write(`Claude minimum version: ${supported ? "ready" : "update Claude Code to 2.1.310 or later"}\n`);
  const auth = spawnSync(script ? process.execPath : bin, script ? [bin, "auth", "status"] : ["auth", "status"], { env, windowsHide: true, timeout: 15000, encoding: "utf8" });
  let ready = false;
  try { const parsed = JSON.parse(auth.stdout); ready = auth.status === 0 && parsed.loggedIn && parsed.authMethod === "claude.ai"; } catch {}
  process.stdout.write(`Claude subscription: ${ready ? "signed in" : "run claude auth login and choose your subscription"}\n`);
}
async function start() {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a VIDEO_CONNECTOR_PORT between 1024 and 65535.");
  await readFile(join(root, ".next-video-connector", "BUILD_ID")).catch(() => { throw new Error("Run pnpm video:connector:build first."); });
  await mkdir(workspace, { recursive: true });
  const lockPath = join(workspace, ".connector.lock");
  try {
    const old = JSON.parse(await readFile(lockPath, "utf8"));
    let live = true;
    try { process.kill(old.pid, 0); } catch (e) { if (e.code === "ESRCH") live = false; }
    if (live) throw new Error("A connector already owns this workspace. Stop it before starting another.");
    await unlink(lockPath);
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  const lock = await open(lockPath, "wx", 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
  try {
    await new Promise((resolve, reject) => { const probe = createServer(); probe.once("error", () => reject(new Error(`Port ${port} is occupied. Choose VIDEO_CONNECTOR_PORT explicitly.`))); probe.listen(port, "127.0.0.1", () => probe.close(resolve)); });
    let id;
    const identity = join(workspace, ".connector-id");
    try { id = (await readFile(identity, "utf8")).trim(); } catch { id = randomUUID(); const file = await open(identity, "wx", 0o600); await file.writeFile(id); await file.close(); }
    // Remove only unreferenced media directories left by an interrupted import, under verified project roots.
    for (const entry of await readdir(workspace, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const projectRoot = join(workspace, entry.name);
      let project;
      try { project = JSON.parse(await readFile(join(projectRoot, "project.json"), "utf8")); } catch { continue; }
      const mediaRoot = join(projectRoot, "media");
      for (const media of await readdir(mediaRoot, { withFileTypes: true }).catch(() => [])) {
        if (media.isDirectory() && /^m\d{1,2}$/.test(media.name) && !project.media.some((m) => m.id === media.name)) {
          const target = resolve(mediaRoot, media.name);
          if (dirname(target) !== resolve(mediaRoot)) throw new Error("Unsafe staging path.");
          await rm(target, { recursive: true });
        }
      }
    }
    doctor();
    const code = randomBytes(32).toString("hex");
    Object.assign(env, { VIDEO_CONNECTOR_ID: id, VIDEO_CONNECTOR_INSTANCE: randomUUID(), VIDEO_CONNECTOR_SECRET: randomBytes(32).toString("hex"), VIDEO_CONNECTOR_CODE_HASH: createHash("sha256").update(code).digest("hex"), VIDEO_CONNECTOR_STARTED: String(Date.now()) });
    process.stdout.write(`\nConnector: http://127.0.0.1:${port}\nPairing code (single use, expires in 10 minutes):\n${code}\n\nOpen the hosted video editor, select Connect your computer and paste this code. Keep this terminal open.\n`);
    return await run(["start", "--hostname", "127.0.0.1", "--port", String(port)]);
  } finally { await unlink(lockPath); }
}
try {
  if (process.env.VERCEL) throw new Error("Run the connector on your own computer, not on Vercel.");
  if (mode === "build") process.exitCode = await run(["build"]);
  else if (mode === "doctor") doctor();
  else if (mode === "start") process.exitCode = await start();
  else throw new Error("Use build, start or doctor.");
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
