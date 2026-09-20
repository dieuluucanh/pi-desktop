/**
 * Session-file operations in the main process (plan step 11).
 *
 * The control host is the authority on *which* session files exist (it reads
 * Pi's own index), and the main process performs the recoverable delete because
 * only Electron has `shell.trashItem`. This module is the second, defensive
 * check on the way to the trash: the resolved path must be a `.jsonl` file
 * inside the shared profile's `sessions/` directory, so a rogue or buggy host
 * response can never point the trashing at an arbitrary file.
 *
 * Pure (no `electron`), so `tests/main/session-ops.test.ts` can prove the
 * containment rule on every platform's path syntax.
 */

import { isAbsolute, join, relative, resolve } from "node:path";

/** The directory every Pi session JSONL lives under (`<profile>/sessions/`). */
export function sessionsDirOf(profileDir: string): string {
  return join(profileDir, "sessions");
}

/**
 * True when `candidate` is an absolute `.jsonl` path inside the profile's
 * `sessions/` directory. Symlinks and `..` traversal are rejected by resolving
 * both sides and requiring the candidate to stay below the root.
 */
export function isDeletableSessionPath(
  candidate: unknown,
  profileDir: string,
): candidate is string {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (!isAbsolute(candidate)) return false;
  if (!candidate.toLowerCase().endsWith(".jsonl")) return false;
  const root = resolve(sessionsDirOf(profileDir));
  const target = resolve(candidate);
  if (target === root) return false;
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}
