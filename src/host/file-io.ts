/**
 * Node adapters for the workspace file listing (plan step 7).
 *
 * This is the only place that touches `node:fs`/`node:child_process` for file
 * completion; `file-listing.ts` stays pure and testable against a fake tree, and
 * the session core only sees the `FileListingIo` port.
 */

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

import type { DirectoryEntry, FileListingIo } from "./file-listing";

export function createNodeFileListingIo(gitTimeoutMs = 4000): FileListingIo {
  return {
    async readDirectory(directory: string): Promise<DirectoryEntry[]> {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          // A symlink to a directory is not followed: realpath escapes are a
          // bigger question than completion needs to answer.
          directory: entry.isDirectory(),
        }));
      } catch {
        return [];
      }
    },

    async readTextFile(target: string): Promise<string | null> {
      try {
        return await readFile(target, "utf8");
      } catch {
        return null;
      }
    },

    async runGit(root: string, args: readonly string[]): Promise<string | null> {
      return new Promise<string | null>((resolve) => {
        let settled = false;
        const finish = (value: string | null) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        let child;
        try {
          child = spawn("git", [...args], { cwd: root, windowsHide: true });
        } catch {
          finish(null);
          return;
        }
        const timer = setTimeout(() => {
          child.kill();
          finish(null);
        }, gitTimeoutMs);
        let stdout = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.on("error", () => {
          clearTimeout(timer);
          finish(null);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          // A non-zero exit means "not a repository" or "no git": walk instead.
          finish(code === 0 ? stdout : null);
        });
      });
    },
  };
}
