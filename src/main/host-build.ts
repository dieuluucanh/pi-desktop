/**
 * Host bundle fingerprint (2026-10-24 stale-host plan).
 *
 * A Pi host is a long-lived child process: it keeps running the
 * `out/host/index.mjs` that existed when it was spawned. In development the
 * bundle is rebuilt while the app stays up, so the renderer can be current while
 * the host is not. The supervisor stamps every spawn with this fingerprint and
 * the session service compares it with the file on disk before trusting a host.
 *
 * The provider is synchronous because `HostSupervisor.spawnChild` is
 * synchronous. It stats on every call and only re-reads/hashes the bundle when
 * `size:mtimeMs` changes, so a request-path check stays cheap. Any I/O failure
 * returns `null`: the stale check fails open rather than guessing.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export interface HostBuildStat {
  size: number;
  mtimeMs: number;
}

/** The filesystem surface the fingerprint needs (injected for tests). */
export interface HostBuildIo {
  stat(target: string): HostBuildStat | null;
  read(target: string): string | null;
}

/** Default IO: Node's synchronous filesystem. Every failure is "unreadable". */
export function createNodeHostBuildIo(): HostBuildIo {
  return {
    stat(target) {
      try {
        const info = statSync(target);
        return { size: info.size, mtimeMs: info.mtimeMs };
      } catch {
        return null;
      }
    },
    read(target) {
      try {
        return readFileSync(target, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/**
 * Returns a stable content fingerprint for `target`, or `null` when it cannot
 * be read. The id is the first 16 hex characters of a SHA-256 of the bundle, so
 * two identical builds keep the same id even if their mtime changes.
 */
export function createHostBuildId(
  target: string,
  io: HostBuildIo = createNodeHostBuildIo(),
): () => string | null {
  let cachedKey: string | null = null;
  let cachedId: string | null = null;
  return () => {
    let stat: HostBuildStat | null;
    try {
      stat = io.stat(target);
    } catch {
      stat = null;
    }
    if (!stat) {
      cachedKey = null;
      cachedId = null;
      return null;
    }
    const key = `${stat.size}:${stat.mtimeMs}`;
    if (cachedKey === key) return cachedId;
    let contents: string | null;
    try {
      contents = io.read(target);
    } catch {
      contents = null;
    }
    if (contents === null) {
      cachedKey = null;
      cachedId = null;
      return null;
    }
    cachedId = createHash("sha256").update(contents).digest("hex").slice(0, 16);
    cachedKey = key;
    return cachedId;
  };
}
