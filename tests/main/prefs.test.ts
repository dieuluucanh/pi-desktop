import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  MAX_DRAFT_LENGTH,
  MAX_DRAFT_TABS,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  mergePrefs,
  sanitizeDrafts,
  sanitizePrefs,
} from "../../src/shared/prefs";
import { hashPromptText } from "../../src/shared/prompt-origin";

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
        "desktopKeybindings",
        "drafts",
        "onboardingCompletedAt",
        "privacyAcknowledged",
        "profileMode",
        "promptOrigins",
        "showExpandedPrompts",
        "sidebarCollapsed",
        "sidebarWidth",
        "telemetryEnabled",
        "theme",
        "viewMode",
      ].sort(),
    );
    expect(result.theme).toBe("light");
  });

  it("ignores a legacy favourites key from an older app-state.json", () => {
    // The star now edits Pi's `enabledModels`; the old app preference is dead
    // and must not leak back into the sanitised result.
    const result = sanitizePrefs({ favoriteModels: ["openai/gpt-5"], theme: "light" });
    expect(result).not.toHaveProperty("favoriteModels");
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

  it("defaults expanded command prompts off and sanitizes their origin map", () => {
    // The plan's default: a fresh or older app-state.json must not reveal
    // command system prompts by omission.
    expect(sanitizePrefs({}).showExpandedPrompts).toBe(false);
    expect(sanitizePrefs({ showExpandedPrompts: "yes" }).showExpandedPrompts).toBe(false);
    expect(sanitizePrefs({ showExpandedPrompts: true }).showExpandedPrompts).toBe(true);

    expect(sanitizePrefs({}).promptOrigins).toEqual({});
    const key = hashPromptText("expanded command body");
    const result = sanitizePrefs({
      promptOrigins: { [key]: " /commit -a ", notAHash: "/x", [hashPromptText("bad")]: 7 },
    });
    expect(result.promptOrigins).toEqual({ [key]: "/commit -a" });
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
