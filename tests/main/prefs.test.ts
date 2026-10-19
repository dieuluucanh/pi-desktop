import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  MAX_DRAFT_LENGTH,
  MAX_DRAFT_TABS,
  MAX_FAVORITE_KEY_LENGTH,
  MAX_FAVORITE_MODELS,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  mergePrefs,
  sanitizeDrafts,
  sanitizeFavorites,
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
      [
        "drafts",
        "favoriteModels",
        "onboardingCompletedAt",
        "privacyAcknowledged",
        "profileMode",
        "sidebarCollapsed",
        "sidebarWidth",
        "telemetryEnabled",
        "theme",
        "viewMode",
      ].sort(),
    );
    expect(result.theme).toBe("light");
  });

  it("defaults telemetry off and the privacy screen unanswered (plan step 23)", () => {
    // An older app-state.json has neither key; both must fall back to "off" and
    // "not yet answered" rather than opting the user in by omission.
    expect(sanitizePrefs({ theme: "light" }).telemetryEnabled).toBe(false);
    expect(sanitizePrefs({ theme: "light" }).privacyAcknowledged).toBe(false);
    expect(sanitizePrefs({ telemetryEnabled: "yes" }).telemetryEnabled).toBe(false);
    expect(sanitizePrefs({ privacyAcknowledged: 1 }).privacyAcknowledged).toBe(false);
    expect(sanitizePrefs({ telemetryEnabled: true, privacyAcknowledged: true })).toMatchObject({
      telemetryEnabled: true,
      privacyAcknowledged: true,
    });
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

describe("drafts (plan step 6)", () => {
  it("keeps string drafts and drops everything else", () => {
    expect(sanitizeDrafts({ "tab-1": "hello", "tab-2": 42, "tab-3": "" })).toEqual({
      "tab-1": "hello",
    });
  });

  it("truncates a long draft and caps how many tabs hold one", () => {
    const long = sanitizeDrafts({ "tab-1": "x".repeat(MAX_DRAFT_LENGTH + 500) });
    expect(long["tab-1"]?.length).toBe(MAX_DRAFT_LENGTH);

    const many = Object.fromEntries(
      Array.from({ length: MAX_DRAFT_TABS + 10 }, (_, index) => [`tab-${index}`, "draft"]),
    );
    expect(Object.keys(sanitizeDrafts(many))).toHaveLength(MAX_DRAFT_TABS);
  });

  it("returns an empty map for junk", () => {
    expect(sanitizeDrafts(null)).toEqual({});
    expect(sanitizeDrafts("nope")).toEqual({});
  });

  it("round-trips through the preference sanitiser", () => {
    const prefs = sanitizePrefs({ theme: "light", drafts: { "tab-1": "a draft" } });
    expect(prefs.drafts).toEqual({ "tab-1": "a draft" });
    expect(sanitizePrefs({}).drafts).toEqual({});
  });
});

/**
 * Favourites are `provider/id` keys living in app state, so their bound has to
 * cover the gateway editor's caps (64 + 1 + 200). A key past the bound is
 * **dropped**, not truncated, so a too-small bound loses the model silently on
 * the next reload.
 */
describe("favorites (plan step 8, bound raised in step 29)", () => {
  it("keeps a key at the true worst-case length", () => {
    const key = `${"p".repeat(64)}/${"m".repeat(200)}`;
    expect(key.length).toBe(265);
    expect(sanitizeFavorites([key])).toEqual([key]);
    expect(sanitizePrefs({ favoriteModels: [key] }).favoriteModels).toEqual([key]);
  });

  it("still drops an over-long, empty or non-string key", () => {
    const tooLong = "x".repeat(MAX_FAVORITE_KEY_LENGTH + 1);
    expect(sanitizeFavorites([tooLong])).toEqual([]);
    expect(sanitizeFavorites(["", "a", 42, null])).toEqual(["a"]);
  });

  it("still dedupes and caps the list", () => {
    const many = Array.from({ length: MAX_FAVORITE_MODELS + 5 }, (_, index) => `p/m-${index}`);
    const kept = sanitizeFavorites([...many, "p/m-0"]);
    expect(kept).toHaveLength(MAX_FAVORITE_MODELS);
    expect(new Set(kept).size).toBe(MAX_FAVORITE_MODELS);
  });

  it("returns an empty list for junk", () => {
    expect(sanitizeFavorites(null)).toEqual([]);
    expect(sanitizeFavorites("nope")).toEqual([]);
  });
});
