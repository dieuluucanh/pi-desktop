import { describe, expect, it } from "vitest";

import {
  MAX_PACKAGE_UPDATE_SIGNATURE,
  PACKAGE_CHECK_CACHE_MS,
  PACKAGE_CHECK_INTERVAL_MS,
  PACKAGE_CHECK_STALE_MS,
  PACKAGE_CHECK_STARTUP_DELAY_MS,
  packageCheckDue,
  packageUpdateIdentity,
  packageUpdateSignature,
  sanitizePackageUpdatesSnapshot,
  sanitizePackageUpdateSummary,
  type PackageUpdateSummary,
} from "../../src/shared/packages";

/**
 * The update model (plan step 1): the wire shape the host answers with, the
 * sanitizers the renderer trusts, and the pure predicates the scheduler uses.
 */

function update(patch: Partial<PackageUpdateSummary> = {}): PackageUpdateSummary {
  return {
    source: "npm:pi-lens",
    name: "pi-lens",
    kind: "npm",
    scope: "user",
    latestVersion: "0.29.0",
    ...patch,
  };
}

describe("sanitizePackageUpdateSummary", () => {
  it("normalises the source and keeps a real target version", () => {
    expect(
      sanitizePackageUpdateSummary({
        source: "  pi-lens ",
        name: "pi-lens",
        kind: "npm",
        scope: "project",
        latestVersion: "0.29.0",
      }),
    ).toEqual({
      source: "npm:pi-lens",
      name: "pi-lens",
      kind: "npm",
      scope: "project",
      latestVersion: "0.29.0",
    });
  });

  it("derives the kind from the source, not from the untrusted field", () => {
    expect(
      sanitizePackageUpdateSummary({
        source: "git:github.com/owner/repo",
        kind: "npm",
        latestVersion: "v2",
      }),
    ).toMatchObject({ kind: "git", name: "repo" });
    expect(sanitizePackageUpdateSummary({ source: "npm:pi-lens", kind: "git" })).toMatchObject({
      kind: "npm",
    });
  });

  it("defaults the scope and nulls a missing or non-string version", () => {
    expect(sanitizePackageUpdateSummary({ source: "npm:pi-lens" })).toMatchObject({
      scope: "user",
      latestVersion: null,
    });
    expect(
      sanitizePackageUpdateSummary({ source: "npm:pi-lens", scope: "temporary", latestVersion: 7 }),
    ).toMatchObject({ scope: "user", latestVersion: null });
  });

  it("drops a path, an unparseable source and a missing source", () => {
    expect(sanitizePackageUpdateSummary({ source: "./local-extension" })).toBeNull();
    expect(sanitizePackageUpdateSummary({ source: "npm:../../evil" })).toBeNull();
    expect(sanitizePackageUpdateSummary({ name: "pi-lens" })).toBeNull();
    expect(sanitizePackageUpdateSummary(null)).toBeNull();
  });

  it("falls back to the parsed name when the host omits one", () => {
    expect(sanitizePackageUpdateSummary({ source: "npm:@scope/name" })).toMatchObject({
      name: "@scope/name",
    });
  });
});

describe("sanitizePackageUpdatesSnapshot", () => {
  it("coerces a well-formed answer", () => {
    expect(
      sanitizePackageUpdatesSnapshot({
        updates: [update(), { source: "./skip-me" }],
        checkedAt: 1_700_000_000_000,
        offline: false,
      }),
    ).toEqual({
      updates: [update()],
      checkedAt: 1_700_000_000_000,
      offline: false,
    });
  });

  it("defaults a missing or malformed document without throwing", () => {
    expect(sanitizePackageUpdatesSnapshot(null)).toEqual({
      updates: [],
      checkedAt: 0,
      offline: false,
    });
    expect(sanitizePackageUpdatesSnapshot({ checkedAt: -1, offline: "true" })).toEqual({
      updates: [],
      checkedAt: 0,
      offline: false,
    });
    expect(sanitizePackageUpdatesSnapshot({ checkedAt: Number.NaN }).checkedAt).toBe(0);
  });

  it("keeps offline only when it is strictly true", () => {
    expect(sanitizePackageUpdatesSnapshot({ offline: true }).offline).toBe(true);
    expect(sanitizePackageUpdatesSnapshot({ offline: 1 }).offline).toBe(false);
  });
});

describe("packageUpdateIdentity", () => {
  it("ignores the version and normalises npm and git", () => {
    expect(packageUpdateIdentity({ source: "npm:pi-lens@0.28.0" })).toBe("npm:pi-lens");
    expect(packageUpdateIdentity({ source: "pi-lens" })).toBe("npm:pi-lens");
    expect(packageUpdateIdentity({ source: "git:github.com/owner/repo#v1" })).toBe(
      "git:github.com/owner/repo",
    );
  });

  it("keeps the raw source when it cannot be parsed", () => {
    expect(packageUpdateIdentity({ source: "npm:../../evil" })).toBe("npm:../../evil");
  });
});

describe("packageUpdateSignature", () => {
  it("is order-insensitive and version-sensitive", () => {
    const a = update({ source: "npm:alpha", name: "alpha", latestVersion: "2.0.0" });
    const b = update({ source: "npm:beta", name: "beta", latestVersion: null });
    expect(packageUpdateSignature([a, b])).toBe(packageUpdateSignature([b, a]));
    expect(packageUpdateSignature([a])).not.toBe(
      packageUpdateSignature([{ ...a, latestVersion: "2.0.1" }]),
    );
    expect(packageUpdateSignature([a, b])).toContain("npm:beta@");
  });

  it("ignores the version recorded in the source itself", () => {
    expect(packageUpdateSignature([update({ source: "npm:alpha@1.0.0" })])).toBe(
      packageUpdateSignature([update({ source: "npm:alpha@9.9.9" })]),
    );
  });

  it("is empty for no updates and bounded for prefs", () => {
    expect(packageUpdateSignature([])).toBe("");
    const many = Array.from({ length: 400 }, (_, index) =>
      update({ source: `npm:package-with-a-long-name-${index}`, name: `p${index}` }),
    );
    expect(packageUpdateSignature(many).length).toBeLessThanOrEqual(MAX_PACKAGE_UPDATE_SIGNATURE);
    expect(packageUpdateSignature(many, 20)).toHaveLength(20);
  });
});

describe("packageCheckDue", () => {
  const now = 1_700_000_000_000;

  it("is due when the page has never checked", () => {
    expect(packageCheckDue({ checkedAt: null, now })).toBe(true);
    expect(packageCheckDue({ checkedAt: 0, now })).toBe(true);
    expect(packageCheckDue({ checkedAt: Number.NaN, now })).toBe(true);
  });

  it("is not due inside the stale window and due after it", () => {
    expect(packageCheckDue({ checkedAt: now - 1_000, now })).toBe(false);
    expect(packageCheckDue({ checkedAt: now - PACKAGE_CHECK_STALE_MS, now })).toBe(true);
    expect(packageCheckDue({ checkedAt: now - PACKAGE_CHECK_STALE_MS + 1, now })).toBe(false);
  });

  it("honours a custom window and a clock that moved backwards", () => {
    expect(packageCheckDue({ checkedAt: now - 5_000, now, staleMs: 1_000 })).toBe(true);
    expect(packageCheckDue({ checkedAt: now + 60_000, now })).toBe(true);
  });
});

describe("check timings", () => {
  it("keeps the cache shorter than the interval and the page window equal to it", () => {
    expect(PACKAGE_CHECK_STARTUP_DELAY_MS).toBeGreaterThan(0);
    expect(PACKAGE_CHECK_CACHE_MS).toBeLessThan(PACKAGE_CHECK_INTERVAL_MS);
    expect(PACKAGE_CHECK_STALE_MS).toBe(PACKAGE_CHECK_INTERVAL_MS);
  });
});
