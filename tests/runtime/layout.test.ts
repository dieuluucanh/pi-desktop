import { describe, expect, it } from "vitest";
import {
  MINIMUM_NODE_VERSION,
  isSupportedRuntimeTarget,
  meetsMinimumNodeVersion,
  nodeBinaryRelativePath,
  npmCliRelativePath,
  npxCliRelativePath,
  parseNodeVersion,
  joinPathEntries,
  runtimeTarget,
  shimFileName,
} from "../../src/main/runtime/layout";

describe("runtimeTarget", () => {
  it("builds the <platform>-<arch> directory name", () => {
    expect(runtimeTarget("win32", "x64")).toBe("win32-x64");
    expect(runtimeTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(runtimeTarget("linux", "arm64")).toBe("linux-arm64");
  });

  it("treats anything that is not arm64 as x64 (the only two supported arches)", () => {
    expect(runtimeTarget("win32", "ia32")).toBe("win32-x64");
  });

  it("agrees with the supported target list", () => {
    expect(isSupportedRuntimeTarget(runtimeTarget("win32", "x64"))).toBe(true);
    expect(isSupportedRuntimeTarget("freebsd-x64")).toBe(false);
  });
});

describe("distribution paths", () => {
  it("knows where node lives in the distribution", () => {
    expect(nodeBinaryRelativePath("win32")).toBe("node.exe");
    expect(nodeBinaryRelativePath("darwin").split(/[\\/]/).join("/")).toBe("bin/node");
    expect(nodeBinaryRelativePath("linux").split(/[\\/]/).join("/")).toBe("bin/node");
  });

  it("knows where the bundled npm CLI lives", () => {
    expect(npmCliRelativePath("win32").split(/[\\/]/).join("/")).toBe(
      "node_modules/npm/bin/npm-cli.js",
    );
    expect(npmCliRelativePath("linux").split(/[\\/]/).join("/")).toBe(
      "lib/node_modules/npm/bin/npm-cli.js",
    );
    expect(npxCliRelativePath("linux").split(/[\\/]/).join("/")).toBe(
      "lib/node_modules/npm/bin/npx-cli.js",
    );
  });

  it("uses .cmd shims only on Windows", () => {
    expect(shimFileName("pi", "win32")).toBe("pi.cmd");
    expect(shimFileName("pi", "linux")).toBe("pi");
    expect(shimFileName("npm", "darwin")).toBe("npm");
  });

  it("never uses a node.cmd shim, on any platform", () => {
    // `node` must be the real executable on PATH; the extensionless script is
    // the Git Bash shim, not the cmd one.
    expect(shimFileName("node", "win32")).toBe("node");
    expect(shimFileName("node", "linux")).toBe("node");
  });
});

describe("version gate", () => {
  it("parses `node --version` output", () => {
    expect(parseNodeVersion("v24.21.0\n")).toBe("24.21.0");
    expect(parseNodeVersion("22.19.0")).toBe("22.19.0");
    expect(parseNodeVersion("")).toBeNull();
    expect(parseNodeVersion("not a version")).toBeNull();
    expect(parseNodeVersion(null)).toBeNull();
  });

  it("enforces the Pi engine requirement", () => {
    expect(meetsMinimumNodeVersion("22.19.0")).toBe(true);
    expect(meetsMinimumNodeVersion("24.21.0")).toBe(true);
    expect(meetsMinimumNodeVersion("22.18.0")).toBe(false);
    expect(meetsMinimumNodeVersion("20.11.1")).toBe(false);
    expect(meetsMinimumNodeVersion(null)).toBe(false);
    expect(MINIMUM_NODE_VERSION).toBe("22.19.0");
  });

  it("compares against a custom minimum", () => {
    expect(meetsMinimumNodeVersion("24.0.0", "25.0.0")).toBe(false);
  });
});

describe("joinPathEntries", () => {
  it("puts the runtime directories first with the platform separator", () => {
    expect(joinPathEntries(["C:\\bin", "C:\\node", "C:\\Windows"], "win32")).toBe(
      "C:\\bin;C:\\node;C:\\Windows",
    );
    expect(joinPathEntries(["/opt/bin", "/opt/node/bin", "/usr/bin"], "linux")).toBe(
      "/opt/bin:/opt/node/bin:/usr/bin",
    );
  });

  it("drops empty and missing entries", () => {
    expect(joinPathEntries(["/opt/bin", "", null, undefined, "/usr/bin"], "linux")).toBe(
      "/opt/bin:/usr/bin",
    );
    expect(joinPathEntries(["C:\\bin", null, ""], "win32")).toBe("C:\\bin");
  });
});
