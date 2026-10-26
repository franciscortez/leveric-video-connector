import { editWithClaude } from "@/features/video-to-variations/services/claude-editor";

export interface EditorProvider {
  readonly id: "claude" | "codex";
  edit: typeof editWithClaude;
}
export const claudeEditor: EditorProvider = { id: "claude", edit: editWithClaude };
// Codex deliberately has no adapter until commercial subscription authentication is approved.
