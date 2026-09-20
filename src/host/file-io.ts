/**
 * Node adapters for the workspace file listing (plan step 7).
 *
 * This is the only place that touches `node:fs`/`node:child_process` for file
 * completion; `file-listing.ts` stays pure and testable against a fake tree, and
 * the session core only sees the `FileListingIo` port.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ModelsFileIo } from "./custom-providers";
import type { DirectoryEntry, FileListingIo } from "./file-listing";
import type { ProjectIo } from "./project-inspect";
import type { SettingsFileIo } from "./settings";

/**
 * Atomic `models.json` access (plan step 9, slice 5). A temp file in the same
 * directory is renamed over the target, so a crashed write can never leave a
 * half-written credential file behind. The profile directory is created first
 * (a fresh profile has none).
 */
export function createNodeModelsFileIo(): ModelsFileIo {
  return {
    async read(path: string): Promise<string | null> {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },

    async write(path: string, text: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },

    async delete(path: string): Promise<void> {
      await unlink(path).catch(() => undefined);
    },
  };
}

/**
 * Atomic `settings.json` access (plan step 12). Same temp-file + rename rule as
 * `models.json`: a crashed write can never truncate the shared profile's
 * settings, and `stat` gives the renderer the mtime it needs to notice that
 * terminal Pi edited the same file.
 */
export function createNodeSettingsFileIo(): SettingsFileIo {
  return {
    async read(path: string): Promise<string | null> {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },

    async write(path: string, text: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },

    async delete(path: string): Promise<void> {
      await unlink(path).catch(() => undefined);
    },

    async stat(path: string): Promise<{ mtimeMs: number; size: number } | null> {
      try {
        const info = await stat(path);
        if (!info.isFile()) return null;
        return { mtimeMs: info.mtimeMs, size: info.size };
      } catch {
        return null;
      }
    },
  };
}

/** Runs `git` in `root` and resolves stdout, or null when it fails/does not exist. */
function runGitCommand(
  root: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
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
    }, timeoutMs);
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
      // A non-zero exit means "not a repository" or "no git".
      finish(code === 0 ? stdout : null);
    });
  });
}

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

    runGit: (root: string, args: readonly string[]) => runGitCommand(root, args, gitTimeoutMs),
  };
}

/**
 * Node adapter for project inspection (plan step 10): a path-kind probe plus the
 * same `git` runner the file listing uses, so both agree on what "no git" means.
 */
export function createNodeProjectIo(gitTimeoutMs = 4000): ProjectIo {
  return {
    async pathKind(target: string): Promise<"file" | "directory" | null> {
      try {
        const info = await stat(target);
        if (info.isDirectory()) return "directory";
        if (info.isFile()) return "file";
        return null;
      } catch {
        return null;
      }
    },
    runGit: (root: string, args: readonly string[]) => runGitCommand(root, args, gitTimeoutMs),
  };
}
