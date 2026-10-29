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
import { MIN_SCAN_INTERVAL_MS } from "../../src/shared/checkpoints";
import { DEFAULT_RAIL_WIDTH, MAX_RAIL_WIDTH, MIN_RAIL_WIDTH } from "../../src/shared/rail";

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
        "checkpoints",
        "desktopKeybindings",
        "drafts",
        "onboardingCompletedAt",
        "privacyAcknowledged",
        "profileMode",
        "promptOrigins",
        "rail",
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

/**
 * The rail and checkpoint preference keys (git-checkpoint plan steps 10/19/27).
 *
 * Both are persisted shapes with a sanitizer, and both are written by the
 * Settings cards and the rail's drag handle. The clamps matter: a hand-edited
 * `app-state.json` must not be able to set a 1 ms scan interval or a 5000 px
 * rail.
 */
describe("rail and checkpoint preferences", () => {
  it("clamps the rail width to the supported range", () => {
    expect(sanitizePrefs({ rail: { width: 10 } }).rail.width).toBe(MIN_RAIL_WIDTH);
    expect(sanitizePrefs({ rail: { width: 99_999 } }).rail.width).toBe(MAX_RAIL_WIDTH);
    expect(sanitizePrefs({ rail: { width: Number.NaN } }).rail.width).toBe(DEFAULT_RAIL_WIDTH);
  });

  it("drops an unknown rail section id and keeps the known ones", () => {
    const rail = sanitizePrefs({
      rail: { sections: { git: false, madeUp: true, documents: false } },
    }).rail;
    expect(rail.sections.git).toBe(false);
    expect(rail.sections.documents).toBe(false);
    expect(rail.sections).not.toHaveProperty("madeUp");
  });

  it("merges one rail section without wiping the rest", () => {
    const current = sanitizePrefs({ rail: { open: true, width: 400 } });
    const next = mergePrefs(current, { rail: { sections: { history: false } } });
    expect(next.rail.width).toBe(400);
    expect(next.rail.open).toBe(true);
    expect(next.rail.sections.history).toBe(false);
    // The default `true` survives for every section the patch did not name.
    expect(next.rail.sections.changes).toBe(true);
  });

  it("clamps every checkpoint number the sanitizer owns", () => {
    const config = sanitizePrefs({
      checkpoints: {
        maxPerSession: 0,
        retentionDays: 0,
        scanIntervalMs: 1,
        maxFileBytes: 1,
        maxBytesPerProject: 1,
      },
    }).checkpoints;
    expect(config.maxPerSession).toBe(1);
    expect(config.retentionDays).toBe(1);
    expect(config.scanIntervalMs).toBe(MIN_SCAN_INTERVAL_MS);
    expect(config.maxFileBytes).toBe(1024 * 1024);
    expect(config.maxBytesPerProject).toBe(64 * 1024 * 1024);
  });

  it("keeps checkpoints enabled for an app-state.json written before the key existed", () => {
    // A missing key must not silently opt the user out (D14: on by default).
    expect(sanitizePrefs({ theme: "light" }).checkpoints.enabled).toBe(true);
  });

  it("preserves the other checkpoint values when only one is patched", () => {
    const current = sanitizePrefs({
      checkpoints: { retentionDays: 90, maxPerSession: 250, exclude: ["*.iso"] },
    });
    const next = mergePrefs(current, { checkpoints: { enabled: false } });
    expect(next.checkpoints).toMatchObject({
      enabled: false,
      retentionDays: 90,
      maxPerSession: 250,
      exclude: ["*.iso"],
    });
  });
});
