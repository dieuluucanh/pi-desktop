/**
 * The git runner (git-checkpoint plan step 2).
 *
 * One injected port for every git invocation in the app, so the engine stays
 * unit-testable with a fake and the Node adapter is the only place that spawns
 * a process. It exists because two writers already needed the same thing and
 * neither had it:
 *
 *  - `src/host/file-io.ts` spawned `git` inline for `ls-files` and
 *    `rev-parse` (no stdin, no env, no duration);
 *  - `src/main/office/exec.ts` ran `execFile` for Office detection and clones
 *    (no stdin either, so `commit -F -` was impossible).
 *
 * The defaults here are chosen for an interactive UI, not for scripting:
 * `windowsHide`, a bounded buffer, a hard timeout, and `stdin` support so a
 * commit message or a patch never has to survive shell quoting.
 */

import { spawn } from "node:child_process";

/** One git invocation's outcome. Never throws: a failure is a value. */
export interface GitResult {
  /**
   * The argv the *caller* asked for, without {@link BASE_GIT_ARGS}. Recorded by
   * both the Node adapter and the fake so a test can assert one shape for both;
   * the prepended base flags are an implementation detail of the adapter.
   */
  args: readonly string[];
  /** Working directory the command ran in. */
  cwd: string;
  /** Exit code; 127 when the executable could not be started. */
  code: number;
  stdout: string;
  stderr: string;
  /** True when the `git` executable itself was unavailable (ENOENT). */
  missing: boolean;
  /** True when the timeout aborted the command. */
  timedOut: boolean;
  /** Wall-clock milliseconds. */
  durationMs: number;
}

export interface GitRunOptions {
  /** Text written to the child's stdin, then the stream is closed. */
  input?: string;
  /** Extra environment; merged over the process env (never replacing PATH). */
  env?: Record<string, string | undefined>;
  /** Hard timeout. Default {@link DEFAULT_GIT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface GitRunner {
  run(root: string, args: readonly string[], options?: GitRunOptions): Promise<GitResult>;
}

/** Read-only queries are capped tight; a slow repo must not freeze the rail. */
export const GIT_STATUS_TIMEOUT_MS = 2_000;
/** Local writes (add, commit, checkout) are allowed a little longer. */
export const GIT_WRITE_TIMEOUT_MS = 10_000;
/** Network operations get the longest budget, but still a budget. */
export const GIT_NETWORK_TIMEOUT_MS = 120_000;
export const DEFAULT_GIT_TIMEOUT_MS = GIT_WRITE_TIMEOUT_MS;

/** 16 MB: a large `git log -p` is bounded by the caller, not by the pipe. */
export const MAX_GIT_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Flags every invocation gets, so the app is not at the mercy of the user's
 * environment:
 *
 *  - `--no-optional-locks` stops a background `git status` from writing an
 *    index the user's own terminal may be holding;
 *  - `core.quotepath=false` keeps unicode paths readable in output (the NUL
 *    parsers do not need it, but the human-readable ones do);
 *  - `color.ui=false` keeps ANSI out of every diff and log;
 *  - `advice.*=false` keeps git's coaching out of the failure classifier.
 */
export const BASE_GIT_ARGS: readonly string[] = [
  "--no-optional-locks",
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=false",
  "-c",
  "advice.detachedHead=false",
  "-c",
  "advice.statusHints=false",
] as const;

/**
 * Environment for every invocation:
 *
 *  - `GIT_TERMINAL_PROMPT=0` makes an auth failure an error instead of a hang
 *    (the plan's D12: authentication is delegated, never prompted in-app);
 *  - `GIT_OPTIONAL_LOCKS=0` mirrors `--no-optional-locks` for the older code
 *    paths that ignore the flag;
 *  - `GIT_EDITOR=:` / `GIT_SEQUENCE_EDITOR=:` make any command that would open
 *    an editor fail immediately rather than block forever;
 *  - `LC_ALL=C` keeps git's own messages in the English forms the failure
 *    classifier matches, whatever the user's locale.
 */
export const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_EDITOR: ":",
  GIT_SEQUENCE_EDITOR: ":",
  GIT_PAGER: "cat",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  LC_ALL: "C",
} as const;

/** Resolves the result exactly once; never rejects. */
function finish(
  timer: ReturnType<typeof setTimeout> | null,
  state: { stdout: string; stderr: string; timedOut: boolean; missing: boolean },
  root: string,
  args: readonly string[],
  startedAt: number,
  code: number,
  resolve: (result: GitResult) => void,
): void {
  if (timer) clearTimeout(timer);
  resolve({
    args: [...args],
    cwd: root,
    code: state.missing ? 127 : code,
    stdout: state.stdout,
    stderr: state.stderr,
    missing: state.missing,
    timedOut: state.timedOut,
    durationMs: Math.max(0, Date.now() - startedAt),
  });
}

export interface NodeGitRunnerOptions {
  /** Executable to spawn; `git` by default (tests pass a shim or a fake path). */
  executable?: string;
  /** Injected clock, for deterministic duration assertions. */
  now?: () => number;
  /** Max bytes kept from each stream; the excess is dropped and flagged. */
  maxBufferBytes?: number;
  /**
   * Flags prepended to every argv. Defaults to {@link BASE_GIT_ARGS}; tests that
   * drive the adapter with a non-git executable pass `[]`.
   */
  baseArgs?: readonly string[];
}

/**
 * The only module in the app that spawns `git`. Errors are values: a missing
 * binary, a timeout and a non-zero exit are all resolved results, so callers
 * never need a try/catch around a read.
 */
export function createNodeGitRunner(options: NodeGitRunnerOptions = {}): GitRunner {
  const executable = options.executable ?? "git";
  const now = options.now ?? ((): number => Date.now());
  const maxBuffer = options.maxBufferBytes ?? MAX_GIT_BUFFER_BYTES;
  const baseArgs = options.baseArgs ?? BASE_GIT_ARGS;

  return {
    run(root, args, runOptions = {}) {
      return new Promise<GitResult>((resolve) => {
        const startedAt = now();
        const timeoutMs = runOptions.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
        const state = { stdout: "", stderr: "", timedOut: false, missing: false };
        let child: ReturnType<typeof spawn> | null = null;
        try {
          child = spawn(executable, [...baseArgs, ...args], {
            cwd: root,
            windowsHide: true,
            env: { ...process.env, ...GIT_ENV, ...(runOptions.env ?? {}) },
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          // A synchronous spawn failure (an unusable executable path) is the
          // same outcome as ENOENT: report it as a missing binary and stop.
          resolve({
            args: [...args],
            cwd: root,
            code: 127,
            stdout: "",
            stderr: "failed to spawn git",
            missing: true,
            timedOut: false,
            durationMs: Math.max(0, now() - startedAt),
          });
          return;
        }

        const append = (target: "stdout" | "stderr", chunk: string): void => {
          const next = state[target] + chunk;
          // Keep the *tail* on overflow: a patch's useful part is at the end of
          // a truncated stream less often than a log's, but dropping the head of
          // a stack trace is worse than dropping its middle. The cap is a
          // backstop; the engine also bounds what it asks for.
          state[target] = next.length > maxBuffer ? next.slice(next.length - maxBuffer) : next;
        };

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => append("stdout", chunk));
        child.stderr?.on("data", (chunk: string) => append("stderr", chunk));

        const timer = setTimeout(() => {
          state.timedOut = true;
          try {
            child.kill();
          } catch {
            // The process is already gone; `close` will follow.
          }
        }, timeoutMs);

        child.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") state.missing = true;
          finish(timer, state, root, args, startedAt, 127, resolve);
        });

        child.on("close", (code) => {
          finish(timer, state, root, args, startedAt, code ?? 1, resolve);
        });

        if (runOptions.input !== undefined) {
          child.stdin?.on("error", () => undefined);
          child.stdin?.end(runOptions.input, "utf8");
        } else {
          child.stdin?.end();
        }
      });
    },
  };
}

/* ------------------------------------------------------------------- fake */

export interface FakeGitSpec {
  /** Args that must appear, in order, from the start of the argv. */
  args?: readonly string[];
  /** Exact args match instead of a prefix match. */
  exact?: boolean;
  /** Matches when the cwd ends with this segment (per-repo fakes). */
  cwdSuffix?: string;
  stdout?: string;
  stderr?: string;
  code?: number;
  missing?: boolean;
  timedOut?: boolean;
}

export interface FakeGitCall {
  root: string;
  args: readonly string[];
  input?: string;
  env?: Record<string, string | undefined>;
}

/**
 * A scripted runner for tests. Specs are matched in order, so a test can put a
 * specific case before a catch-all. An unmatched call fails loudly as a
 * missing spec, which is how a test notices it forgot a command.
 */
export function createFakeGitRunner(specs: readonly FakeGitSpec[]): GitRunner & {
  calls: FakeGitCall[];
} {
  const calls: FakeGitCall[] = [];

  return {
    calls,
    run(root, args, options = {}) {
      calls.push({
        root,
        args: [...args],
        ...(options.input === undefined ? {} : { input: options.input }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      const spec = specs.find((candidate) => {
        if (candidate.cwdSuffix !== undefined && !root.endsWith(candidate.cwdSuffix)) return false;
        const expected = candidate.args ?? [];
        if (candidate.exact) {
          return expected.length === args.length && expected.every((a, i) => a === args[i]);
        }
        return expected.every((a, i) => args[i] === a);
      });
      if (!spec) {
        return Promise.resolve({
          args: [...args],
          cwd: root,
          code: 127,
          stdout: "",
          stderr: `no fake git spec for: git ${args.join(" ")}`,
          missing: true,
          timedOut: false,
          durationMs: 0,
        });
      }
      return Promise.resolve({
        args: [...args],
        cwd: root,
        code: spec.code ?? 0,
        stdout: spec.stdout ?? "",
        stderr: spec.stderr ?? "",
        missing: spec.missing ?? false,
        timedOut: spec.timedOut ?? false,
        durationMs: 0,
      });
    },
  };
}
