import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  NATIVE_FLOOR,
  assertNativeFloor,
  compareVersions,
  isUsableBinary,
  maxVersion,
  nativeCandidatePaths,
  parseReadelfVersionNeeds,
} from "../../scripts/lib/node-pty-artifact.mjs";

/**
 * A `readelf --version-info` excerpt from the 0.8.0 Linux package: built on
 * `ubuntu-latest` (glibc 2.42), it could not load on Linux Mint 22 (2.39).
 * `GLIBC_PRIVATE` has no version and must be ignored.
 */
const READELF_0_8_0 = `
Version needs section '.gnu.version_r' contains 5 entries:
  0x0010:   Name: GLIBC_2.2.5  Flags: none  Version: 6
  0x0020:   Name: GLIBCXX_3.4.22  Flags: none  Version: 7
  0x0030:   Name: GLIBC_2.28  Flags: none  Version: 8
  0x0040:   Name: GLIBC_2.34  Flags: none  Version: 9
  0x0050:   Name: GLIBC_2.42  Flags: none  Version: 10
  0x0060:   Name: CXXABI_1.3.9  Flags: none  Version: 11
  0x0070:   Name: GLIBC_PRIVATE  Flags: none  Version: 12
`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("nativeCandidatePaths", () => {
  it("prefers the pinned prebuild, then the runner build", () => {
    expect(nativeCandidatePaths("/pkg/node-pty", "linux-x64")).toEqual([
      join("/pkg/node-pty", "prebuilds", "linux-x64", "pty.node"),
      join("/pkg/node-pty", "build", "Release", "pty.node"),
    ]);
  });
});

describe("parseReadelfVersionNeeds", () => {
  it("collects each family and ignores GLIBC_PRIVATE", () => {
    const needs = parseReadelfVersionNeeds(READELF_0_8_0);
    expect(needs.glibc).toEqual(["2.2.5", "2.28", "2.34", "2.42"]);
    expect(needs.glibcxx).toEqual(["3.4.22"]);
    expect(needs.cxxabi).toEqual(["1.3.9"]);
    expect(JSON.stringify(needs)).not.toContain("PRIVATE");
  });

  it("deduplicates repeated symbols", () => {
    const needs = parseReadelfVersionNeeds(
      "Name: GLIBC_2.34 Name: GLIBC_2.34 Name: GLIBCXX_3.4.28",
    );
    expect(needs.glibc).toEqual(["2.34"]);
    expect(needs.glibcxx).toEqual(["3.4.28"]);
  });
});

describe("compareVersions", () => {
  it("compares numerically, not lexicographically", () => {
    expect(compareVersions("2.2.5", "2.31")).toBe(-1);
    expect(compareVersions("2.42", "2.31")).toBe(1);
    expect(compareVersions("3.4.28", "3.4.28")).toBe(0);
    expect(compareVersions("3.4.9", "3.4.10")).toBe(-1);
  });

  it("treats a missing segment as zero", () => {
    expect(compareVersions("2.31", "2.31.0")).toBe(0);
    expect(compareVersions("2.4", "2.4.1")).toBe(-1);
  });
});

describe("maxVersion", () => {
  it("returns null for an empty list and the numeric maximum otherwise", () => {
    expect(maxVersion([])).toBeNull();
    expect(maxVersion(["2.2.5", "2.4", "2.14"])).toBe("2.14");
  });
});

describe("assertNativeFloor", () => {
  it("accepts a binary built on the supported floor", () => {
    expect(
      assertNativeFloor({ glibc: ["2.2.5", "2.31"], glibcxx: ["3.4.28"], cxxabi: [] }),
    ).toEqual({ glibc: "2.31", glibcxx: "3.4.28" });
  });

  it("rejects the 0.8.0 GLIBC_2.42 binary with the offending symbol", () => {
    const needs = parseReadelfVersionNeeds(READELF_0_8_0);
    expect(() => assertNativeFloor(needs)).toThrow(/GLIBC_2\.42 > GLIBC_2\.31/);
    expect(() => assertNativeFloor(needs)).toThrow(/npm run pty:linux/);
  });

  it("rejects a newer C++ runtime even when glibc is fine", () => {
    expect(() => assertNativeFloor({ glibc: ["2.31"], glibcxx: ["3.4.29"], cxxabi: [] })).toThrow(
      /GLIBCXX_3\.4\.29/,
    );
  });

  it("honours a caller-supplied floor", () => {
    expect(
      assertNativeFloor(
        { glibc: ["2.35"], glibcxx: ["3.4.29"], cxxabi: [] },
        { glibc: "2.35", glibcxx: "3.4.29" },
      ),
    ).toEqual({ glibc: "2.35", glibcxx: "3.4.29" });
    expect(NATIVE_FLOOR).toEqual({ glibc: "2.31", glibcxx: "3.4.28" });
  });
});

describe("isUsableBinary", () => {
  it("rejects missing and zero-byte files", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-pty-artifact-"));
    roots.push(root);
    const empty = join(root, "empty.node");
    const full = join(root, "full.node");
    writeFileSync(empty, "");
    writeFileSync(full, "native");

    expect(isUsableBinary(empty)).toBe(false);
    expect(isUsableBinary(join(root, "missing.node"))).toBe(false);
    expect(isUsableBinary(full)).toBe(true);
    expect(isUsableBinary(root)).toBe(false);
  });
});
