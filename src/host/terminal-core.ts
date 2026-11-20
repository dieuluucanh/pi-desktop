/**
 * PTY core (2026-11-05 native-terminal plan, step 3).
 *
 * Pure Node, no `node-pty` import and no Electron: the native module arrives as
 * an injected `PtyPort`, and process-tree killing as an injected `TreeKillPort`.
 * That is what lets the lifecycle, batching, ring buffer and flow control be
 * unit-tested with a fake PTY on any machine (`tests/host/fakes/pty.ts`).
 *
 * Flow control is credit-based. The host emits a `terminal.data` frame and adds
 * its byte count to `unacked`; the renderer acks after xterm has parsed the
 * chunk. At `highWaterBytes` the PTY is paused, at `lowWaterBytes` it resumes.
 * Without this, a `yes`-style flood would grow the renderer's write buffer
 * without bound.
 *
 * The ring buffer exists for reattachment: a renderer reload, or a grid pane
 * remount, asks for the last `replayBytes` and resumes live frames above the
 * returned sequence number. `attach()` flushes pending bytes first so the
 * snapshot and the live stream can never overlap.
 */

import { randomUUID } from "node:crypto";
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINALS_PER_WINDOW,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  TERMINAL_CLOSE_GRACE_MS,
  TERMINAL_HIGH_WATER_BYTES,
  TERMINAL_LOW_WATER_BYTES,
  TERMINAL_OUTPUT_BATCH_BYTES,
  TERMINAL_OUTPUT_BATCH_MS,
  TERMINAL_REPLAY_BYTES,
  bytesToBase64,
  isTerminalId,
  isTerminalSize,
  isValidTerminalSpawnSpec,
  terminalInputBytes,
  type TerminalErrorCode,
  type TerminalEventFrame,
  type TerminalExitEvent,
  type TerminalInfo,
  type TerminalSpawnSpec,
} from "../shared/terminal-protocol";

/** What the host needs from a pseudo-terminal; `node-pty` implements it. */
export interface PtyProcess {
  readonly pid: number;
  /**
   * The producer hands over ownership of the chunk: it must not mutate or reuse
   * the array after delivery (node-pty allocates a fresh `Buffer` per event).
   */
  onData(listener: (data: Uint8Array) => void): () => void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export interface PtySpawnInput {
  shell: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  name: string;
}

export interface PtyPort {
  spawn(input: PtySpawnInput): PtyProcess;
}

export type TerminalKillSignal = "SIGTERM" | "SIGKILL";

/**
 * Best-effort kill of the shell's descendants. `node-pty`'s `kill()` only
 * signals the shell itself, so a dev server started in the terminal survives a
 * tab close unless the process group (POSIX) or `taskkill /T` (Windows) is
 * signalled too.
 */
export interface TreeKillPort {
  killTree(pid: number, signal: TerminalKillSignal): void | Promise<void>;
}

export interface TerminalCoreOptions {
  pty: PtyPort;
  treeKill: TreeKillPort;
  emit: (frame: TerminalEventFrame) => void;
  maxTerminals?: number;
  batchBytes?: number;
  batchMs?: number;
  highWaterBytes?: number;
  lowWaterBytes?: number;
  replayBytes?: number;
  closeGraceMs?: number;
  newId?: () => string;
}

export class TerminalCoreError extends Error {
  readonly code: TerminalErrorCode;

  constructor(message: string, code: TerminalErrorCode) {
    super(message);
    this.name = "TerminalCoreError";
    this.code = code;
  }
}

/** Byte ring used for replay; keeps the last `capacity` bytes exactly. */
export class TerminalRingBuffer {
  private chunks: Uint8Array[] = [];
  private total = 0;

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.total;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (chunk.length >= this.capacity) {
      // Keep an owned copy of the tail; a view would pin the whole chunk.
      this.chunks = [chunk.slice(chunk.length - this.capacity)];
      this.total = this.capacity;
      return;
    }
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total > this.capacity) {
      const excess = this.total - this.capacity;
      const first = this.chunks[0];
      if (!first) break;
      if (first.length <= excess) {
        this.chunks.shift();
        this.total -= first.length;
      } else {
        this.chunks[0] = first.slice(excess);
        this.total -= excess;
      }
    }
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

interface TerminalState {
  info: TerminalInfo;
  pty: PtyProcess;
  ring: TerminalRingBuffer;
  pending: Uint8Array[];
  pendingBytes: number;
  seq: number;
  unacked: number;
  paused: boolean;
  exited: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  forceTimer: ReturnType<typeof setTimeout> | null;
  detachData: () => void;
  detachExit: () => void;
}

export interface TerminalAttachSnapshot {
  data: string;
  bytes: number;
  seq: number;
}

function shellTitle(shell: string): string {
  const parts = shell.split(/[\\/]/);
  return parts[parts.length - 1] || "shell";
}

export class TerminalCore {
  private readonly terminals = new Map<string, TerminalState>();
  private readonly maxTerminals: number;
  private readonly batchBytes: number;
  private readonly batchMs: number;
  private readonly highWaterBytes: number;
  private readonly lowWaterBytes: number;
  private readonly replayBytes: number;
  private readonly closeGraceMs: number;
  private readonly newId: () => string;

  constructor(private readonly options: TerminalCoreOptions) {
    this.maxTerminals = options.maxTerminals ?? MAX_TERMINALS_PER_WINDOW;
    this.batchBytes = Math.max(1, options.batchBytes ?? TERMINAL_OUTPUT_BATCH_BYTES);
    this.batchMs = Math.max(0, options.batchMs ?? TERMINAL_OUTPUT_BATCH_MS);
    this.highWaterBytes = Math.max(2, options.highWaterBytes ?? TERMINAL_HIGH_WATER_BYTES);
    this.lowWaterBytes = Math.max(
      1,
      Math.min(options.lowWaterBytes ?? TERMINAL_LOW_WATER_BYTES, this.highWaterBytes - 1),
    );
    this.replayBytes = Math.max(1, options.replayBytes ?? TERMINAL_REPLAY_BYTES);
    this.closeGraceMs = Math.max(0, options.closeGraceMs ?? TERMINAL_CLOSE_GRACE_MS);
    this.newId = options.newId ?? (() => `t-${randomUUID()}`);
  }

  /** Live terminals, in creation order. */
  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((state) => state.info);
  }

  open(spec: TerminalSpawnSpec): TerminalInfo {
    if (!isValidTerminalSpawnSpec(spec)) {
      throw new TerminalCoreError("invalid terminal spawn spec", "bad_request");
    }
    if (this.terminals.size >= this.maxTerminals) {
      throw new TerminalCoreError(
        `the terminal limit (${this.maxTerminals}) has been reached`,
        "limit",
      );
    }

    const id = this.newId();
    if (!isTerminalId(id) || this.terminals.has(id)) {
      throw new TerminalCoreError("could not allocate a terminal id", "protocol");
    }

    let pty: PtyProcess;
    try {
      pty = this.options.pty.spawn({
        shell: spec.shell,
        args: [...spec.args],
        cwd: spec.cwd,
        env: { ...spec.env },
        cols: spec.cols,
        rows: spec.rows,
        name: spec.name,
      });
    } catch (error) {
      // A port that already knows the domain code (the native module could not
      // load) keeps it; only unknown spawn failures become spawn_failed.
      if (error instanceof TerminalCoreError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new TerminalCoreError(`could not start the shell: ${message}`, "spawn_failed");
    }

    const state: TerminalState = {
      info: {
        id,
        pid: pty.pid,
        title: shellTitle(spec.shell),
        cwd: spec.cwd,
        cols: spec.cols,
        rows: spec.rows,
      },
      pty,
      ring: new TerminalRingBuffer(this.replayBytes),
      pending: [],
      pendingBytes: 0,
      seq: 0,
      unacked: 0,
      paused: false,
      exited: false,
      flushTimer: null,
      forceTimer: null,
      detachData: () => undefined,
      detachExit: () => undefined,
    };

    state.detachData = pty.onData((data) => this.ingest(state, data));
    state.detachExit = pty.onExit((event) => this.handleExit(state, event));
    this.terminals.set(id, state);
    return state.info;
  }

  /** Sends input; throws for an unknown/closed terminal or an oversized write. */
  write(terminalId: string, data: string): void {
    const state = this.require(terminalId);
    if (typeof data !== "string") {
      throw new TerminalCoreError("terminal input must be a string", "bad_request");
    }
    if (terminalInputBytes(data) > MAX_TERMINAL_INPUT_BYTES) {
      throw new TerminalCoreError("terminal input is too large", "limit");
    }
    if (data.length === 0) return;
    state.pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const state = this.require(terminalId);
    if (
      !isTerminalSize(cols, rows) ||
      cols < MIN_TERMINAL_COLS ||
      cols > MAX_TERMINAL_COLS ||
      rows < MIN_TERMINAL_ROWS ||
      rows > MAX_TERMINAL_ROWS
    ) {
      throw new TerminalCoreError("invalid terminal size", "bad_request");
    }
    if (state.info.cols === cols && state.info.rows === rows) return;
    state.info = { ...state.info, cols, rows };
    state.pty.resize(cols, rows);
  }

  /** Credits bytes the renderer has parsed; resumes the shell below the low mark. */
  ack(terminalId: string, bytes: number): void {
    const state = this.terminals.get(terminalId);
    if (!state || !Number.isFinite(bytes) || bytes <= 0) return;
    state.unacked = Math.max(0, state.unacked - Math.floor(bytes));
    if (state.paused && state.unacked <= this.lowWaterBytes) {
      state.paused = false;
      try {
        state.pty.resume();
      } catch {
        // A shell that exited between ack and resume must not throw.
      }
    }
    if (state.pendingBytes > 0) this.flush(state);
  }

  /**
   * The replay snapshot for a reattaching renderer. Pending output is flushed
   * first, so the snapshot's `seq` is the last emitted frame and the live stream
   * continues strictly above it.
   */
  attach(terminalId: string): TerminalAttachSnapshot | null {
    const state = this.terminals.get(terminalId);
    if (!state) return null;
    this.flush(state, true);
    const bytes = state.ring.snapshot();
    return { data: bytesToBase64(bytes), bytes: bytes.length, seq: state.seq };
  }

  /**
   * Closes a terminal. Idempotent: a second close (or a close after the shell
   * exited) returns false. `force` skips the grace period.
   */
  close(terminalId: string, options: { force?: boolean } = {}): boolean {
    const state = this.terminals.get(terminalId);
    if (!state) return false;
    this.terminals.delete(terminalId);
    this.clearFlushTimer(state);
    // The user asked to close; show the tail rather than holding it behind the
    // flow-control high-water mark.
    this.flush(state, true);
    state.detachData();

    if (options.force === true) {
      this.forceClose(state);
      return true;
    }

    try {
      state.pty.kill();
    } catch {
      // The process may already be gone.
    }
    void this.options.treeKill.killTree(state.info.pid, "SIGTERM");
    // A shell that exits synchronously on the signal must not leave a timer
    // pointing at a terminal we already finalised.
    if (state.exited) return true;
    state.forceTimer = setTimeout(() => {
      state.forceTimer = null;
      this.forceClose(state);
    }, this.closeGraceMs);
    // Do not keep the host alive just for a closing shell.
    state.forceTimer.unref?.();
    return true;
  }

  /** Kills every terminal; used on host shutdown and parent death. */
  dispose(): void {
    for (const id of [...this.terminals.keys()]) this.close(id, { force: true });
  }

  private require(terminalId: string): TerminalState {
    if (!isTerminalId(terminalId)) {
      throw new TerminalCoreError("invalid terminal id", "bad_request");
    }
    const state = this.terminals.get(terminalId);
    if (!state) throw new TerminalCoreError("terminal not found", "not_found");
    if (state.exited) throw new TerminalCoreError("terminal has exited", "closed");
    return state;
  }

  private ingest(state: TerminalState, chunk: Uint8Array): void {
    if (state.exited || chunk.length === 0) return;
    state.ring.push(chunk);
    for (let offset = 0; offset < chunk.length; offset += this.batchBytes) {
      const slice = chunk.subarray(offset, Math.min(offset + this.batchBytes, chunk.length));
      state.pending.push(slice);
      state.pendingBytes += slice.length;
      if (state.pendingBytes >= this.batchBytes) this.flush(state);
    }
    if (state.pendingBytes > 0) this.scheduleFlush(state);
  }

  private scheduleFlush(state: TerminalState): void {
    if (state.flushTimer !== null || state.exited) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      this.flush(state);
    }, this.batchMs);
  }

  private clearFlushTimer(state: TerminalState): void {
    if (state.flushTimer === null) return;
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }

  /**
   * Emits pending bytes, at most `batchBytes` per frame. Stops at the high-water
   * mark unless `force` (close/attach) so a flood is throttled by acks.
   */
  private flush(state: TerminalState, force = false): void {
    if (state.pendingBytes === 0) return;
    this.clearFlushTimer(state);
    while (state.pendingBytes > 0) {
      if (!force && state.unacked >= this.highWaterBytes) break;
      const bytes = this.takePending(state, this.batchBytes);
      if (bytes.length === 0) break;
      state.seq += 1;
      state.unacked += bytes.length;
      this.options.emit({
        event: "terminal.data",
        payload: {
          terminalId: state.info.id,
          seq: state.seq,
          data: bytesToBase64(bytes),
          bytes: bytes.length,
        },
      });
      if (state.unacked >= this.highWaterBytes && !state.paused) {
        state.paused = true;
        try {
          state.pty.pause();
        } catch {
          // A shell that exited mid-flood must not throw.
        }
      }
    }
    if (state.pendingBytes > 0 && !force && state.unacked < this.highWaterBytes) {
      this.scheduleFlush(state);
    }
  }

  private takePending(state: TerminalState, max: number): Uint8Array {
    const length = Math.min(state.pendingBytes, max);
    const out = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const first = state.pending[0];
      if (!first) break;
      const needed = length - written;
      if (first.length <= needed) {
        out.set(first, written);
        written += first.length;
        state.pending.shift();
      } else {
        out.set(first.subarray(0, needed), written);
        state.pending[0] = first.subarray(needed);
        written += needed;
      }
    }
    state.pendingBytes -= length;
    return out;
  }

  private handleExit(state: TerminalState, event: { exitCode: number; signal?: number }): void {
    if (state.exited) return;
    this.clearFlushTimer(state);
    if (state.forceTimer !== null) {
      clearTimeout(state.forceTimer);
      state.forceTimer = null;
    }
    // The shell's last words are still owed to the renderer.
    this.flush(state, true);
    this.finalizeExit(state, event.exitCode, event.signal);
    if (this.terminals.get(state.info.id) === state) this.terminals.delete(state.info.id);
  }

  private forceClose(state: TerminalState): void {
    if (state.exited) return;
    if (state.forceTimer !== null) {
      clearTimeout(state.forceTimer);
      state.forceTimer = null;
    }
    void this.options.treeKill.killTree(state.info.pid, "SIGKILL");
    try {
      state.pty.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    // Some PTY implementations never report an exit after a hard kill; the UI
    // must still leave "closing".
    this.finalizeExit(state, -1, 9);
  }

  private finalizeExit(state: TerminalState, exitCode: number, signal?: number): void {
    if (state.exited) return;
    state.exited = true;
    state.pending = [];
    state.pendingBytes = 0;
    state.detachExit();
    const payload: TerminalExitEvent = { terminalId: state.info.id, exitCode };
    if (signal !== undefined) payload.signal = signal;
    this.options.emit({ event: "terminal.exit", payload });
  }
}
