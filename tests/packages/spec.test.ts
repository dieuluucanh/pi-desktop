import { describe, expect, it } from "vitest";

import {
  PackageSourceError,
  parsePackageSource,
  samePackage,
  withPinnedVersion,
} from "../../src/main/packages/spec";

describe("parsePackageSource", () => {
  it("normalizes bare npm names", () => {
    expect(parsePackageSource("pi-lens")).toMatchObject({
      source: "npm:pi-lens",
      kind: "npm",
      identity: "npm:pi-lens",
      name: "pi-lens",
      version: null,
      pinned: false,
    });
  });

  it("keeps scoped names and versions", () => {
    expect(parsePackageSource("@dieulc/pi-office-bridge@^0.4.1")).toMatchObject({
      source: "npm:@dieulc/pi-office-bridge@^0.4.1",
      kind: "npm",
      identity: "npm:@dieulc/pi-office-bridge",
      name: "@dieulc/pi-office-bridge",
      version: "^0.4.1",
      pinned: true,
    });
  });

  it("accepts the explicit npm: prefix", () => {
    expect(parsePackageSource("npm:pi-web-access@0.29.0").source).toBe("npm:pi-web-access@0.29.0");
    expect(parsePackageSource("npm:  pi-memory  ").source).toBe("npm:pi-memory");
  });

  it("parses git shorthand and pins the ref", () => {
    const parsed = parsePackageSource("git:github.com/dieuluucanh/pi-for-office@v1");
    expect(parsed).toMatchObject({
      kind: "git",
      source: "git:github.com/dieuluucanh/pi-for-office@v1",
      ref: "v1",
      pinned: true,
      identity: "git:github.com/dieuluucanh/pi-for-office",
    });
  });

  it("does not mistake an ssh user for a ref", () => {
    const parsed = parsePackageSource("git:git@github.com:user/repo");
    expect(parsed.ref).toBeNull();
    expect(parsed.source).toBe("git:git@github.com:user/repo");
  });

  it("parses protocol urls and strips .git from the identity", () => {
    const parsed = parsePackageSource("https://github.com/user/repo.git");
    expect(parsed.kind).toBe("url");
    expect(parsed.identity).toBe("url:https://github.com/user/repo");
    expect(parsed.pinned).toBe(false);
  });

  it("parses refs on urls", () => {
    const parsed = parsePackageSource("https://github.com/user/repo@v2");
    expect(parsed.ref).toBe("v2");
    expect(parsed.pinned).toBe(true);
    expect(parsed.source).toBe("https://github.com/user/repo@v2");
  });

  it("recognizes local paths", () => {
    for (const candidate of ["./local-ext", "../local-ext", "/opt/ext", "~/ext", "C:\\ext\\pkg"]) {
      expect(parsePackageSource(candidate).kind).toBe("path");
    }
    expect(parsePackageSource("/opt/ext/").identity).toBe("path:/opt/ext");
  });

  it("rejects empty and malformed input", () => {
    expect(() => parsePackageSource("")).toThrow(PackageSourceError);
    expect(() => parsePackageSource("   ")).toThrow(PackageSourceError);
    expect(() => parsePackageSource("npm:")).toThrow(PackageSourceError);
    expect(() => parsePackageSource("npm:@/x")).toThrow(PackageSourceError);
    expect(() => parsePackageSource("git:")).toThrow(PackageSourceError);
  });
});

describe("samePackage", () => {
  it("dedupes across versioned and unversioned specs", () => {
    expect(samePackage("npm:pi-lens", "pi-lens@4.2.1")).toBe(true);
    expect(samePackage("npm:@dieulc/workflow", "npm:@dieulc/workflow@^0.3.0")).toBe(true);
  });

  it("ignores the git ref", () => {
    expect(samePackage("git:github.com/u/r", "git:github.com/u/r@v1")).toBe(true);
  });

  it("separates different packages and kinds", () => {
    expect(samePackage("npm:pi-lens", "npm:pi-memory")).toBe(false);
    expect(samePackage("npm:pi-lens", "git:github.com/u/pi-lens")).toBe(false);
  });
});

describe("withPinnedVersion", () => {
  it("adds a version range to an npm source", () => {
    expect(withPinnedVersion("npm:@dieulc/pi-office-bridge", "^0.4.1")).toBe(
      "npm:@dieulc/pi-office-bridge@^0.4.1",
    );
    expect(withPinnedVersion("@dieulc/pi-office-bridge", "^0.4.1")).toBe(
      "npm:@dieulc/pi-office-bridge@^0.4.1",
    );
  });

  it("replaces an existing version", () => {
    expect(withPinnedVersion("npm:@dieulc/pi-office-bridge@^0.3.0", "^0.4.1")).toBe(
      "npm:@dieulc/pi-office-bridge@^0.4.1",
    );
  });

  it("leaves non-npm sources alone", () => {
    expect(withPinnedVersion("git:github.com/u/r@v1", "^1.0.0")).toBe("git:github.com/u/r@v1");
  });
});
