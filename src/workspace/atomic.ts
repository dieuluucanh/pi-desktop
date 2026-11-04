/**
 * Atomic, durable text writes.
 *
 * A temp file in the same directory is fsynced and renamed over the target, so
 * a crash can never leave a half-written settings file or source file behind.
 * The temp file is removed on any failure.
 *
 * `mode` is opt-in. Profile writes (settings/auth/state) keep the historical
 * `0600`; the editor passes the existing file's mode (or `0644` for a new file)
 * so saving source code does not silently make it owner-only.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  /** POSIX permission bits for the new file. Defaults to `0o600`. */
  mode?: number;
}

export async function writeFileAtomic(
  target: string,
  text: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "w", options.mode ?? 0o600);
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
