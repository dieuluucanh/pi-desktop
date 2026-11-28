import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename } from "node:path";
import { ATTACHMENT_LIMITS } from "../shared/attachments";
import type { SelectedAttachment } from "./attachment-picker";

/** Open an OS-selected file by handle; this adapter is never exposed to a renderer. */
export async function openSelectedAttachment(path: string): Promise<SelectedAttachment> {
  const before = await lstat(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    !Number.isSafeInteger(before.size) ||
    before.size > ATTACHMENT_LIMITS.documentOriginalBytes
  ) {
    throw new Error("selected attachment is not a supported regular file");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await handle.stat();
    if (
      !initial.isFile() ||
      initial.dev !== before.dev ||
      initial.ino !== before.ino ||
      initial.size !== before.size ||
      initial.mtimeMs !== before.mtimeMs ||
      initial.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("selected attachment changed while opening");
    }
    const verifyUnchanged = async (): Promise<void> => {
      const current = await handle.stat();
      if (
        !current.isFile() ||
        current.dev !== initial.dev ||
        current.ino !== initial.ino ||
        current.size !== initial.size ||
        current.mtimeMs !== initial.mtimeMs ||
        current.ctimeMs !== initial.ctimeMs
      ) {
        throw new Error("selected attachment changed while copying");
      }
    };
    return {
      name: basename(path),
      // The classifier, not the filename supplied by an OS picker, determines type.
      mimeType: "application/octet-stream",
      size: initial.size,
      async read(offset, maxBytes) {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(maxBytes) ||
          maxBytes < 1 ||
          maxBytes > ATTACHMENT_LIMITS.importChunkBytes ||
          offset + maxBytes > initial.size
        ) {
          throw new Error("invalid selected-file read");
        }
        await verifyUnchanged();
        const buffer = new Uint8Array(maxBytes);
        const result = await handle.read(buffer, 0, maxBytes, offset);
        await verifyUnchanged();
        return buffer.slice(0, result.bytesRead);
      },
      verifyUnchanged,
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
