/**
 * Terminal bridge contract (2026-11-05 native-terminal plan, step 7).
 *
 * The renderer addresses a **tab** for `create` (main resolves the cwd, trust,
 * profile and shell path) and a **terminal id** for everything after that. It
 * never sends a shell path or an environment: those are main's decisions.
 *
 * `create` is idempotent per tab, so a remount after a pane switch or a renderer
 * reload reattaches to the live PTY instead of spawning a second shell.
 */

import type { TrustAnswer } from "./projects";
import type {
  TerminalAttachResult,
  TerminalErrorCode,
  TerminalEventFrame,
  TerminalInfo,
} from "./terminal-protocol";
import type { TerminalProfile, TerminalProfileSnapshot } from "./terminal-profiles";

export interface TerminalCreateInput {
  tabId: string;
  cols: number;
  rows: number;
  /** The profile the tab was opened with; main falls back to the preference. */
  profileId?: string | null;
  /**
   * A trust answer already given for this project in this app run. `session`
   * and `trust` allow the spawn; `never` refuses it; absent asks the renderer to
   * show the existing trust prompt.
   */
  trust?: TrustAnswer;
}

export type TerminalCreateOutcome =
  | {
      kind: "ok";
      terminal: TerminalInfo;
      /** Ring-buffer snapshot to replay before live frames resume. */
      replay: TerminalAttachResult;
    }
  | { kind: "needs-trust"; cwd: string }
  | { kind: "unavailable"; message: string; profiles: TerminalProfile[] }
  | {
      kind: "error";
      code: TerminalErrorCode;
      message: string;
      /** The native-load / host report behind the banner's Details disclosure. */
      details?: string;
    };

export interface TerminalBridge {
  /** Creates or reattaches the terminal for a tab. */
  create(input: TerminalCreateInput): Promise<TerminalCreateOutcome>;
  /** Replays the ring buffer for a live terminal; null when it is gone. */
  attach(terminalId: string): Promise<TerminalAttachResult | null>;
  write(terminalId: string, data: string): Promise<void>;
  resize(terminalId: string, cols: number, rows: number): Promise<void>;
  /** Closes the PTY and its process tree; false when it was already gone. */
  close(terminalId: string): Promise<boolean>;
  /** Fire-and-forget flow-control credit; a lost ack only delays the PTY. */
  ack(terminalId: string, bytes: number): void;
  /** Live terminals for this window (used to reattach after a reload). */
  list(): Promise<TerminalInfo[]>;
  profiles(force?: boolean): Promise<TerminalProfileSnapshot>;
  /**
   * Tells main whether a terminal has keyboard focus. On Windows/Linux main
   * suppresses menu accelerators while it does, so Ctrl+N/W/B/G reach the shell.
   */
  setFocus(focused: boolean): void;
  onEvent(listener: (frame: TerminalEventFrame) => void): () => void;
}
