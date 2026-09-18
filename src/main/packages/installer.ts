/**
 * Package installation behind a port.
 *
 * The real implementation runs npm with the app's *bundled* Node runtime
 * (`node <npm-cli.js> install`) inside the Pi npm root; tests inject a fake.
 */

import type { CommandRunner } from "../office/exec";

export interface InstallResult {
  ok: boolean;
  code: number;
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  /** True when the Node/npm runtime could not be launched at all. */
  missingRuntime: boolean;
  durationMs: number;
}

export interface PackageInstaller {
  readonly description: string;
  installAll(root: string, options?: { timeoutMs?: number }): Promise<InstallResult>;
}

export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;
export const MAX_LOG_CHARS = 8_000;

export interface NpmPackageInstallerOptions {
  runner: CommandRunner;
  /** Bundled Node binary (used to run the npm CLI script). */
  nodePath: string;
  /** Path to npm's `npm-cli.js`. */
  npmCliPath: string;
  extraArgs?: readonly string[];
  timeoutMs?: number;
  now?: () => number;
}

export function createNpmPackageInstaller(options: NpmPackageInstallerOptions): PackageInstaller {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const args = [
    options.npmCliPath,
    "install",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    ...(options.extraArgs ?? []),
  ];

  return {
    description: `${options.nodePath} ${args.join(" ")}`,
    async installAll(root, installOptions) {
      const startedAt = now();
      const result = await options.runner.run(options.nodePath, args, {
        cwd: root,
        timeoutMs: installOptions?.timeoutMs ?? timeoutMs,
      });
      return {
        ok: result.code === 0 && !result.missing,
        code: result.code,
        command: result.command,
        args: [...result.args],
        cwd: root,
        stdout: result.stdout,
        stderr: result.stderr,
        missingRuntime: result.missing,
        durationMs: now() - startedAt,
      };
    },
  };
}

export function tailLog(text: string, maxChars = MAX_LOG_CHARS): string {
  if (text.length <= maxChars) return text;
  return `…(truncated)\n${text.slice(text.length - maxChars)}`;
}
