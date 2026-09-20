/**
 * Path containment (plan step 23).
 *
 * Two rules, one per risk:
 *
 * 1. **Lexical containment** (`isPathInside`) resolves `.`/`..` and requires the
 *    candidate to stay below the root. It is pure, so it is cheap to use
 *    everywhere and easy to test on every platform's path syntax.
 * 2. **Symlink containment** (`resolveInsideRoot`) additionally resolves both
 *    sides with `realpath`, so a symlink inside the workspace that points
 *    outside it (or a symlinked ancestor) is refused even though the lexical
 *    check would pass. The filesystem is injected (`RealPathIo`), so the rule is
 *    unit tested against a real temp tree and a fake one.
 *
 * Both live in the host because the workspace file handlers (`files.read` /
 * `files.write`) and the blob reader (`host.blobs.read`) are the callers.
 */

import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** The filesystem surface the symlink check needs; the rest is pure. */
export interface RealPathIo {
  /** Resolves symlinks and normalises case; null when the path does not exist. */
  realpath(target: string): Promise<string | null>;
}

/**
 * True when `candidate` resolves to `root` or below it. Both sides are resolved
 * first, so `../` traversal cannot pass and a sibling whose name merely *starts*
 * with the root's name (`C:\cache\blob-evil` vs `C:\cache\blob`) cannot either.
 */
export function isPathInside(root: string, candidate: string): boolean {
  if (typeof root !== "string" || root.length === 0) return false;
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const base = resolve(root);
  const target = resolve(candidate);
  if (target === base) return true;
  const rel = relative(base, target);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Resolves a caller-supplied path against `root` and returns it only when it is
 * lexically contained. Absolute paths are honoured (then checked); relative ones
 * are resolved against the root. Returns null for an escape or an empty path.
 */
export function resolveRelativePath(root: string, requested: unknown): string | null {
  if (typeof requested !== "string" || requested.trim().length === 0) return null;
  const target = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  return isPathInside(root, target) ? target : null;
}

/** Walks up to the nearest existing ancestor and resolves it; null when none. */
async function realpathNearest(io: RealPathIo, target: string): Promise<string | null> {
  let current = target;
  for (let depth = 0; depth < 64; depth += 1) {
    const real = await io.realpath(current);
    if (real !== null) return real;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * The symlink-aware containment check used by the file handlers.
 *
 * - An existing target must resolve to a real path inside the real root, so a
 *   symlink (or symlinked ancestor) that escapes the workspace is refused.
 * - A target that does not exist yet (a write) must have an existing ancestor
 *   inside the real root; the not-yet-created segment cannot be a symlink, and
 *   the file is created with `wx`-style semantics by the writer.
 *
 * Returns the resolved absolute target, or null when the path escapes.
 */
export async function resolveInsideRoot(
  io: RealPathIo,
  root: string,
  requested: unknown,
): Promise<string | null> {
  const target = resolveRelativePath(root, requested);
  if (target === null) return null;
  const realRoot = (await realpathNearest(io, resolve(root))) ?? resolve(root);

  const realTarget = await io.realpath(target);
  if (realTarget !== null) {
    return isPathInside(realRoot, realTarget) ? target : null;
  }

  const realParent = await realpathNearest(io, dirname(target));
  if (realParent === null || !isPathInside(realRoot, realParent)) return null;
  return target;
}
