import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import { claudeBin } from "@/features/video-to-variations/services/claude-cli";
import { binaries, runProcess } from "@/features/video-to-variations/services/ffmpeg";
import { pythonBin } from "@/features/video-to-variations/services/transcribe";
import { defaultWorkspaceRoot } from "@/features/video-to-variations/services/workspace";
import { connectorId, CONNECTOR_PROTOCOL } from "@/features/video-to-variations/services/connector-auth";

async function check(bin: string, args: string[]) {
  const script = /\.m?js$/.test(bin);
  return runProcess(script ? process.execPath : bin, script ? [bin, ...args] : args, { signal: AbortSignal.timeout(15_000) });
}

export function supportedClaudeVersion(value: string): boolean {
  const v = value.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  return !!v && (v[0] > 2 || (v[0] === 2 && (v[1] > 1 || (v[1] === 1 && v[2] >= 310))));
}

export async function claudeReadiness(): Promise<{ ready: boolean; message: string }> {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX || process.env.CLAUDE_CODE_USE_FOUNDRY) {
    return { ready: false, message: "Use native Claude subscription sign-in. Remove API/provider overrides from the connector environment." };
  }
  try {
    const version = (await check(claudeBin(), ["--version"])).stdout;
    if (!supportedClaudeVersion(version)) return { ready: false, message: "Update Claude Code to 2.1.310 or later." };
    const result = await check(claudeBin(), ["auth", "status"]);
    const auth = z.object({ loggedIn: z.boolean(), authMethod: z.string() }).parse(JSON.parse(result.stdout));
    return auth.loggedIn && auth.authMethod === "claude.ai"
      ? { ready: true, message: "Claude Code subscription connected" }
      : { ready: false, message: "Run claude auth login and choose your Claude subscription." };
  } catch {
    return { ready: false, message: "Install Claude Code and run claude auth login on this computer." };
  }
}

export async function connectorStatus() {
  const checks = await Promise.allSettled([
    check(binaries.ffmpeg(), ["-version"]), check(binaries.ffprobe(), ["-version"]),
    check(pythonBin(), ["-I", "-c", "import faster_whisper"]),
    check(pythonBin(), ["-I", "-c", "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', local_files_only=True)"]),
    mkdir(defaultWorkspaceRoot(), { recursive: true }).then(() => access(defaultWorkspaceRoot(), constants.W_OK)),
    check(binaries.ffmpeg(), ["-hide_banner", "-filters"]).then((r) => { if (!/\bsubtitles\b/.test(r.stdout)) throw new Error("Subtitle filter unavailable"); }),
  ]);
  const [ffmpeg, ffprobe, python, transcriptionModel, storage, subtitles] = checks.map((r) => r.status === "fulfilled");
  return {
    protocol: CONNECTOR_PROTOCOL, connectorId: connectorId(), manualEditing: storage,
    dependencies: { ffmpeg, ffprobe, python, transcriptionModel, storage, subtitles },
    providers: {
      claude: await claudeReadiness(),
      codex: { ready: false, message: "Codex is not available yet. Approved commercial authentication is required." },
    },
  };
}
