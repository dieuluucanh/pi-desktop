/**
 * Fake PTY for `tests/host/terminal-core.test.ts`.
 *
 * It records everything the core does to a shell and lets a test script data,
 * exits and spawn failures. No native module, no real process, no platform
 * dependency — the same pattern as the fake host process in
 * `tests/main/host-supervisor.test.ts`.
 */

import type {
  PtyPort,
  PtyProcess,
  PtySpawnInput,
  TerminalKillSignal,
  TreeKillPort,
} from "../../../src/host/terminal-core";

type DataListener = (data: Uint8Array) => void;
type ExitListener = (event: { exitCode: number; signal?: number }) => void;

export interface FakePtyProcess extends PtyProcess {
  readonly input: PtySpawnInput;
  readonly writes: string[];
  readonly resizes: Array<[number, number]>;
  readonly kills: string[];
  pauseCount: number;
  resumeCount: number;
  readonly paused: boolean;
  emitData(chunk: Uint8Array | string): void;
  emitExit(exitCode?: number, signal?: number): void;
  readonly listenerCounts: { data: number; exit: number };
}

class FakeProcess implements FakePtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  readonly kills: string[] = [];
  pauseCount = 0;
  resumeCount = 0;
  private pausedState = false;
  private exited = false;
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();

  constructor(
    readonly pid: number,
    readonly input: PtySpawnInput,
    private readonly exitOnKill: boolean,
  ) {}

  get paused(): boolean {
    return this.pausedState;
  }

  get listenerCounts(): { data: number; exit: number } {
    return { data: this.dataListeners.size, exit: this.exitListeners.size };
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  pause(): void {
    this.pauseCount += 1;
    this.pausedState = true;
  }

  resume(): void {
    this.resumeCount += 1;
    this.pausedState = false;
  }

  kill(signal = "SIGHUP"): void {
    this.kills.push(signal);
    if (this.exitOnKill && !this.exited) this.emitExit(0, 15);
  }

  emitData(chunk: Uint8Array | string): void {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    for (const listener of [...this.dataListeners]) listener(bytes);
  }

  emitExit(exitCode = 0, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.exitListeners]) listener({ exitCode, signal });
    this.exitListeners.clear();
    this.dataListeners.clear();
  }
}

export interface FakePtyPort extends PtyPort {
  readonly processes: FakePtyProcess[];
  readonly inputs: PtySpawnInput[];
  /** Scripts the next spawn failure. */
  failNext: Error | null;
  exitOnKill: boolean;
}

export function createFakePtyPort(options: { exitOnKill?: boolean } = {}): FakePtyPort {
  const processes: FakePtyProcess[] = [];
  const inputs: PtySpawnInput[] = [];
  let nextPid = 100;
  return {
    processes,
    inputs,
    failNext: null,
    exitOnKill: options.exitOnKill ?? false,
    spawn(input) {
      if (this.failNext) {
        const error = this.failNext;
        this.failNext = null;
        throw error;
      }
      inputs.push(input);
      const process = new FakeProcess(nextPid, input, this.exitOnKill);
      nextPid += 1;
      processes.push(process);
      return process;
    },
  };
}

export interface FakeTreeKill extends TreeKillPort {
  readonly calls: Array<{ pid: number; signal: TerminalKillSignal }>;
}

export function createFakeTreeKill(): FakeTreeKill {
  const calls: Array<{ pid: number; signal: TerminalKillSignal }> = [];
  return {
    calls,
    killTree(pid, signal) {
      calls.push({ pid, signal });
    },
  };
}
