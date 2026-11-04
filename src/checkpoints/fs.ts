/**
 * The Node adapters for the checkpoint engine (git-checkpoint plan steps 20/23).
 *
 * Everything in `src/checkpoints/**` takes its filesystem as an injected port
 * (AGENTS rule 2), so the engine itself is testable with an in-memory tree. This
 * module is the one place that touches `node:fs` — main uses it today, and the
 * bundled Pi extension uses the very same function, which is why it lives here
 * rather than in `src/main/`.
 *
 * Two behaviours are deliberate:
 *
 *  - **Bounded walks.** Both `directorySize` and `fingerprint` stop after a file
 *    budget, because they run on a timer against a folder the user chose and a
 *    symlink loop or a `node_modules` with 200k files must not stall the app.
 *  - **No throwing.** A permission error on one file is reported as "missing",
 *    never as a failed snapshot: an Office document someone has open is the
 *    normal case, not an exception (R4).
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CheckpointFs } from "./store";

/** How many entries a usage/fingerprint walk visits before it gives up. */
export const MAX_WALK_ENTRIES = 20_000;

export interface NodeCheckpointFs extends CheckpointFs {
  /** Directory names inside `target` (empty when missing). Used by the 30-day sweep. */
  listDirs(target: string): Promise<string[]>;
}

export function createNodeCheckpointFs(): NodeCheckpointFs {
  return {
    async pathKind(target) {
      try {
        const info = await stat(target);
        if (info.isDirectory()) return "directory";
        if (info.isFile()) return "file";
        return null;
      } catch {
        return null;
      }
    },

    async readTextFile(target) {
      try {
        return await readFile(target, "utf8");
      } catch {
        return null;
      }
    },

    async writeTextFile(target, text) {
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, text, "utf8");
    },

    async ensureDir(target) {
      await mkdir(target, { recursive: true });
    },

    async size(target) {
      try {
        return (await stat(target)).size;
      } catch {
        return null;
      }
    },

    async directorySize(target) {
      let total = 0;
      let visited = 0;
      const walk = async (dir: string): Promise<void> => {
        if (visited >= MAX_WALK_ENTRIES) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (visited >= MAX_WALK_ENTRIES) return;
          visited += 1;
          const child = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(child);
          } else if (entry.isFile()) {
            try {
              total += (await stat(child)).size;
            } catch {
              // A vanished temp file is not a failure of the report.
            }
          }
        }
      };
      await walk(target);
      return total;
    },

    async removeTree(target) {
      try {
        await rm(target, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    },

    async listDirs(target) {
      try {
        const entries = await readdir(target, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        return [];
      }
    },
  };
}

export interface NodeCheckpointFsExtra extends NodeCheckpointFs {
  /** Atomic replace, for the projected config file (step 19). */
  rename(from: string, to: string): Promise<void>;
  chmod(target: string, mode: number): Promise<void>;
}

/**
 * The same port plus the two calls the config projection needs. Kept as a
 * separate factory so `CheckpointFs` stays the small surface the engine requires
 * and a test double does not have to implement `rename`/`chmod`.
 */
export function createNodeCheckpointConfigFs(): NodeCheckpointFsExtra {
  const base = createNodeCheckpointFs();
  return {
    ...base,
    async rename(from, to) {
      await rename(from, to);
    },
    async chmod(target, mode) {
      const { chmod } = await import("node:fs/promises");
      await chmod(target, mode);
    },
  };
}

/**
 * A cheap "has this folder moved?" signature for the idle scan (D15).
 *
 * Not a hash of the content: a stat of at most {@link MAX_WALK_ENTRIES} entries
 * is enough to notice that a document was saved, and it costs milliseconds
 * instead of hashing a 40 MB `.docx` every five minutes. The result is
 * `<count>-<maxMtime>-<totalBytes>`.
 *
 * `exclude` mirrors the shadow repo's ignore rules, so a churning `node_modules`
 * or an Office lock file cannot make the folder look permanently changed.
 */
export function createNodeFingerprint(
  options: { exclude?: readonly string[]; maxEntries?: number } = {},
): (projectPath: string) => Promise<string> {
  const maxEntries = options.maxEntries ?? MAX_WALK_ENTRIES;
  const skippedDirs = new Set(
    (options.exclude ?? [])
      .filter((pattern) => pattern.endsWith("/"))
      .map((pattern) => pattern.slice(0, -1)),
  );
  const skippedFiles = (options.exclude ?? []).filter((pattern) => !pattern.endsWith("/"));

  return async (projectPath) => {
    let count = 0;
    let maxMtime = 0;
    let bytes = 0;
    let visited = 0;
    const walk = async (dir: string): Promise<void> => {
      if (visited >= maxEntries) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (visited >= maxEntries) return;
        visited += 1;
        if (entry.isDirectory()) {
          if (skippedDirs.has(entry.name)) continue;
          await walk(join(dir, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        if (matchesAny(entry.name, skippedFiles)) continue;
        try {
          const info = await stat(join(dir, entry.name));
          count += 1;
          bytes += info.size;
          if (info.mtimeMs > maxMtime) maxMtime = info.mtimeMs;
        } catch {
          // A locked or vanished file contributes nothing.
        }
      }
    };
    await walk(projectPath);
    return `${count}-${Math.round(maxMtime)}-${bytes}`;
  };
}

/** The small glob subset the default excludes use (`~$*`, `*.tmp`, `Thumbs.db`). */
function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.includes("*")) {
      const [prefix = "", suffix = ""] = pattern.split("*");
      return name.startsWith(prefix) && name.endsWith(suffix);
    }
    return name === pattern;
  });
}
