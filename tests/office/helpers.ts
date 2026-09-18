import { readFileSync } from "node:fs";

import type { DetectDeps, DirectoryEntry, PathKind } from "../../src/main/office/detect";
import { createFakeCommandRunner, type CommandRunner, type FakeCommandSpec } from "../../src/main/office/exec";
import type { FsPort } from "../../src/main/fs-port";

const FIXTURES = new URL("../fixtures/", import.meta.url);

export function fixtureText(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

export interface MakeDepsOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string>;
  homedir?: string;
  /** path -> file contents */
  files?: Record<string, string>;
  /** directory -> file names */
  dirs?: Record<string, string[]>;
  /** explicit path kind overrides (directories that are not listed) */
  paths?: Record<string, PathKind>;
  commands?: readonly FakeCommandSpec[];
  /** Use a caller-provided runner (e.g. the stateful registry fake) instead of canned specs. */
  runner?: CommandRunner;
  now?: Date;
}

export interface MadeDeps {
  deps: DetectDeps;
  runner: CommandRunner;
}

export function makeDetectDeps(options: MakeDepsOptions = {}): MadeDeps {
  const files = options.files ?? {};
  const dirs = options.dirs ?? {};
  const paths = options.paths ?? {};
  const runner = options.runner ?? createFakeCommandRunner(options.commands ?? []);

  const deps: DetectDeps = {
    platform: options.platform ?? "win32",
    env: options.env ?? {},
    runner,
    homedir: options.homedir ?? "C:\\Users\\Test",
    async pathKind(target: string): Promise<PathKind | null> {
      const explicit = paths[target];
      if (explicit) return explicit;
      if (files[target] !== undefined) return "file";
      if (dirs[target] !== undefined) return "directory";
      return null;
    },
    async readFileText(target: string): Promise<string | null> {
      return files[target] ?? null;
    },
    async listDirectory(dir: string): Promise<DirectoryEntry[]> {
      return (dirs[dir] ?? []).map((name) => ({ name, kind: "file" as PathKind }));
    },
    now: () => options.now ?? new Date("2026-09-18T00:00:00.000Z"),
  };

  return { deps, runner };
}

/**
 * Builds detection deps that read through a real FsPort (the in-memory one in
 * tests), so read-after-write flows — sideload, then detect — are exercised for
 * real instead of over separate fake stores.
 */
export function detectDepsFromFsPort(
  fs: FsPort,
  options: {
    platform?: NodeJS.Platform;
    env?: Record<string, string>;
    homedir?: string;
    runner: CommandRunner;
    now?: Date;
  },
): DetectDeps {
  return {
    platform: options.platform ?? "win32",
    env: options.env ?? {},
    runner: options.runner,
    homedir: options.homedir ?? "C:\\Users\\Test",
    async pathKind(target) {
      return fs.pathKind(target);
    },
    async readFileText(target) {
      return fs.readTextFile(target);
    },
    async listDirectory(dir): Promise<DirectoryEntry[]> {
      const names = await fs.listDirectory(dir);
      return names.map((name) => ({ name, kind: "file" as PathKind }));
    },
    now: () => options.now ?? new Date("2026-09-18T00:00:00.000Z"),
  };
}
