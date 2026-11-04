import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUILD_INFO_FILE,
  buildChannelFromEnv,
  buildInfoDocument,
  macSigningFromEnv,
  pruneForeignRuntimes,
  writeBuildInfo,
} from "../../scripts/electron-builder-after-pack.mjs";
import { BUILD_INFO_FILE as SHARED_BUILD_INFO_FILE } from "../../src/shared/build-info";

/**
 * `extraResources` copies `resources/runtime` wholesale, so a checkout that has
 * runtimes for several platforms would otherwise ship them all. Pruning is what
 * keeps each package to its own platform/arch — and, on Windows, what stops the
 * NSIS 7z step from choking on the Linux runtime's `bin/{npm,npx,corepack}`
 * symlinks.
 */

const roots: string[] = [];

function fixture(entries: string[]): { nodeDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-after-pack-"));
  roots.push(root);
  const nodeDir = join(root, "node");
  mkdirSync(nodeDir, { recursive: true });
  for (const entry of entries) mkdirSync(join(nodeDir, entry), { recursive: true });
  // The lock file and README live beside the runtime directories and must survive.
  writeFileSync(join(nodeDir, "node.lock.json"), "{}");
  writeFileSync(join(nodeDir, "README.md"), "# runtime\n");
  return { nodeDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("afterPack runtime pruning", () => {
  it("keeps only the runtime the package was built for", () => {
    const { nodeDir } = fixture([
      "win32-x64",
      "linux-x64",
      "linux-arm64",
      ".staging-linux-x64-abc",
    ]);

    expect(pruneForeignRuntimes(nodeDir, "win32-x64")).toEqual([
      ".staging-linux-x64-abc",
      "linux-arm64",
      "linux-x64",
    ]);
    expect(readdirSync(nodeDir).sort()).toEqual(["README.md", "node.lock.json", "win32-x64"]);
  });

  it("is a no-op when only the target runtime is installed", () => {
    const { nodeDir } = fixture(["linux-x64"]);

    expect(pruneForeignRuntimes(nodeDir, "linux-x64")).toEqual([]);
    expect(readdirSync(nodeDir).sort()).toEqual(["README.md", "linux-x64", "node.lock.json"]);
  });
});

describe("afterPack build provenance", () => {
  it("uses the same file name as the app-side reader", () => {
    expect(BUILD_INFO_FILE).toBe(SHARED_BUILD_INFO_FILE);
  });

  it("resolves the channel from explicit config, CI, or the local default", () => {
    expect(buildChannelFromEnv({ PI_BUILD_CHANNEL: "release", GITHUB_ACTIONS: "false" })).toBe(
      "release",
    );
    expect(buildChannelFromEnv({ PI_BUILD_CHANNEL: "local", GITHUB_ACTIONS: "true" })).toBe(
      "local",
    );
    expect(buildChannelFromEnv({ GITHUB_ACTIONS: "true" })).toBe("release");
    expect(buildChannelFromEnv({})).toBe("local");
    expect(buildChannelFromEnv({ PI_BUILD_CHANNEL: "nightly" })).toBe("local");
  });

  it("normalises the document and writes readable JSON into resources", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-build-info-"));
    roots.push(root);

    expect(
      buildInfoDocument({
        version: "0.3.0",
        channel: "release",
        commit: "abc123",
        builtAt: "2026-11-01T00:00:00.000Z",
        platform: "darwin",
        macSigning: "adhoc",
      }),
    ).toEqual({
      channel: "release",
      version: "0.3.0",
      commit: "abc123",
      builtAt: "2026-11-01T00:00:00.000Z",
      macSigning: "adhoc",
    });
    expect(buildInfoDocument({ channel: "nightly" }).channel).toBe("unknown");

    const target = writeBuildInfo(root, {
      version: "0.3.0",
      channel: "local",
      commit: null,
      builtAt: "2026-11-01T00:00:00.000Z",
    });
    expect(target).toBe(join(root, SHARED_BUILD_INFO_FILE));
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
      channel: "local",
      version: "0.3.0",
      commit: null,
      builtAt: "2026-11-01T00:00:00.000Z",
      macSigning: "none",
    });
  });

  it("records a macOS signing kind only for a darwin target", () => {
    const base = { version: "0.5.0", channel: "release", commit: null, builtAt: null };
    // The app turns `macSigning` into the update gate, so a Windows/Linux
    // package must never look like a signed mac build.
    expect(buildInfoDocument({ ...base, platform: "win32", macSigning: "adhoc" })).toEqual({
      ...base,
      macSigning: "none",
    });
    expect(buildInfoDocument({ ...base, platform: "darwin", macSigning: "developer-id" })).toEqual({
      ...base,
      macSigning: "developer-id",
    });
    expect(buildInfoDocument({ ...base, platform: "darwin", macSigning: "whatever" })).toEqual({
      ...base,
      macSigning: "none",
    });
    expect(buildInfoDocument({ ...base, platform: "darwin" })).toEqual({
      ...base,
      macSigning: "none",
    });
  });

  it("reads the signing kind from PI_MAC_SIGNING and defaults to none", () => {
    // The hook runs before electron-builder signs, so the workflow declares the
    // identity it passed. Unset must mean "unsigned", never "ad-hoc".
    expect(macSigningFromEnv({ PI_MAC_SIGNING: "adhoc" })).toBe("adhoc");
    expect(macSigningFromEnv({ PI_MAC_SIGNING: "developer-id" })).toBe("developer-id");
    expect(macSigningFromEnv({})).toBe("none");
    expect(macSigningFromEnv({ PI_MAC_SIGNING: "none" })).toBe("none");
    expect(macSigningFromEnv({ PI_MAC_SIGNING: "self-signed" })).toBe("none");
  });
});
