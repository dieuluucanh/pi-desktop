/**
 * Injectable command runner.
 *
 * All OS probing goes through this interface so detection/sideload logic is
 * unit-testable on any platform (tests inject a fake runner) and so the app can
 * surface captured stdout/stderr in the diagnostics panel.
 */

import { execFile } from "node:child_process";

export interface CommandResult {
  command: string;
  args: readonly string[];
  cwd?: string;
  code: number;
  stdout: string;
  stderr: string;
  /** True when the executable itself could not be launched (ENOENT). */
  missing: boolean;
}

export interface CommandOptions {
  timeoutMs?: number;
  cwd?: string;
}

export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function exitCodeOf(error: unknown): { code: number; missing: boolean } {
  if (!error) return { code: 0, missing: false };
  const raw = (error as { code?: unknown }).code;
  if (typeof raw === "number") return { code: raw, missing: false };
  if (raw === "ENOENT") return { code: 127, missing: true };
  return { code: 1, missing: false };
}

export function createCommandRunner(): CommandRunner {
  return {
    run(command, args, options) {
      return new Promise<CommandResult>((resolve) => {
        execFile(
          command,
          [...args],
          {
            timeout: options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: MAX_BUFFER_BYTES,
            encoding: "utf8",
            ...(options?.cwd ? { cwd: options.cwd } : {}),
          },
          (error, stdout, stderr) => {
            const { code, missing } = exitCodeOf(error);
            const result: CommandResult = {
              command,
              args: [...args],
              code,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              missing,
            };
            if (options?.cwd) result.cwd = options.cwd;
            resolve(result);
          },
        );
      });
    },
  };
}

/** Runner used by tests: matches commands by prefix and returns canned output. */
export interface FakeCommandSpec {
  command: string;
  /** Every arg in `args` must be present, in order (prefix match when `exact` is false). */
  args?: readonly string[];
  exact?: boolean;
  stdout?: string;
  stderr?: string;
  code?: number;
  missing?: boolean;
}

export function createFakeCommandRunner(
  specs: readonly FakeCommandSpec[],
): CommandRunner & {
  calls: Array<{ command: string; args: readonly string[]; cwd?: string }>;
} {
  const calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];

  function matches(spec: FakeCommandSpec, command: string, args: readonly string[]): boolean {
    if (spec.command !== command) return false;
    const expected = spec.args ?? [];
    if (spec.exact) {
      return expected.length === args.length && expected.every((a, i) => a === args[i]);
    }
    return expected.every((a, i) => args[i] === a);
  }

  return {
    calls,
    run(command, args, options) {
      calls.push({ command, args: [...args], ...(options?.cwd ? { cwd: options.cwd } : {}) });
      const spec = specs.find((candidate) => matches(candidate, command, args));
      if (!spec) {
        return Promise.resolve({
          command,
          args: [...args],
          code: 127,
          stdout: "",
          stderr: `no fake spec for ${command} ${args.join(" ")}`,
          missing: true,
          ...(options?.cwd ? { cwd: options.cwd } : {}),
        });
      }
      return Promise.resolve({
        command,
        args: [...args],
        code: spec.code ?? 0,
        stdout: spec.stdout ?? "",
        stderr: spec.stderr ?? "",
        missing: spec.missing ?? false,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
      });
    },
  };
}
