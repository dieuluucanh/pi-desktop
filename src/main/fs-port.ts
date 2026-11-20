/**
 * Filesystem port.
 *
 * Everything the app writes (settings.json, the Pi npm root, sideloaded
 * manifests) goes through this interface so install/sideload logic can be
 * unit-tested with an in-memory filesystem and audited in one place.
 */

import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";

export type ExistingPathKind = "file" | "directory";

export interface FsPort {
  readTextFile(target: string): Promise<string | null>;
  writeTextFile(target: string, contents: string): Promise<void>;
  /**
   * Appends one chunk. The host's per-session log uses this so a hang can be
   * reconstructed after the fact: rewriting the file from a bounded buffer kept
   * only the last few lines (2026-11-06 plan, step 16).
   */
  appendTextFile(target: string, contents: string): Promise<void>;
  /** Binary write (bug-report zips); the text port cannot carry arbitrary bytes. */
  writeBinaryFile(target: string, contents: Uint8Array): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file or directory. Returns true when something was removed. */
  remove(target: string): Promise<boolean>;
  ensureDir(target: string): Promise<void>;
  pathKind(target: string): Promise<ExistingPathKind | null>;
  /** File names (not full paths) inside a directory; empty when missing. */
  listDirectory(target: string): Promise<string[]>;
}

export function createNodeFsPort(): FsPort {
  return {
    async readTextFile(target) {
      try {
        return await readFile(target, "utf8");
      } catch {
        return null;
      }
    },
    async writeTextFile(target, contents) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    },
    async appendTextFile(target, contents) {
      await mkdir(path.dirname(target), { recursive: true });
      await appendFile(target, contents, "utf8");
    },
    async writeBinaryFile(target, contents) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    },
    async copyFile(from, to) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    },
    async rename(from, to) {
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
    },
    async remove(target) {
      try {
        await rm(target, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    },
    async ensureDir(target) {
      await mkdir(target, { recursive: true });
    },
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
    async listDirectory(target) {
      try {
        const entries = await readdir(target, { withFileTypes: true });
        return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
      } catch {
        return [];
      }
    },
  };
}

export interface MemoryFsPort extends FsPort {
  files: Map<string, string>;
  /** Binary files kept separate so `readTextFile` never invents text for a zip. */
  binary: Map<string, Uint8Array>;
  dirs: Set<string>;
}

function key(target: string): string {
  return path.normalize(target);
}

function ancestorsOf(target: string): string[] {
  const out: string[] = [];
  let current = key(target);
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) break;
    out.push(parent);
    current = parent;
  }
  return out;
}

export function createMemoryFsPort(initial?: {
  files?: Record<string, string>;
  dirs?: readonly string[];
}): MemoryFsPort {
  const files = new Map<string, string>();
  const binary = new Map<string, Uint8Array>();
  const dirs = new Set<string>();

  const ensureDir = (target: string): void => {
    dirs.add(key(target));
    for (const parent of ancestorsOf(target)) dirs.add(parent);
  };

  for (const dir of initial?.dirs ?? []) ensureDir(dir);
  for (const [target, contents] of Object.entries(initial?.files ?? {})) {
    files.set(key(target), contents);
    ensureDir(path.dirname(target));
  }

  return {
    files,
    binary,
    dirs,
    async readTextFile(target) {
      return files.get(key(target)) ?? null;
    },
    async writeTextFile(target, contents) {
      files.set(key(target), contents);
      ensureDir(path.dirname(target));
    },
    async appendTextFile(target, contents) {
      const normalized = key(target);
      files.set(normalized, `${files.get(normalized) ?? ""}${contents}`);
      ensureDir(path.dirname(target));
    },
    async writeBinaryFile(target, contents) {
      binary.set(key(target), contents);
      ensureDir(path.dirname(target));
    },
    async copyFile(from, to) {
      const contents = files.get(key(from));
      if (contents === undefined) throw new Error(`copyFile: missing source ${from}`);
      files.set(key(to), contents);
      ensureDir(path.dirname(to));
    },
    async rename(from, to) {
      const contents = files.get(key(from));
      if (contents === undefined) throw new Error(`rename: missing source ${from}`);
      files.delete(key(from));
      files.set(key(to), contents);
      ensureDir(path.dirname(to));
    },
    async remove(target) {
      const normalized = key(target);
      let removed = false;
      if (files.delete(normalized)) removed = true;
      if (dirs.delete(normalized)) removed = true;
      for (const file of [...files.keys()]) {
        if (file.startsWith(`${normalized}${path.sep}`)) {
          files.delete(file);
          removed = true;
        }
      }
      for (const dir of [...dirs]) {
        if (dir.startsWith(`${normalized}${path.sep}`)) {
          dirs.delete(dir);
          removed = true;
        }
      }
      return removed;
    },
    async ensureDir(target) {
      ensureDir(target);
    },
    async pathKind(target) {
      const normalized = key(target);
      if (files.has(normalized)) return "file";
      if (dirs.has(normalized)) return "directory";
      return null;
    },
    async listDirectory(target) {
      const normalized = key(target);
      const out: string[] = [];
      for (const file of files.keys()) {
        if (path.dirname(file) === normalized) out.push(path.basename(file));
      }
      return out.sort();
    },
  };
}
