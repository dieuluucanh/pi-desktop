/**
 * Node adapters for the workspace file listing (plan step 7).
 *
 * This is the only place that touches `node:fs` for file completion;
 * `file-listing.ts` stays pure and testable against a fake tree, and the session
 * core only sees the `FileListingIo` port. The `git` spawn itself lives in
 * `src/git/runner.ts`, because the source-control rail needs the same adapter.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { createNodeGitRunner } from "../git/runner";
import type { ModelsFileIo } from "./custom-providers";
import type { DirectoryEntry, FileListingIo } from "./file-listing";
import type { ProjectIo } from "./project-inspect";
import type { SettingsFileIo } from "./settings";
import type { WorkspaceFileIo } from "./workspace-files";

/**
 * Atomic, durable file write (plan step 27).
 *
 * The rename makes the *name* swap atomic, but the new file's bytes can still
 * be sitting in the page cache: a power loss after the rename can leave an
 * empty `settings.json`/`models.json` behind. `sync()` forces the contents out
 * before the rename, so the target is either the old file or the complete new
 * one. The temp file is removed on any failure so a refused write leaves no
 * debris in the shared profile.
 */
async function writeFileAtomic(target: string, text: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "w", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

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
      await writeFileAtomic(path, text);
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
      await writeFileAtomic(path, text);
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

/**
 * Runs `git` in `root` and resolves stdout, or null when it fails/does not exist.
 *
 * The spawn itself lives in `src/git/runner.ts` (the app has one git adapter, so
 * the completion listing, the project header and the source-control rail cannot
 * drift apart on flags, timeouts or "what counts as no git").
 */
async function runGitCommand(
  root: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  const result = await sharedGitRunner.run(root, args, { timeoutMs });
  if (result.missing || result.code !== 0) return null;
  return result.stdout;
}

/** One shared adapter: the spawn has no per-call state worth duplicating. */
const sharedGitRunner = createNodeGitRunner();

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
 * Node adapter for the workspace file handlers (plan step 23). Reads are bounded
 * (the frame protocol must never carry a whole disk), writes are atomic with a
 * `0600` mode, and `realpath` is what lets `path-guard.ts` refuse a symlink that
 * escapes the session folder.
 */
export function createNodeWorkspaceFileIo(): WorkspaceFileIo {
  return {
    async realpath(target: string): Promise<string | null> {
      try {
        return await realpath(target);
      } catch {
        return null;
      }
    },

    async statFile(target: string): Promise<{ size: number } | null> {
      try {
        const info = await stat(target);
        if (!info.isFile()) return null;
        return { size: info.size };
      } catch {
        return null;
      }
    },

    async readFile(
      target: string,
      maxBytes: number,
    ): Promise<{ text: string; truncated: boolean } | null> {
      const cap = Math.max(0, Math.floor(maxBytes));
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        handle = await open(target, "r");
        const info = await handle.stat();
        if (!info.isFile()) return null;
        const buffer = Buffer.alloc(cap + 1);
        const { bytesRead } = await handle.read(buffer, 0, cap + 1, 0);
        const truncated = bytesRead > cap;
        const text = buffer.subarray(0, Math.min(bytesRead, cap)).toString("utf8");
        // A truncation can cut a multi-byte character; drop the replacement
        // character rather than return a mangled tail.
        return { text: truncated ? text.replace(/\uFFFD+$/, "") : text, truncated };
      } catch {
        return null;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },

    async writeFile(target: string, text: string): Promise<void> {
      await writeFileAtomic(target, text);
    },
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
