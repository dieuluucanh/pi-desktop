import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isPathInside,
  resolveInsideRoot,
  resolveRelativePath,
  type RealPathIo,
} from "../../src/host/path-guard";

/** A fake tree: every key is a path, its value is the path it resolves to. */
function fakeIo(tree: Record<string, string>): RealPathIo {
  return {
    async realpath(target: string): Promise<string | null> {
      return tree[resolve(target)] ?? null;
    },
  };
}

describe("isPathInside", () => {
  it("accepts the root itself and anything below it", () => {
    const root = resolve("/tmp/workspace");
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, join(root, "src", "index.ts"))).toBe(true);
    expect(isPathInside(root, join(root, "..", "workspace", "a"))).toBe(true);
  });

  it("rejects a parent, a sibling with a shared prefix and unrelated paths", () => {
    const root = resolve("/tmp/workspace");
    expect(isPathInside(root, resolve("/tmp"))).toBe(false);
    // The prefix trap: `/tmp/workspace-evil` starts with `/tmp/workspace`.
    expect(isPathInside(root, resolve("/tmp/workspace-evil/file"))).toBe(false);
    expect(isPathInside(root, resolve("/etc/passwd"))).toBe(false);
  });

  it("rejects traversal even when it is written into the candidate", () => {
    const root = resolve("/tmp/workspace");
    expect(isPathInside(root, join(root, "..", "..", "etc", "passwd"))).toBe(false);
  });

  it("rejects empty or non-string input", () => {
    expect(isPathInside("", "/tmp/a")).toBe(false);
    expect(isPathInside("/tmp/a", "")).toBe(false);
  });
});

describe("resolveRelativePath", () => {
  const root = resolve("/tmp/workspace");

  it("resolves a relative path inside the root", () => {
    expect(resolveRelativePath(root, "src/index.ts")).toBe(join(root, "src", "index.ts"));
  });

  it("keeps an absolute path that is already inside", () => {
    const inside = join(root, "a", "b.txt");
    expect(resolveRelativePath(root, inside)).toBe(inside);
  });

  it("refuses traversal and an absolute path outside", () => {
    expect(resolveRelativePath(root, "../secrets.txt")).toBeNull();
    expect(resolveRelativePath(root, resolve("/etc/passwd"))).toBeNull();
    expect(resolveRelativePath(root, "")).toBeNull();
    expect(resolveRelativePath(root, 42)).toBeNull();
  });
});

describe("resolveInsideRoot (symlink-aware)", () => {
  const root = resolve("/tmp/workspace");

  it("accepts an existing file inside the root", async () => {
    const io = fakeIo({
      [root]: root,
      [join(root, "a.txt")]: join(root, "a.txt"),
    });
    expect(await resolveInsideRoot(io, root, "a.txt")).toBe(join(root, "a.txt"));
  });

  it("refuses a symlink whose real target escapes the root", async () => {
    const link = join(root, "escape.txt");
    const io = fakeIo({
      [root]: root,
      [link]: resolve("/etc/passwd"),
    });
    expect(await resolveInsideRoot(io, root, "escape.txt")).toBeNull();
  });

  it("refuses a symlinked ancestor that escapes the root", async () => {
    const linkDir = join(root, "link");
    const io = fakeIo({
      [root]: root,
      [linkDir]: resolve("/elsewhere"),
    });
    // The target does not exist, but its nearest existing ancestor is outside.
    expect(await resolveInsideRoot(io, root, "link/new.txt")).toBeNull();
  });

  it("accepts a not-yet-existing file under an existing in-root parent", async () => {
    const parent = join(root, "src");
    const io = fakeIo({
      [root]: root,
      [parent]: parent,
    });
    expect(await resolveInsideRoot(io, root, "src/new.txt")).toBe(join(root, "src", "new.txt"));
  });

  it("accepts a target whose nearest existing ancestor is inside the root", async () => {
    const io = fakeIo({ [root]: root });
    // The not-yet-created `missing` segment cannot be a symlink; the nearest
    // existing ancestor is the root itself, which is inside.
    expect(await resolveInsideRoot(io, root, "missing/new.txt")).toBe(
      join(root, "missing", "new.txt"),
    );
  });

  it("refuses lexical traversal before any filesystem call", async () => {
    const io = fakeIo({ [root]: root });
    expect(await resolveInsideRoot(io, root, "../outside.txt")).toBeNull();
  });
});

describe("resolveInsideRoot (real filesystem)", () => {
  let base = "";
  let root = "";
  let outside = "";

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "pi-desktop-pathguard-"));
    root = join(base, "workspace");
    outside = join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, "inside.txt"), "inside", "utf8");
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const io: RealPathIo = {
    async realpath(target) {
      const { realpath } = await import("node:fs/promises");
      try {
        return await realpath(target);
      } catch {
        return null;
      }
    },
  };

  it("resolves a real file inside the workspace", async () => {
    const resolved = await resolveInsideRoot(io, root, "inside.txt");
    expect(resolved).toBe(join(root, "inside.txt"));
  });

  it("refuses a real symlink that points outside the workspace", async () => {
    const link = join(root, "escape.txt");
    try {
      await symlink(join(outside, "secret.txt"), link, "file");
    } catch {
      // Windows without Developer Mode cannot create symlinks; the fake-io test
      // above already covers the rule, so skip rather than fail the matrix.
      return;
    }
    expect(await resolveInsideRoot(io, root, "escape.txt")).toBeNull();
  });

  it("accepts a real symlink that stays inside the workspace", async () => {
    const link = join(root, "alias.txt");
    try {
      await symlink(join(root, "inside.txt"), link, "file");
    } catch {
      return;
    }
    // The caller's own path is returned (so the relative display stays theirs),
    // and the real target it points at is verified to be inside the root.
    expect(await resolveInsideRoot(io, root, "alias.txt")).toBe(link);
  });
});
