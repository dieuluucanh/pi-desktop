/**
 * The one place `node-pty` is imported (2026-11-05 native-terminal plan, step 4).
 *
 * `node-pty` 1.x is N-API, so its prebuilt binaries are ABI-stable across the
 * bundled Node 24 and Electron — no `electron-rebuild`, and no native code in
 * the main process. Only this host-side adapter touches it; the architecture
 * test `tests/architecture/node-pty-isolation.test.ts` enforces that.
 */

import { spawnSync } from "node:child_process";
import { spawn } from "node-pty";
import type {
  PtyPort,
  PtyProcess,
  PtySpawnInput,
  TerminalKillSignal,
  TreeKillPort,
} from "./terminal-core";

/**
 * `node-pty`'s typings always say `onData: IEvent<string>`, but `encoding: null`
 * makes it deliver raw `Buffer`s. This structural shape describes what actually
 * happens, so the cast below is the only place the mismatch is acknowledged.
 */
interface RawPty {
  readonly pid: number;
  onData(listener: (data: string | Uint8Array) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

/** One encoder for the whole adapter; Windows always hands back a string. */
const utf8 = new TextEncoder();

function spawnWithNodePty(input: PtySpawnInput): PtyProcess {
  const spawned = spawn(input.shell, input.args, {
    name: input.name,
    cols: input.cols,
    rows: input.rows,
    cwd: input.cwd,
    env: input.env,
    // Raw bytes: xterm owns the UTF-8 decoder, so a multi-byte character split
    // across two chunks is not corrupted at this boundary.
    encoding: null,
  });
  // SAFETY: `encoding: null` makes node-pty deliver raw `Buffer`s (a Uint8Array)
  // even though its typings declare `onData: IEvent<string>`; every other member
  // of `RawPty` matches the runtime `IPty` shape exactly. This is the only cast
  // between the two, and it stays contained to this adapter.
  const raw: unknown = spawned;
  const pty = raw as RawPty;

  return {
    pid: pty.pid,
    onData: (listener) => {
      const disposable = pty.onData((data) => {
        // Unix delivers a Buffer with `encoding: null`; Windows ConPTY always
        // delivers a decoded string (node-pty warns that encoding is ignored
        // there). Normalise once, at the port boundary.
        listener(typeof data === "string" ? utf8.encode(data) : data);
      });
      return () => disposable.dispose();
    },
    onExit: (listener) => {
      const disposable = pty.onExit((event) => listener(event));
      return () => disposable.dispose();
    },
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    pause: () => pty.pause(),
    resume: () => pty.resume(),
    kill: (signal) => {
      // node-pty's Windows implementation throws when a signal is passed
      // ("Signals not supported on windows"); the tree kill handles those.
      if (process.platform === "win32") {
        pty.kill();
        return;
      }
      pty.kill(signal);
    },
  };
}

export function createNodePtyPort(): PtyPort {
  return { spawn: spawnWithNodePty };
}

/**
 * Kills the shell's descendants, which `node-pty` itself does not do:
 * `UnixTerminal.kill()` signals only the shell pid. On POSIX node-pty starts the
 * child as a session leader, so `-pid` is the whole process group. Windows has no
 * signal for this, so `taskkill /T /F` is the reliable tree kill; it is
 * synchronous on purpose, because a half-killed dev server is worse than a ~30 ms
 * block during close/quit.
 */
export function createNodeTreeKill(): TreeKillPort {
  return {
    killTree(pid: number, signal: TerminalKillSignal) {
      if (!Number.isInteger(pid) || pid <= 0) return;
      if (process.platform === "win32") {
        try {
          spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          // taskkill is part of Windows; a failure means the tree is already gone.
        }
        return;
      }
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Not a process-group leader (or the group is gone); fall back to the pid.
      }
      try {
        process.kill(pid, signal);
      } catch {
        // Already exited.
      }
    },
  };
}
