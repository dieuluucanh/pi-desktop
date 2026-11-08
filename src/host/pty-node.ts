/**
 * The one place `node-pty` is imported (2026-11-05 native-terminal plan, step 4).
 *
 * `node-pty` 1.x is N-API, so its prebuilt binaries are ABI-stable across the
 * bundled Node 24 and Electron — no `electron-rebuild`, and no native code in
 * the main process. Only this host-side adapter touches it; the architecture
 * test `tests/architecture/node-pty-isolation.test.ts` enforces that.
 *
 * The import is **dynamic and injected**: a package whose native module cannot
 * load must not take the whole host process down at module evaluation (the
 * 0.8.0 Linux package did exactly that, and Node exits 1 before the first
 * request can be answered). `loadNodePty` never rejects; on failure it probes
 * every path node-pty would try and keeps the real loader error for each one,
 * because node-pty's message only reports the **last** candidate.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { TerminalNativeCandidate } from "../shared/terminal-protocol";
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
export interface NodePtyProcess {
  readonly pid: number;
  onData(listener: (data: string | Uint8Array) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

/** The slice of `node-pty` this adapter consumes; tests inject a fake. */
export interface NodePtyModule {
  spawn(shell: string, args: string[], options: NodePtySpawnOptions): NodePtyProcess;
}

interface NodePtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  encoding: null;
}

/** A load attempt's outcome. Failure is a value, never a rejection. */
export type NodePtyLoad =
  | {
      ok: true;
      port: PtyPort;
      /** The candidate that resolved, when the package could be located. */
      path: string | null;
      candidates: TerminalNativeCandidate[];
    }
  | {
      ok: false;
      /** The first non-`ENOENT` loader error, or the import failure itself. */
      error: string;
      candidates: TerminalNativeCandidate[];
    };

export interface NodePtyLoadOptions {
  platform?: string;
  arch?: string;
  /** Test seam: the package root containing `lib/`, `build/` and `prebuilds/`. */
  moduleDir?: string;
  /** Test seam: defaults to `import("node-pty")`. */
  importer?: () => Promise<unknown>;
}

/** One encoder for the whole adapter; Windows always hands back a string. */
const utf8 = new TextEncoder();
const requireFromHere = createRequire(import.meta.url);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The paths node-pty's own `loadNativeModule` checks, in its order. */
export function nativeCandidatePaths(moduleDir: string, platform: string, arch: string): string[] {
  return [
    join(moduleDir, "build", "Release", "pty.node"),
    join(moduleDir, "build", "Debug", "pty.node"),
    join(moduleDir, "prebuilds", `${platform}-${arch}`, "pty.node"),
  ];
}

/**
 * `require.resolve` proves a path exists without touching the filesystem port;
 * it throws the standard MODULE_NOT_FOUND for an absent file.
 */
function resolveCandidate(path: string): boolean {
  try {
    requireFromHere.resolve(path);
    return true;
  } catch {
    return false;
  }
}

function probeCandidates(paths: string[]): TerminalNativeCandidate[] {
  return paths.map((path) => {
    try {
      requireFromHere(path);
      return { path, error: null };
    } catch (error) {
      return { path, error: errorText(error) };
    }
  });
}

const MISSING_MODULE = /MODULE_NOT_FOUND|Cannot find module/i;

/**
 * Picks the headline error for a failed load. `ENOENT` candidates are expected
 * on a package that ships one binary; the first real dlopen error (e.g.
 * "version `GLIBC_2.42' not found") is the one a user or a bug report needs.
 */
export function summarizeNativeFailure(
  candidates: readonly TerminalNativeCandidate[],
  fallback: string,
): string {
  const real = candidates.find(
    (candidate) => candidate.error && !MISSING_MODULE.test(candidate.error),
  );
  return real?.error ?? fallback;
}

/** The installed package root, or null when the package cannot be resolved. */
function installedModuleDir(): string | null {
  try {
    return dirname(dirname(requireFromHere.resolve("node-pty")));
  } catch {
    return null;
  }
}

function spawnWithNodePty(module: NodePtyModule, input: PtySpawnInput): PtyProcess {
  const pty = module.spawn(input.shell, input.args, {
    name: input.name,
    cols: input.cols,
    rows: input.rows,
    cwd: input.cwd,
    env: input.env,
    // Raw bytes: xterm owns the UTF-8 decoder, so a multi-byte character split
    // across two chunks is not corrupted at this boundary.
    encoding: null,
  });

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

function asModule(value: unknown): NodePtyModule {
  const module = value as Partial<NodePtyModule> | null | undefined;
  if (typeof module?.spawn !== "function") {
    throw new Error("node-pty did not export spawn()");
  }
  return module as NodePtyModule;
}

/**
 * Loads `node-pty` without ever throwing. On success the port is ready; on
 * failure the caller runs a host that answers `terminal.info` and returns a
 * typed `native_unavailable` error for `terminal.open` instead of dying.
 */
export async function loadNodePty(options: NodePtyLoadOptions = {}): Promise<NodePtyLoad> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const moduleDir = options.moduleDir ?? installedModuleDir();
  const paths = moduleDir ? nativeCandidatePaths(moduleDir, platform, arch) : [];
  const importer = options.importer ?? (() => import("node-pty"));

  try {
    const module = asModule(await importer());
    const path = paths.find((candidate) => resolveCandidate(candidate)) ?? null;
    return {
      ok: true,
      port: { spawn: (input) => spawnWithNodePty(module, input) },
      path,
      candidates: [],
    };
  } catch (error) {
    const candidates = probeCandidates(paths);
    return {
      ok: false,
      error: summarizeNativeFailure(candidates, errorText(error)),
      candidates,
    };
  }
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
