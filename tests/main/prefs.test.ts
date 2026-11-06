import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  MAX_DRAFT_LENGTH,
  MAX_DRAFT_TABS,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
  mergePrefs,
  sanitizeDrafts,
  sanitizePrefs,
} from "../../src/shared/prefs";
import { hashPromptText } from "../../src/shared/prompt-origin";
import { MIN_SCAN_INTERVAL_MS } from "../../src/shared/checkpoints";
import { DEFAULT_RAIL_WIDTH, MAX_RAIL_WIDTH, MIN_RAIL_WIDTH } from "../../src/shared/rail";
import { muteRuleFor } from "../../src/shared/notifications";

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
        "dialogs",
        "drafts",
        "editor",
        "explorer",
        "followSystemTheme",
        "grid",
        "notifications",
        "onboardingCompletedAt",
        "privacyAcknowledged",
        "profileMode",
        "promptOrigins",
        "rail",
        "showExpandedPrompts",
        "sidebarCollapsed",
        "sidebarWidth",
        "telemetryEnabled",
        "terminal",
        "theme",
        "themeColors",
        "updates",
        "zoomFactor",
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

  /**
   * The session view grid (2026-11-03 plan step 3).
   *
   * `prefs.grid` is the one source of truth for the layout and the pane
   * assignments, so the sanitizer must be total (a hand-edited app-state.json can
   * say anything) and the merge must never let a `{ layout }` patch drop the
   * panes it did not mention.
   */
  describe("grid", () => {
    it("supplies the single-pane default for an older app-state.json", () => {
      const prefs = sanitizePrefs({ theme: "light" });
      expect(prefs.grid).toEqual({
        layout: "single",
        lastMultiLayout: "two",
        panes: [null, null, null, null],
      });
    });

    it("falls back to single for an unknown layout without discarding slots", () => {
      expect(sanitizePrefs({ grid: { layout: "nine", panes: ["a", "b"] } }).grid).toEqual({
        layout: "single",
        lastMultiLayout: "two",
        panes: ["a", "b", null, null],
      });
    });

    it("pads the fixed four-slot pane array", () => {
      expect(sanitizePrefs({ grid: { layout: "four", panes: ["a"] } }).grid.panes).toEqual([
        "a",
        null,
        null,
        null,
      ]);
      expect(
        sanitizePrefs({ grid: { layout: "two", panes: ["a", "b", "c", "d"] } }).grid.panes,
      ).toEqual(["a", "b", "c", "d"]);
    });

    it("drops a duplicate pane assignment and a malformed slot", () => {
      expect(
        sanitizePrefs({ grid: { layout: "three-left", panes: ["a", "a", 42] } }).grid.panes,
      ).toEqual(["a", null, null, null]);
    });

    it("accepts a garbage grid block without throwing", () => {
      for (const value of [null, 42, "four", ["a"], { panes: "nope" }]) {
        expect(sanitizePrefs({ grid: value }).grid).toEqual({
          layout: "single",
          lastMultiLayout: "two",
          panes: [null, null, null, null],
        });
      }
    });

    it("keeps the assignments when a patch only names the layout", () => {
      const current = sanitizePrefs({ grid: { layout: "four", panes: ["a", "b", "c", "d"] } });
      const next = mergePrefs(current, { grid: { layout: "two" } });
      expect(next.grid).toEqual({
        layout: "two",
        lastMultiLayout: "two",
        panes: ["a", "b", "c", "d"],
      });
    });

    it("keeps the layout when a patch only names the panes", () => {
      const current = sanitizePrefs({ grid: { layout: "four", panes: [] } });
      const next = mergePrefs(current, { grid: { panes: ["x", null, "y"] } });
      expect(next.grid).toEqual({
        layout: "four",
        lastMultiLayout: "four",
        panes: ["x", null, "y", null],
      });
    });

    it("leaves the block alone when the patch does not mention it", () => {
      const current = sanitizePrefs({ grid: { layout: "three-right", panes: ["a", "b", "c"] } });
      expect(mergePrefs(current, { theme: "light" }).grid).toEqual(current.grid);
    });
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

  it("sanitizes the display zoom to a supported level", () => {
    expect(sanitizePrefs({}).zoomFactor).toBe(1);
    expect(sanitizePrefs({ zoomFactor: 1.25 }).zoomFactor).toBe(1.25);
    expect(sanitizePrefs({ zoomFactor: 99 }).zoomFactor).toBe(3);
    expect(sanitizePrefs({ zoomFactor: 0.01 }).zoomFactor).toBe(0.5);
    expect(sanitizePrefs({ zoomFactor: "big" }).zoomFactor).toBe(1);
  });

  it("migrates theme: system to follow-system and keeps an explicit boolean", () => {
    expect(sanitizePrefs({}).followSystemTheme).toBe(false);
    expect(sanitizePrefs({ theme: "system" }).followSystemTheme).toBe(true);
    expect(sanitizePrefs({ theme: "system", followSystemTheme: false }).followSystemTheme).toBe(
      false,
    );
    expect(sanitizePrefs({ theme: "light" }).followSystemTheme).toBe(false);
    expect(sanitizePrefs({ followSystemTheme: "yes" }).followSystemTheme).toBe(false);
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
      sidebarCollapsed: "yes",
      sidebarWidth: "wide",
    });
    expect(result).toEqual(DEFAULT_PREFS);
  });

  it("clamps the sidebar width to the supported range", () => {
    expect(clampSidebarWidth(10)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(9_999)).toBe(MAX_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(300.6)).toBe(301);
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_PREFS.sidebarWidth);
    expect(sanitizePrefs({ sidebarWidth: 10 }).sidebarWidth).toBe(MIN_SIDEBAR_WIDTH);
    expect(sanitizePrefs({ sidebarWidth: 9_999 }).sidebarWidth).toBe(MAX_SIDEBAR_WIDTH);
    expect(sanitizePrefs({ sidebarWidth: Number.NaN }).sidebarWidth).toBe(
      DEFAULT_PREFS.sidebarWidth,
    );
    expect(sanitizePrefs({ sidebarWidth: 300.6 }).sidebarWidth).toBe(301);
  });

  it("sanitizes per-theme colour overrides", () => {
    expect(sanitizePrefs({}).themeColors).toEqual({});
    const result = sanitizePrefs({
      themeColors: {
        dark: { line: "#AABBCC", accent: "#123456", info: "#ABCDEF", nope: "#ffffff", bad: "red" },
        light: { surface: "#fff" },
        "": { line: "#000000" },
        empty: { line: "bogus" },
      },
    });
    expect(result.themeColors).toEqual({
      dark: { line: "#aabbcc", accent: "#123456", info: "#abcdef" },
    });
  });

  it("bounds the number of themed override maps", () => {
    const themeColors = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`theme-${index}`, { line: "#112233" }]),
    );
    expect(Object.keys(sanitizePrefs({ themeColors }).themeColors)).toHaveLength(32);
  });

  it("defaults automatic update checks on and accepts a per-version dismissal", () => {
    expect(sanitizePrefs({}).updates).toEqual({ autoCheck: true, dismissedVersion: null });
    expect(sanitizePrefs({ updates: { autoCheck: false } }).updates).toEqual({
      autoCheck: false,
      dismissedVersion: null,
    });
    expect(
      sanitizePrefs({ updates: { autoCheck: "yes", dismissedVersion: " 0.4.0 " } }).updates,
    ).toEqual({ autoCheck: true, dismissedVersion: "0.4.0" });
    expect(
      sanitizePrefs({ updates: { dismissedVersion: "" } }).updates.dismissedVersion,
    ).toBeNull();
    expect(
      sanitizePrefs({ updates: { dismissedVersion: "x".repeat(500) } }).updates.dismissedVersion
        ?.length,
    ).toBe(201);
  });

  it("accepts every documented theme", () => {
    for (const theme of ["dark", "light", "system"] as const) {
      expect(sanitizePrefs({ theme }).theme).toBe(theme);
    }
  });
});

describe("mergePrefs", () => {
  it("applies a partial patch over the current values", () => {
    const merged = mergePrefs({ ...DEFAULT_PREFS, theme: "light" }, { theme: "system" });
    expect(merged).toEqual({ ...DEFAULT_PREFS, theme: "system" });
  });

  it("cannot be used to inject an unknown key", () => {
    const merged = mergePrefs(DEFAULT_PREFS, { injected: "x", theme: "light" });
    expect(merged).not.toHaveProperty("injected");
    expect(merged.theme).toBe("light");
  });

  it("survives a non-object patch", () => {
    expect(mergePrefs(DEFAULT_PREFS, null)).toEqual(DEFAULT_PREFS);
  });

  it("preserves the update prefs unless the patch replaces a field", () => {
    const current = sanitizePrefs({
      updates: { autoCheck: true, dismissedVersion: "0.4.0" },
    });
    // A patch that only turns auto-check off must keep the dismissal.
    const merged = mergePrefs(current, { updates: { autoCheck: false } });
    expect(merged.updates).toEqual({ autoCheck: false, dismissedVersion: "0.4.0" });
    // An unrelated patch must not touch the updater prefs at all.
    expect(mergePrefs(current, { theme: "light" }).updates).toEqual(current.updates);
    expect(mergePrefs(current, { updates: { dismissedVersion: null } }).updates).toEqual({
      autoCheck: true,
      dismissedVersion: null,
    });
  });

  it("preserves the notification mutes unless the patch replaces the list", () => {
    const rule = muteRuleFor({ message: "Installed", type: "warning" }, "exact", 1);
    const current = sanitizePrefs({ notifications: { muted: [rule] } });
    expect(current.notifications.muted).toHaveLength(1);

    // A theme patch must not wipe the mute list.
    const themed = mergePrefs(current, { theme: "light" });
    expect(themed.notifications.muted).toHaveLength(1);

    // An empty notifications patch also leaves the list alone.
    expect(mergePrefs(current, { notifications: {} }).notifications.muted).toHaveLength(1);

    // Supplying `muted` replaces it (the store always sends the whole list).
    expect(mergePrefs(current, { notifications: { muted: [] } }).notifications.muted).toHaveLength(
      0,
    );
  });
});

describe("notification preferences", () => {
  it("defaults to no muted rules and uses a fresh array", () => {
    expect(sanitizePrefs({}).notifications).toEqual({ muted: [] });
    const prefs = sanitizePrefs({});
    prefs.notifications.muted.push(muteRuleFor({ message: "x", type: "info" }, "exact"));
    expect(DEFAULT_PREFS.notifications.muted).toHaveLength(0);
    expect(sanitizePrefs({}).notifications.muted).toHaveLength(0);
  });

  it("keeps a valid rule and drops malformed ones", () => {
    const rule = muteRuleFor({ message: "Installed workflow", type: "info" }, "exact", 7);
    const result = sanitizePrefs({
      notifications: {
        muted: [rule, { scope: "exact", type: "warning" }, { scope: "nope", type: "info" }],
      },
    });
    expect(result.notifications.muted).toHaveLength(1);
    expect(result.notifications.muted[0]).toMatchObject({
      type: "info",
      value: "installed workflow",
      sample: "Installed workflow",
      createdAt: 7,
    });
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

  it("drops an unknown strip id and keeps the known ones", () => {
    const rail = sanitizePrefs({
      rail: { order: ["documents", "madeUp", "checkpoints", "documents"] },
    }).rail;
    expect(rail.order).toEqual(["documents", "checkpoints", "source-control"]);
    expect(rail.order).not.toContain("madeUp");
  });

  it("replaces the strip order instead of merging it", () => {
    const current = sanitizePrefs({ rail: { open: true, width: 400 } });
    const next = mergePrefs(current, { rail: { order: ["checkpoints"] } });
    expect(next.rail.width).toBe(400);
    expect(next.rail.open).toBe(true);
    // A replace, then completed by the sanitizer — never a concatenation, which
    // would duplicate `checkpoints`.
    expect(next.rail.order).toEqual(["checkpoints", "source-control", "documents"]);
  });

  it("keeps a valid active menu and defaults an unknown one", () => {
    expect(sanitizePrefs({ rail: { activeMenu: "documents" } }).rail.activeMenu).toBe("documents");
    expect(sanitizePrefs({ rail: { activeMenu: "git" } }).rail.activeMenu).toBe("source-control");
  });

  it("loads a pre-strip document without a version bump", () => {
    const rail = sanitizePrefs({
      rail: {
        open: true,
        width: 400,
        sections: { git: false, changes: false, history: true, checkpoints: true },
      },
    }).rail;
    expect(rail).toEqual({
      open: true,
      activeMenu: "source-control",
      width: 400,
      order: ["source-control", "checkpoints", "documents"],
      // The stale `sections` key is dropped and the two newer records take their
      // defaults, so a document written before the three-block layout loads.
      split: { top: 0.34, middle: 0.4 },
      collapsed: { staged: false, changed: false, stashes: true },
    });
  });

  it("does not share its order array with the module default", () => {
    const rail = sanitizePrefs({}).rail;
    rail.order.push("documents");
    expect(DEFAULT_PREFS.rail.order).toEqual(["source-control", "checkpoints", "documents"]);
    expect(sanitizePrefs({}).rail.order).toEqual(["source-control", "checkpoints", "documents"]);
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
