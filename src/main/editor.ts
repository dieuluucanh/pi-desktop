/**
 * The OS editor round trip (2026-10-26 session-parity plan step 21).
 *
 * `shell.openPath` cannot report an exit, so a GUI editor that is closed again
 * would look "done" the moment it launched. This spawns the editor through the
 * shared `CommandRunner` and **awaits** its exit, then reads the scratch file
 * back. The temp file is always removed; a failure leaves the caller's draft
 * untouched.
 *
 * Terminal editors (`vim`, `nano`) need a TTY the app does not have; the caller
 * documents that and offers the in-app expanded editor instead.
 */

import type { CommandRunner } from "./office/exec";
import type { FsPort } from "./fs-port";
import { resolveEditorCommand } from "./editor-command";

/** Long enough for a real editing session; still bounded so nothing hangs forever. */
export const EDITOR_TIMEOUT_MS = 30 * 60 * 1000;

export interface OpenEditorResult {
  ok: boolean;
  /** The edited text, when the editor exited successfully. */
  text?: string;
  error?: string;
  /** Which setting/env var supplied the command (for the UI note). */
  source?: string | null;
}

export async function openInExternalEditor(
  deps: {
    fs: FsPort;
    runner: CommandRunner;
    scratchDir: string;
    setting?: string | null;
    env?: Record<string, string | undefined>;
  },
  draft: string,
): Promise<OpenEditorResult> {
  const resolved = resolveEditorCommand({ setting: deps.setting ?? null, env: deps.env ?? {} });
  if (resolved.error) return { ok: false, error: resolved.error };
  if (!resolved.editor) {
    return {
      ok: false,
      error: "No external editor is configured. Set `externalEditor`, or use the in-app editor.",
    };
  }
  const file = `${deps.scratchDir}/pi-editor-${Date.now()}.md`;
  try {
    await deps.fs.ensureDir(deps.scratchDir);
    await deps.fs.writeTextFile(file, draft);
    const result = await deps.runner.run(resolved.editor.command, [...resolved.editor.args, file], {
      timeoutMs: EDITOR_TIMEOUT_MS,
    });
    if (result.missing) {
      return {
        ok: false,
        error: `The editor "${resolved.editor.command}" was not found.`,
        source: resolved.source,
      };
    }
    if (result.code !== 0) {
      return {
        ok: false,
        error: `The editor exited with code ${result.code}. The draft was not changed.`,
        source: resolved.source,
      };
    }
    const text = await deps.fs.readTextFile(file);
    return { ok: true, text: text ?? draft, source: resolved.source };
  } catch (error) {
    return { ok: false, error: String(error) };
  } finally {
    // The scratch file may hold sensitive prompt text; never leave it behind.
    await deps.fs.remove(file);
  }
}
