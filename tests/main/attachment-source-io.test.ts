import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSelectedAttachment } from "../../src/main/attachment-source-io";
import { ATTACHMENT_LIMITS } from "../../src/shared/attachments";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-attachment-source-"));
  roots.push(root);
  const path = join(root, "example.txt");
  await writeFile(path, "hello");
  return { root, path };
}

describe("selected attachment source", () => {
  it("reads a bounded stable snapshot through an already-open regular-file handle", async () => {
    const { path } = await setup();
    const source = await openSelectedAttachment(path);
    expect(source.name).toBe("example.txt");
    expect(source.size).toBe(5);
    expect(source.mimeType).toBe("application/octet-stream");
    expect(new TextDecoder().decode(await source.read(1, 3))).toBe("ell");
    await expect(source.read(0, ATTACHMENT_LIMITS.importChunkBytes + 1)).rejects.toThrow();
    await source.verifyUnchanged();
    await source.close();
  });

  it("refuses a file that changed during import", async () => {
    const { path } = await setup();
    const source = await openSelectedAttachment(path);
    await writeFile(path, "changed and larger");
    await expect(source.verifyUnchanged()).rejects.toThrow(/changed/);
    await expect(source.read(0, 1)).rejects.toThrow(/changed/);
    await source.close();
  });

  it("rejects directories and symbolic links", async (context) => {
    const { root, path } = await setup();
    await expect(openSelectedAttachment(root)).rejects.toThrow(/regular file/);
    const link = join(root, "link.txt");
    try {
      await symlink(path, link, "file");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(openSelectedAttachment(link)).rejects.toThrow(/regular file/);
  });
});
