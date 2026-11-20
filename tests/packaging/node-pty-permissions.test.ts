import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureExecutable,
  nodePtyHelperCandidates,
} from "../../scripts/fix-node-pty-permissions.mjs";

/**
 * node-pty's published macOS `spawn-helper` is mode 0644, so the installer's
 * prebuild path leaves it non-executable and macOS fails `pty.fork` with
 * `posix_spawnp failed`. The postinstall script fixes the mode; these tests pin
 * the candidate list and the "only existing files" rule.
 */

describe("node-pty helper permissions", () => {
  it("looks at the prebuild for this platform/arch and a source build", () => {
    const root = join("/tmp", "node-pty");
    expect(nodePtyHelperCandidates(root)).toEqual([
      join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      join(root, "build", "Release", "spawn-helper"),
    ]);
  });

  it("chmods only existing candidates, with 0755, and reports them", () => {
    const calls: Array<[string, number]> = [];
    const changed = ensureExecutable(
      ["/prebuild/spawn-helper", "/release/spawn-helper"],
      (path, mode) => calls.push([path, mode]),
      (path) => path === "/prebuild/spawn-helper",
    );

    expect(changed).toEqual(["/prebuild/spawn-helper"]);
    expect(calls).toEqual([["/prebuild/spawn-helper", 0o755]]);
  });

  it("is a no-op when neither location exists", () => {
    const calls: Array<[string, number]> = [];
    const changed = ensureExecutable(
      ["/missing/one", "/missing/two"],
      (path, mode) => calls.push([path, mode]),
      () => false,
    );

    expect(changed).toEqual([]);
    expect(calls).toEqual([]);
  });
});
