import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  mergePrefs,
  sanitizePrefs,
} from "../../src/shared/prefs";

describe("sanitizePrefs", () => {
  it("returns defaults for non-objects", () => {
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(sanitizePrefs("dark")).toEqual(DEFAULT_PREFS);
    expect(sanitizePrefs(42)).toEqual(DEFAULT_PREFS);
  });

  it("ignores unknown keys", () => {
    const result = sanitizePrefs({ theme: "light", somethingElse: true });
    expect(Object.keys(result).sort()).toEqual(
      ["sidebarCollapsed", "sidebarWidth", "theme", "viewMode"].sort(),
    );
    expect(result.theme).toBe("light");
  });

  it("falls back per field when a value is invalid", () => {
    const result = sanitizePrefs({
      theme: "neon",
      viewMode: "yelling",
      sidebarCollapsed: "yes",
      sidebarWidth: "wide",
    });
    expect(result).toEqual(DEFAULT_PREFS);
  });

  it("clamps the sidebar width to the supported range", () => {
    expect(sanitizePrefs({ sidebarWidth: 10 }).sidebarWidth).toBe(MIN_SIDEBAR_WIDTH);
    expect(sanitizePrefs({ sidebarWidth: 9_999 }).sidebarWidth).toBe(MAX_SIDEBAR_WIDTH);
    expect(sanitizePrefs({ sidebarWidth: Number.NaN }).sidebarWidth).toBe(
      DEFAULT_PREFS.sidebarWidth,
    );
    expect(sanitizePrefs({ sidebarWidth: 300.6 }).sidebarWidth).toBe(301);
  });

  it("accepts every documented theme and view mode", () => {
    for (const theme of ["dark", "light", "system"] as const) {
      expect(sanitizePrefs({ theme }).theme).toBe(theme);
    }
    for (const viewMode of ["normal", "verbose", "summary"] as const) {
      expect(sanitizePrefs({ viewMode }).viewMode).toBe(viewMode);
    }
  });
});

describe("mergePrefs", () => {
  it("applies a partial patch over the current values", () => {
    const merged = mergePrefs(
      { ...DEFAULT_PREFS, theme: "light", viewMode: "verbose" },
      {
        viewMode: "summary",
      },
    );
    expect(merged).toEqual({ ...DEFAULT_PREFS, theme: "light", viewMode: "summary" });
  });

  it("cannot be used to inject an unknown key", () => {
    const merged = mergePrefs(DEFAULT_PREFS, { injected: "x", theme: "light" });
    expect(merged).not.toHaveProperty("injected");
    expect(merged.theme).toBe("light");
  });

  it("survives a non-object patch", () => {
    expect(mergePrefs(DEFAULT_PREFS, null)).toEqual(DEFAULT_PREFS);
  });
});
