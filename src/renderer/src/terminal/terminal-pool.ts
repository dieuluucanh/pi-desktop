/**
 * xterm instance pool (2026-11-05 native-terminal plan, step 8).
 *
 * A terminal's scrollback, alt-screen state and selection live in the xterm
 * instance, not in React. Unmounting a tab (a pane switch, a grid layout change,
 * the solo/grid transition) must therefore **move** the terminal's container, not
 * dispose it — otherwise every pane switch wipes the shell's screen.
 *
 * The pool is deliberately generic over a small `PoolTerminal` surface so it can
 * be unit-tested with a fake factory; the real `@xterm/xterm` adapter lands with
 * the view (step 9).
 */

import type { TerminalTheme } from "../../../shared/terminal-theme";

/** The slice of xterm the app uses. Kept structural so tests need no canvas. */
/** The appearance options that can be changed on a live xterm instance. */
export interface TerminalOptionsPatch {
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  macOptionIsMeta?: boolean;
}

export interface PoolTerminal {
  readonly element: HTMLElement | undefined;
  write(bytes: Uint8Array, callback?: () => void): void;
  focus(): void;
  dispose(): void;
  /** Recomputes cols/rows from the container; returns the new size. */
  fit(): { cols: number; rows: number };
  getSelection(): string;
  clearSelection(): void;
  selectAll(): void;
  clear(): void;
  findNext(query: string, options?: { caseSensitive?: boolean }): boolean;
  findPrevious(query: string, options?: { caseSensitive?: boolean }): boolean;
  setTheme(theme: TerminalTheme): void;
  /** Applies the whole appearance block without recreating the terminal. */
  setOptions(options: TerminalOptionsPatch): void;
  /** Raw user input; the view owns the key policy and writes to the PTY. */
  onData(listener: (data: string) => void): () => void;
  /** xterm's custom key handler: return false to keep a chord for the app. */
  attachKeyHandler(handler: (event: KeyboardEvent) => boolean): void;
  paste(text: string): void;
  onTitleChange(listener: (title: string) => void): () => void;
  onSelectionChange(listener: () => void): () => void;
  /** BEL from the shell; the view turns it into an opt-in visual flash. */
  onBell(listener: () => void): () => void;
}

export interface TerminalPoolOptions {
  cols: number;
  rows: number;
  fontSize: number;
  fontFamily: string | null;
  scrollback: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  macOptionIsMeta: boolean;
  theme: TerminalTheme;
}

export interface TerminalFactory {
  create(options: TerminalPoolOptions): PoolTerminal;
}

export interface PooledTerminal {
  terminalId: string;
  term: PoolTerminal;
  /** The element the view mounts; moved, never recreated. */
  container: HTMLDivElement;
  /** The element currently hosting `container`, when mounted. */
  host: HTMLElement | null;
}

export class TerminalPool {
  private readonly entries = new Map<string, PooledTerminal>();

  constructor(private readonly factory: TerminalFactory) {}

  has(terminalId: string): boolean {
    return this.entries.has(terminalId);
  }

  get(terminalId: string): PooledTerminal | undefined {
    return this.entries.get(terminalId);
  }

  /** Creates the terminal and its container in one step; idempotent. */
  create(terminalId: string, options: TerminalPoolOptions): PooledTerminal {
    const existing = this.entries.get(terminalId);
    if (existing) return existing;
    const container = document.createElement("div");
    container.className = "terminal-container";
    container.dataset.terminalId = terminalId;
    const term = this.factory.create(options);
    if (term.element) container.append(term.element);
    const entry: PooledTerminal = { terminalId, term, container, host: null };
    this.entries.set(terminalId, entry);
    return entry;
  }

  /** Moves the terminal into `host`; a no-op when it is already there. */
  mount(terminalId: string, host: HTMLElement): boolean {
    const entry = this.entries.get(terminalId);
    if (!entry) return false;
    if (entry.host === host) return true;
    if (entry.container.parentElement !== host) host.append(entry.container);
    entry.host = host;
    return true;
  }

  /** Removes the container from the DOM but keeps the xterm instance alive. */
  detach(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    entry.container.remove();
    entry.host = null;
  }

  /** Writes raw bytes; false when the terminal is unknown (already disposed). */
  write(terminalId: string, bytes: Uint8Array, callback?: () => void): boolean {
    const entry = this.entries.get(terminalId);
    if (!entry) return false;
    entry.term.write(bytes, callback);
    return true;
  }

  focus(terminalId: string): boolean {
    const entry = this.entries.get(terminalId);
    if (!entry) return false;
    entry.term.focus();
    return true;
  }

  fit(terminalId: string): { cols: number; rows: number } | null {
    const entry = this.entries.get(terminalId);
    if (!entry) return null;
    return entry.term.fit();
  }

  setTheme(theme: TerminalTheme): void {
    for (const entry of this.entries.values()) entry.term.setTheme(theme);
  }

  setOptions(options: TerminalOptionsPatch): void {
    for (const entry of this.entries.values()) entry.term.setOptions(options);
  }

  dispose(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    this.entries.delete(terminalId);
    entry.term.dispose();
    entry.container.remove();
  }

  disposeAll(): void {
    for (const terminalId of [...this.entries.keys()]) this.dispose(terminalId);
  }
}
