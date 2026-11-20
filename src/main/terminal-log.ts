/**
 * The terminal host's log file (2026-11-08 linux-terminal plan, step 2).
 *
 * A packaged app has no console. The 0.8.0 Linux terminal failed with
 * `Failed to load native module: pty.node` and the only copy of that message
 * went to `console.error` — invisible when the AppImage is launched from a
 * menu. The supervisor's `log` sink now also appends here, so a user can attach
 * one file to a bug report and Diagnostics can name it.
 *
 * Deliberately tiny and injected: the caller supplies an `FsPort`, the module
 * keeps a byte estimate and rotates a single `.1` segment. Writes are serialized
 * and every failure is swallowed — logging must never break the terminal.
 */

import type { FsPort } from "./fs-port";

/** ~1 MiB, matching the Pi host's per-session log ceiling. */
export const TERMINAL_LOG_MAX_CHARS = 1_000_000;

export interface TerminalLog {
  /** The file this log appends to (Diagnostics and bug reports point at it). */
  readonly file: string;
  /** Appends one line; formatted with an ISO timestamp. Never throws. */
  write(line: string): void;
}

export interface TerminalLogOptions {
  file: string;
  fs: Pick<FsPort, "readTextFile" | "writeTextFile" | "appendTextFile">;
  maxChars?: number;
  now?: () => number;
}

export function createTerminalLog(options: TerminalLogOptions): TerminalLog {
  const { file, fs } = options;
  const maxChars = Math.max(1024, options.maxChars ?? TERMINAL_LOG_MAX_CHARS);
  const now = options.now ?? (() => Date.now());
  /** Null until the current size is read; the file may predate this run. */
  let chars: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  const stamp = (line: string): string => {
    const body = line.endsWith("\n") ? line : `${line}\n`;
    return `${new Date(now()).toISOString()}  ${body}`;
  };

  const append = async (text: string): Promise<void> => {
    if (chars === null) chars = (await fs.readTextFile(file))?.length ?? 0;
    if (chars > 0 && chars + text.length > maxChars) {
      // Keep one previous segment. Copying (rather than rename) keeps this
      // portable: `rename` refuses to replace an existing `.1` on Windows.
      const previous = await fs.readTextFile(file);
      if (previous && previous.length > 0) {
        await fs.writeTextFile(`${file}.1`, previous).catch(() => undefined);
      }
      chars = 0;
      await fs.writeTextFile(file, "").catch(() => undefined);
    }
    await fs.appendTextFile(file, text);
    chars += text.length;
  };

  return {
    file,
    write(line: string): void {
      const text = stamp(line);
      chain = chain.then(() => append(text)).catch(() => undefined);
    },
  };
}
