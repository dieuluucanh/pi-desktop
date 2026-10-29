import { describe, expect, it } from "vitest";
import {
  DEFAULT_RAIL_PREFS,
  MAX_RAIL_WIDTH,
  MIN_RAIL_WIDTH,
  RAIL_SECTION_IDS,
  anyRailSectionExpanded,
  clampRailWidth,
  isRailSectionId,
  mergeRailPrefs,
  sanitizeRailPrefs,
} from "../../src/shared/rail";
import { DEFAULT_PREFS, mergePrefs, sanitizePrefs } from "../../src/shared/prefs";

/**
 * The right rail's preference model (git-checkpoint plan step 10).
 *
 * The rail is the one nested preference, so its sanitizer and its merge are the
 * two places a bad document could widen the window, hide a section forever, or
 * let a `{ open: true }` patch silently discard the width. All three are pinned
 * here, together with the migration of an `app-state.json` written before the
 * rail existed.
 */

describe("clampRailWidth", () => {
  it("clamps into the supported range", () => {
    expect(clampRailWidth(0)).toBe(MIN_RAIL_WIDTH);
    expect(clampRailWidth(10_000)).toBe(MAX_RAIL_WIDTH);
    expect(clampRailWidth(320)).toBe(320);
    expect(clampRailWidth(400.6)).toBe(401);
  });

  it("falls back to the default for a non-number", () => {
    expect(clampRailWidth(undefined)).toBe(DEFAULT_RAIL_PREFS.width);
    expect(clampRailWidth("400")).toBe(DEFAULT_RAIL_PREFS.width);
    expect(clampRailWidth(Number.NaN)).toBe(DEFAULT_RAIL_PREFS.width);
    expect(clampRailWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RAIL_PREFS.width);
  });
});

describe("isRailSectionId", () => {
  it("accepts exactly the declared ids", () => {
    for (const id of RAIL_SECTION_IDS) expect(isRailSectionId(id)).toBe(true);
    expect(isRailSectionId("git ")).toBe(false);
    expect(isRailSectionId("terminal")).toBe(false);
    expect(isRailSectionId(undefined)).toBe(false);
  });
});

describe("sanitizeRailPrefs", () => {
  it("returns the defaults for nothing at all", () => {
    expect(sanitizeRailPrefs(undefined)).toEqual(DEFAULT_RAIL_PREFS);
    expect(sanitizeRailPrefs(null)).toEqual(DEFAULT_RAIL_PREFS);
    expect(sanitizeRailPrefs("nope")).toEqual(DEFAULT_RAIL_PREFS);
    expect(sanitizeRailPrefs([])).toEqual(DEFAULT_RAIL_PREFS);
  });

  it("keeps a valid document", () => {
    const prefs = sanitizeRailPrefs({
      open: true,
      width: 420,
      sections: { git: false, changes: true, history: true, checkpoints: false, documents: true },
    });
    expect(prefs).toEqual({
      open: true,
      width: 420,
      sections: { git: false, changes: true, history: true, checkpoints: false, documents: true },
    });
  });

  it("clamps a hostile width", () => {
    expect(sanitizeRailPrefs({ width: -5 }).width).toBe(MIN_RAIL_WIDTH);
    expect(sanitizeRailPrefs({ width: 99_999 }).width).toBe(MAX_RAIL_WIDTH);
  });

  it("drops unknown sections and keys instead of carrying them forward", () => {
    const prefs = sanitizeRailPrefs({
      sections: { git: false, terminal: true },
      evil: "payload",
    });
    expect(prefs.sections).toEqual({ ...DEFAULT_RAIL_PREFS.sections, git: false });
    expect("evil" in prefs).toBe(false);
  });

  it("defaults a non-boolean section to its default rather than false", () => {
    const prefs = sanitizeRailPrefs({ sections: { git: "yes", checkpoints: 0 } });
    expect(prefs.sections.git).toBe(DEFAULT_RAIL_PREFS.sections.git);
    expect(prefs.sections.checkpoints).toBe(DEFAULT_RAIL_PREFS.sections.checkpoints);
  });

  it("returns a fresh object each time (no shared default mutation)", () => {
    const first = sanitizeRailPrefs(undefined);
    first.sections.git = false;
    expect(DEFAULT_RAIL_PREFS.sections.git).toBe(true);
    expect(sanitizeRailPrefs(undefined).sections.git).toBe(true);
  });
});

describe("mergeRailPrefs", () => {
  const current = {
    open: true,
    width: 400,
    sections: { git: true, changes: false, history: true, checkpoints: true, documents: false },
  };

  it("merges sections one level deep", () => {
    const next = mergeRailPrefs(current, { sections: { git: false } });
    expect(next.sections).toEqual({ ...current.sections, git: false });
    expect(next.width).toBe(400);
    expect(next.open).toBe(true);
  });

  it("keeps untouched fields when only `open` changes", () => {
    const next = mergeRailPrefs(current, { open: false });
    expect(next).toEqual({ ...current, open: false });
  });

  it("ignores a non-object patch", () => {
    expect(mergeRailPrefs(current, null)).toEqual(current);
    expect(mergeRailPrefs(current, "x")).toEqual(current);
  });
});

describe("rail inside the preference patch", () => {
  it("does not let a nested patch discard the width", () => {
    const current = {
      ...DEFAULT_PREFS,
      rail: { open: false, width: 480, sections: { ...DEFAULT_RAIL_PREFS.sections } },
    };
    const next = mergePrefs(current, { rail: { open: true } });
    expect(next.rail.open).toBe(true);
    // The spread-only merge would have reset this to the default.
    expect(next.rail.width).toBe(480);
  });

  it("merges a single section without collapsing the others", () => {
    const current = {
      ...DEFAULT_PREFS,
      rail: {
        open: true,
        width: 320,
        sections: { git: true, changes: true, history: true, checkpoints: true, documents: true },
      },
    };
    const next = mergePrefs(current, { rail: { sections: { checkpoints: false } } });
    expect(next.rail.sections).toEqual({
      git: true,
      changes: true,
      history: true,
      checkpoints: false,
      documents: true,
    });
  });

  it("migrates an app-state.json written before the rail existed", () => {
    // A pre-rail document: no `rail` key at all.
    const prefs = sanitizePrefs({
      theme: "light",
      sidebarWidth: 300,
      showExpandedPrompts: true,
    });
    expect(prefs.theme).toBe("light");
    expect(prefs.sidebarWidth).toBe(300);
    expect(prefs.rail).toEqual(DEFAULT_RAIL_PREFS);
  });

  it("survives a corrupted rail value", () => {
    expect(sanitizePrefs({ rail: "broken" }).rail).toEqual(DEFAULT_RAIL_PREFS);
    expect(sanitizePrefs({ rail: { sections: 42 } }).rail.sections).toEqual(
      DEFAULT_RAIL_PREFS.sections,
    );
  });
});

describe("anyRailSectionExpanded", () => {
  it("reports whether anything is open", () => {
    expect(anyRailSectionExpanded(DEFAULT_RAIL_PREFS)).toBe(true);
    expect(
      anyRailSectionExpanded({
        open: true,
        width: 320,
        sections: {
          git: false,
          changes: false,
          history: false,
          checkpoints: false,
          documents: false,
        },
      }),
    ).toBe(false);
  });
});
