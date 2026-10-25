import { describe, expect, it, vi } from "vitest";
import { createHostBuildId, type HostBuildIo } from "../../src/main/host-build";

/**
 * Host bundle fingerprint (2026-10-24 stale-host plan): the id must be stable
 * while the file is unchanged, change when the content changes, and degrade to
 * `null` (fail open) when the bundle cannot be read.
 */

function fakeIo(initial: { size: number; mtimeMs: number; contents: string } | null) {
  let current = initial;
  const stat = vi.fn((_target: string) =>
    current === null ? null : { size: current.size, mtimeMs: current.mtimeMs },
  );
  const read = vi.fn((_target: string) => current?.contents ?? null);
  const io: HostBuildIo = { stat, read };
  return {
    io,
    stat,
    read,
    set(next: { size: number; mtimeMs: number; contents: string } | null) {
      current = next;
    },
  };
}

describe("createHostBuildId", () => {
  it("is stable for unchanged contents and does not re-read the bundle", () => {
    const fs = fakeIo({ size: 10, mtimeMs: 1, contents: "host-bundle" });
    const id = createHostBuildId("/out/host/index.mjs", fs.io);

    const first = id();
    const second = id();

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(fs.stat).toHaveBeenCalledTimes(2);
    expect(fs.read).toHaveBeenCalledTimes(1);
  });

  it("changes when the content changes, even with the same size", () => {
    const fs = fakeIo({ size: 10, mtimeMs: 1, contents: "host-bundle" });
    const id = createHostBuildId("/out/host/index.mjs", fs.io);
    const first = id();

    fs.set({ size: 10, mtimeMs: 2, contents: "host-bundlf" });
    const second = id();

    expect(second).not.toBe(first);
    expect(fs.read).toHaveBeenCalledTimes(2);
  });

  it("returns null when the bundle is missing", () => {
    const fs = fakeIo(null);
    const id = createHostBuildId("/out/host/index.mjs", fs.io);

    expect(id()).toBeNull();
    expect(fs.read).not.toHaveBeenCalled();
  });

  it("returns null when a stat or a read fails", () => {
    const io: HostBuildIo = {
      stat: () => {
        throw new Error("EACCES");
      },
      read: () => "ignored",
    };
    // The node IO catches its own errors; this fake proves the provider itself
    // fails open rather than throwing into a keystroke.
    expect(() => createHostBuildId("/out/host/index.mjs", io)()).not.toThrow();
    expect(createHostBuildId("/out/host/index.mjs", io)()).toBeNull();

    const unreadable: HostBuildIo = {
      stat: () => ({ size: 10, mtimeMs: 1 }),
      read: () => null,
    };
    expect(createHostBuildId("/out/host/index.mjs", unreadable)()).toBeNull();
  });

  it("forgets the cache while the bundle is unreadable", () => {
    const fs = fakeIo({ size: 10, mtimeMs: 1, contents: "host-bundle" });
    const id = createHostBuildId("/out/host/index.mjs", fs.io);
    const first = id();

    fs.set(null);
    expect(id()).toBeNull();

    fs.set({ size: 10, mtimeMs: 1, contents: "host-bundle" });
    expect(id()).toBe(first);
  });
});
