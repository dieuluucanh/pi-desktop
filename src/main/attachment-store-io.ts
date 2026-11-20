import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, statfs, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AttachmentStoreError, type AttachmentStoreIo } from "../attachments/store";
import { ATTACHMENT_LIMITS, isAttachmentId } from "../shared/attachments";

/**
 * Node filesystem adapter for the app-owned attachment store. This is an I/O
 * boundary, not an Electron module. The caller must hold Electron's single
 * instance lock for the lifetime of all writers. Generated names are the only
 * data used as paths; display names and owner IDs never enter filesystem paths.
 *
 * lstat and O_NOFOLLOW defend against managed-path symlinks, but Node has no
 * portable handle-relative open: they cannot eliminate a hostile same-user
 * process swapping a parent directory between checks. Keep userData private.
 */
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_MANIFEST = 8 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 100_000;
const IO_CHUNK = 256 * 1024;
const locks = new Map<string, Promise<void>>();

type Handle = Awaited<ReturnType<typeof open>>;

export interface NodeAttachmentStoreIoOptions {
  root: string;
  /** Injected for deterministic failure/space tests. */
  freeBytes?: (root: string) => Promise<number>;
  newId?: () => string;
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function assertDigest(value: string): void {
  if (!DIGEST.test(value)) throw new AttachmentStoreError("bad_request", "invalid storage key");
}

function assertId(value: string): void {
  if (!isAttachmentId(value)) throw new AttachmentStoreError("bad_request", "invalid staging ID");
}

async function missingIsNull<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AttachmentStoreError("conflict", "attachment storage directory is not safe");
  }
}

async function regularFile(path: string): Promise<boolean> {
  const info = await missingIsNull(() => lstat(path));
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new AttachmentStoreError("conflict", "attachment storage entry is not a regular file");
  }
  return true;
}

async function openRead(path: string): Promise<Handle> {
  if (!(await regularFile(path))) {
    const error = new Error("attachment storage file is missing") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    throw new AttachmentStoreError("conflict", "attachment storage entry is not a regular file");
  }
  return handle;
}

async function readBounded(path: string, max: number): Promise<Uint8Array | null> {
  const handle = await missingIsNull(() => openRead(path));
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!Number.isSafeInteger(info.size) || info.size > max) {
      throw new AttachmentStoreError("corrupt_manifest", "attachment metadata is too large");
    }
    const output = Buffer.alloc(info.size + 1);
    let at = 0;
    while (at < output.length) {
      const result = await handle.read(output, at, output.length - at, at);
      if (result.bytesRead === 0) break;
      at += result.bytesRead;
    }
    if (at !== info.size) {
      throw new AttachmentStoreError("conflict", "attachment metadata changed during reading");
    }
    return output.subarray(0, at);
  } finally {
    await handle.close();
  }
}

async function hashFile(path: string): Promise<string> {
  const handle = await openRead(path);
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(IO_CHUNK);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > ATTACHMENT_LIMITS.documentOriginalBytes) {
        throw new AttachmentStoreError("quota_exceeded", "attachment data exceeds the limit");
      }
      hash.update(chunk.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: Handle, chunk: Uint8Array, position: number): Promise<void> {
  let written = 0;
  while (written < chunk.byteLength) {
    const result = await handle.write(
      chunk,
      written,
      chunk.byteLength - written,
      position + written,
    );
    if (result.bytesWritten <= 0) throw new Error("attachment write made no progress");
    written += result.bytesWritten;
  }
}

async function deleteIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}

async function defaultFreeBytes(root: string): Promise<number> {
  const stat = await statfs(root, { bigint: true });
  const free = stat.bavail * stat.bsize;
  return free > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(free);
}

/** Count actual files plus conservative persistent stage/promotion reservations. */
async function measureStorage(root: string): Promise<{ actual: number; reserved: number }> {
  let actual = 0;
  let reserved = 0;
  let entriesSeen = 0;
  const pending = [{ path: root, depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > 12)
      throw new AttachmentStoreError("conflict", "attachment tree is too deep");
    for (const entry of await readdir(current.path, { withFileTypes: true })) {
      entriesSeen++;
      if (entriesSeen > MAX_SCAN_ENTRIES) {
        throw new AttachmentStoreError("quota_exceeded", "attachment storage has too many entries");
      }
      const path = join(current.path, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink())
        throw new AttachmentStoreError("conflict", "unsafe attachment storage link");
      if (info.isDirectory()) {
        pending.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!info.isFile() || !Number.isSafeInteger(info.size)) {
        throw new AttachmentStoreError("conflict", "invalid attachment storage entry");
      }
      actual += info.size;
      if (!Number.isSafeInteger(actual))
        throw new AttachmentStoreError("quota_exceeded", "attachment storage is too large");
      if (entry.name.endsWith(".reserve")) {
        const raw = await readBounded(path, 64);
        const text = raw ? new TextDecoder("utf-8", { fatal: true }).decode(raw) : "";
        if (!/^(0|[1-9][0-9]*)$/.test(text)) {
          throw new AttachmentStoreError("conflict", "attachment reservation is corrupt");
        }
        const size = Number(text);
        if (!Number.isSafeInteger(size) || size > ATTACHMENT_LIMITS.documentOriginalBytes) {
          throw new AttachmentStoreError("conflict", "attachment reservation is invalid");
        }
        reserved += size * 2;
        if (!Number.isSafeInteger(reserved))
          throw new AttachmentStoreError("quota_exceeded", "attachment reservations are too large");
      }
    }
  }
  return { actual, reserved };
}

export function createNodeAttachmentStoreIo(
  options: NodeAttachmentStoreIoOptions,
): AttachmentStoreIo {
  const root = resolve(options.root);
  const lockKey = process.platform === "win32" ? root.toLowerCase() : root;
  const newId = options.newId ?? randomUUID;
  const freeBytes = options.freeBytes ?? defaultFreeBytes;

  const layout = async (
    profile: string,
  ): Promise<{ base: string; stages: string; objects: string }> => {
    assertDigest(profile);
    await ensureDirectory(root);
    const version = join(root, "v1");
    await ensureDirectory(version);
    const base = join(version, profile);
    await ensureDirectory(base);
    const stages = join(base, "staging");
    const objects = join(base, "objects");
    await ensureDirectory(stages);
    await ensureDirectory(objects);
    return { base, stages, objects };
  };
  const stagePaths = async (profile: string, id: string) => {
    assertId(id);
    const paths = await layout(profile);
    return {
      ...paths,
      stage: join(paths.stages, `${id}.part`),
      reservation: join(paths.stages, `${id}.reserve`),
    };
  };
  const temporary = (dir: string): string => {
    const id = newId();
    assertId(id);
    return join(dir, `${id}.tmp`);
  };

  return {
    async exclusive<T>(operation: () => Promise<T>): Promise<T> {
      const previous = locks.get(lockKey) ?? Promise.resolve();
      let release = (): void => {};
      const current = new Promise<void>((resolveLock) => {
        release = resolveLock;
      });
      locks.set(lockKey, current);
      await previous;
      try {
        return await operation();
      } finally {
        release();
        if (locks.get(lockKey) === current) locks.delete(lockKey);
      }
    },
    async readManifest(profile) {
      const { base } = await layout(profile);
      const bytes = await readBounded(join(base, "manifest.json"), MAX_MANIFEST);
      return bytes === null ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },
    async writeManifestAtomic(profile, contents) {
      const { base } = await layout(profile);
      const target = join(base, "manifest.json");
      await regularFile(target);
      const temp = temporary(base);
      let handle: Handle | null = null;
      let created = false;
      try {
        handle = await open(temp, "wx", 0o600);
        created = true;
        await handle.writeFile(contents, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        // Never remove the old manifest to make rename succeed on Windows.
        await regularFile(target);
        await rename(temp, target);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (created) await deleteIfExists(temp).catch(() => undefined);
        throw error;
      }
    },
    async createStaging(profile, id, declaredBytes, limits) {
      if (
        !Number.isSafeInteger(declaredBytes) ||
        declaredBytes < 0 ||
        declaredBytes > ATTACHMENT_LIMITS.documentOriginalBytes
      ) {
        throw new AttachmentStoreError("bad_request", "invalid staging size");
      }
      const paths = await stagePaths(profile, id);
      const measured = await measureStorage(root);
      const free = await freeBytes(root);
      if (
        !Number.isSafeInteger(free) ||
        free < 0 ||
        measured.actual + measured.reserved + declaredBytes * 2 > limits.storeBytes ||
        free - measured.reserved - declaredBytes * 2 < limits.freeReserveBytes
      ) {
        throw new AttachmentStoreError("quota_exceeded", "not enough attachment storage");
      }
      let reservationCreated = false;
      let stageCreated = false;
      let handle: Handle | null = null;
      try {
        handle = await open(paths.reservation, "wx", 0o600);
        reservationCreated = true;
        await handle.writeFile(String(declaredBytes), "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        handle = await open(paths.stage, "wx", 0o600);
        stageCreated = true;
        await handle.sync();
        await handle.close();
        handle = null;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (stageCreated) await deleteIfExists(paths.stage).catch(() => undefined);
        if (reservationCreated) await deleteIfExists(paths.reservation).catch(() => undefined);
        throw error;
      }
    },
    async stagingSize(profile, id) {
      const { stage } = await stagePaths(profile, id);
      if (!(await regularFile(stage))) return null;
      const info = await lstat(stage);
      return info.size;
    },
    async appendStaging(profile, id, offset, chunk) {
      const { stage } = await stagePaths(profile, id);
      if (!(await regularFile(stage)))
        throw new AttachmentStoreError("not_found", "staging data is missing");
      const handle = await open(stage, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size !== offset)
          throw new AttachmentStoreError("conflict", "staging offset changed");
        await writeAll(handle, chunk, offset);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async hashStaging(profile, id) {
      return hashFile((await stagePaths(profile, id)).stage);
    },
    async ensureObject(profile, id, digest) {
      assertDigest(digest);
      const { stage, objects } = await stagePaths(profile, id);
      const target = join(objects, digest);
      if (await regularFile(target)) {
        if ((await hashFile(target)) !== digest)
          throw new AttachmentStoreError("conflict", "stored attachment is damaged");
        return;
      }
      const temp = temporary(objects);
      let input: Handle | null = null;
      let output: Handle | null = null;
      let created = false;
      try {
        input = await openRead(stage);
        output = await open(temp, "wx", 0o600);
        created = true;
        const hash = createHash("sha256");
        const chunk = Buffer.alloc(IO_CHUNK);
        let offset = 0;
        for (;;) {
          const { bytesRead } = await input.read(chunk, 0, chunk.length, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
          if (offset > ATTACHMENT_LIMITS.documentOriginalBytes)
            throw new AttachmentStoreError("quota_exceeded", "attachment data exceeds the limit");
          const slice = chunk.subarray(0, bytesRead);
          hash.update(slice);
          await writeAll(output, slice, offset - bytesRead);
        }
        if (hash.digest("hex") !== digest)
          throw new AttachmentStoreError("digest_mismatch", "staging changed during promotion");
        await output.sync();
        await output.close();
        output = null;
        await input.close();
        input = null;
        try {
          // Hard-link publication is atomic and never replaces an existing object.
          await link(temp, target);
        } catch (error) {
          if (
            codeOf(error) !== "EEXIST" ||
            !(await regularFile(target)) ||
            (await hashFile(target)) !== digest
          )
            throw error;
        }
      } finally {
        await input?.close().catch(() => undefined);
        await output?.close().catch(() => undefined);
        if (created) await deleteIfExists(temp).catch(() => undefined);
      }
    },
    async readObjectPreview(profile, digest, maxBytes) {
      assertDigest(digest);
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        maxBytes > ATTACHMENT_LIMITS.previewBytes
      ) {
        throw new AttachmentStoreError("bad_request", "invalid preview limit");
      }
      const { objects } = await layout(profile);
      const handle = await openRead(join(objects, digest));
      try {
        const hash = createHash("sha256");
        const chunk = Buffer.alloc(IO_CHUNK);
        const preview = new Uint8Array(maxBytes);
        let offset = 0;
        let previewLength = 0;
        for (;;) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
          if (offset > ATTACHMENT_LIMITS.documentOriginalBytes) {
            throw new AttachmentStoreError("quota_exceeded", "attachment data exceeds the limit");
          }
          hash.update(chunk.subarray(0, bytesRead));
          const take = Math.min(bytesRead, maxBytes - previewLength);
          if (take > 0) {
            preview.set(chunk.subarray(0, take), previewLength);
            previewLength += take;
          }
        }
        if (hash.digest("hex") !== digest) {
          throw new AttachmentStoreError("digest_mismatch", "stored attachment is damaged");
        }
        return { bytes: preview.slice(0, previewLength), size: offset };
      } finally {
        await handle.close();
      }
    },
    async readObject(profile, digest, maxBytes) {
      assertDigest(digest);
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        maxBytes > ATTACHMENT_LIMITS.documentOriginalBytes
      ) {
        throw new AttachmentStoreError("bad_request", "invalid preparation limit");
      }
      const { objects } = await layout(profile);
      const handle = await openRead(join(objects, digest));
      try {
        const info = await handle.stat();
        if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size > maxBytes) {
          throw new AttachmentStoreError("quota_exceeded", "attachment exceeds preparation limit");
        }
        const bytes = new Uint8Array(info.size);
        const hash = createHash("sha256");
        let offset = 0;
        while (offset < bytes.byteLength) {
          const count = Math.min(IO_CHUNK, bytes.byteLength - offset);
          const { bytesRead } = await handle.read(bytes, offset, count, offset);
          if (bytesRead === 0) {
            throw new AttachmentStoreError("size_mismatch", "stored attachment changed");
          }
          hash.update(bytes.subarray(offset, offset + bytesRead));
          offset += bytesRead;
        }
        const extra = new Uint8Array(1);
        if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
          throw new AttachmentStoreError("size_mismatch", "stored attachment changed");
        }
        if (hash.digest("hex") !== digest) {
          throw new AttachmentStoreError("digest_mismatch", "stored attachment is damaged");
        }
        return bytes;
      } finally {
        await handle.close();
      }
    },
    async removeStaging(profile, id) {
      const { stage, reservation } = await stagePaths(profile, id);
      // Never release the reservation before removing the corresponding bytes.
      await deleteIfExists(stage);
      await deleteIfExists(reservation);
    },
  };
}
