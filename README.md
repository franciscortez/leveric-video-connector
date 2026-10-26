# Leveric video connector

Local processing companion for https://leveric-workbench.vercel.app/tools/video-to-variations. Follow the Windows/macOS instructions on that page. No GitHub account is needed to clone this repository.

Requires Node 24, pnpm 10.34.7, FFmpeg with subtitle support, ffprobe, Python 3.11 with requirements.txt installed into ~/.video-tools/venv, the cached small speech model, and Claude Code 2.1.310+ signed into your own subscription.

Run pnpm install --frozen-lockfile, pnpm video:connector:build, pnpm video:connector:doctor, then pnpm video:connector. Keep the terminal open and paste its pairing code into the hosted page. Original videos and renders stay local; Claude receives prompts, transcripts and selected frames.

The connector binds to 127.0.0.1:43127. Projects live under ~/LevericWorkbench/video, outside this checkout. Restart to obtain a new pairing code. Never place provider credentials in this repository or the browser. No external API key is required.

This is connector-only source exported from an explicit allowlist; no private Workbench history is included. Windows x64 has execution evidence. macOS instructions target Apple Silicon and remain pending full fresh-machine acceptance; Intel is unverified.
