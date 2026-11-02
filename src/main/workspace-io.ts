/**
 * Node adapters for the workspace service.
 *
 * This is the only module in the editor path that touches `node:fs` or spawns
 * `git`. The service (`workspace-service.ts`) is port-injected and unit-tested
 * with a fake; Electron stays in `src/main/index.ts` and is supplied as the
 * `reveal` port.
 */

import { mkdir, open, readFile, readdir, realpath, rm, stat, lstat } from "node:fs/promises";

import { createNodeGitRunner } from "../git/runner";
import type { TreeDirectoryEntry, TreeStat, WorkspaceTreeIo } from "../workspace/tree";
import { writeFileAtomic } from "../workspace/atomic";
import type { FileContentIo } from "../workspace/file-content";

export interface WorkspaceNodeIo extends WorkspaceTreeIo, FileContentIo {
  remove(target: string): Promise<boolean>;
  ensureDir(target: string): Promise<void>;
  /** Base names in a directory; empty when it is missing. */
  listDirectoryNames(target: string): Promise<string[]>;
  runGit(root: string, args: readonly string[]): Promise<string | null>;
}

const GIT_TIMEOUT_MS = 4_000;
const MAX_READ_BYTES = 8_000_000;

export function createNodeWorkspaceIo(): WorkspaceNodeIo {
  const git = createNodeGitRunner();

  return {
    async realpath(target) {
      try {
        return await realpath(target);
      } catch {
        return null;
      }
    },

    async readDirectory(directory): Promise<TreeDirectoryEntry[]> {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          directory: entry.isDirectory(),
          symlink: entry.isSymbolicLink(),
        }));
      } catch {
        return [];
      }
    },

    async stat(target): Promise<TreeStat | null> {
      try {
        const link = await lstat(target);
        const symlink = link.isSymbolicLink();
        const info = symlink ? await stat(target) : link;
        if (info.isDirectory()) {
          return { kind: "directory", size: 0, mtimeMs: info.mtimeMs, symlink };
        }
        if (info.isFile()) {
          return { kind: "file", size: info.size, mtimeMs: info.mtimeMs, symlink };
        }
        return null;
      } catch {
        return null;
      }
    },

    async statFile(target) {
      try {
        const info = await stat(target);
        if (info.isDirectory()) {
          return { kind: "directory", size: 0, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 };
        }
        if (!info.isFile()) return null;
        return { kind: "file", size: info.size, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 };
      } catch {
        return null;
      }
    },

    async readBytes(target, maxBytes) {
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        handle = await open(target, "r");
        const info = await handle.stat();
        if (!info.isFile()) return null;
        const cap = Math.max(0, Math.floor(Math.min(maxBytes, MAX_READ_BYTES)));
        const buffer = Buffer.alloc(cap + 1);
        const { bytesRead } = await handle.read(buffer, 0, cap + 1, 0);
        return {
          bytes: buffer.subarray(0, Math.min(bytesRead, cap)),
          truncated: bytesRead > cap,
        };
      } catch {
        return null;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },

    async readTextFile(target) {
      try {
        return await readFile(target, "utf8");
      } catch {
        return null;
      }
    },

    async writeAtomic(target, text, mode) {
      await writeFileAtomic(target, text, mode === undefined ? {} : { mode });
    },

    async remove(target) {
      try {
        await rm(target, { force: true });
        return true;
      } catch {
        return false;
      }
    },

    async ensureDir(target) {
      await mkdir(target, { recursive: true });
    },

    async listDirectoryNames(target) {
      try {
        return await readdir(target);
      } catch {
        return [];
      }
    },

    async runGit(root, args) {
      const result = await git.run(root, args, { timeoutMs: GIT_TIMEOUT_MS });
      if (result.missing || result.code !== 0) return null;
      return result.stdout;
    },

    async checkIgnored(root, relativePaths) {
      if (relativePaths.length === 0) return new Set<string>();
      const result = await git.run(root, ["check-ignore", "--stdin", "-z"], {
        input: `${relativePaths.join("\0")}\0`,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (result.missing || result.code > 1) return null;
      if (result.code === 1) return new Set<string>();
      return new Set(
        result.stdout
          .split("\0")
          .map((entry) => entry.replace(/\\/g, "/").trim())
          .filter((entry) => entry.length > 0),
      );
    },
  };
}
