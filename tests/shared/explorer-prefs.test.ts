import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPLORER_PREFS,
  isExplorerSort,
  mergeExplorerPrefs,
  sanitizeExplorerPrefs,
} from "../../src/shared/explorer-prefs";

describe("sanitizeExplorerPrefs", () => {
  it("returns the defaults for non-objects", () => {
    expect(sanitizeExplorerPrefs(null)).toEqual(DEFAULT_EXPLORER_PREFS);
    expect(sanitizeExplorerPrefs("name")).toEqual(DEFAULT_EXPLORER_PREFS);
  });

  it("shows hidden and ignored entries unless explicitly disabled", () => {
    expect(sanitizeExplorerPrefs({}).showHidden).toBe(true);
    expect(sanitizeExplorerPrefs({}).showIgnored).toBe(true);
    expect(sanitizeExplorerPrefs({ showHidden: false }).showHidden).toBe(false);
    expect(sanitizeExplorerPrefs({ showIgnored: false }).showIgnored).toBe(false);
    expect(sanitizeExplorerPrefs({ showHidden: "false" }).showHidden).toBe(true);
  });

  it("accepts only known sort orders", () => {
    expect(sanitizeExplorerPrefs({ sort: "modified" }).sort).toBe("modified");
    expect(sanitizeExplorerPrefs({ sort: "size" }).sort).toBe("name");
    expect(isExplorerSort("type")).toBe(true);
    expect(isExplorerSort("size")).toBe(false);
  });
});

describe("mergeExplorerPrefs", () => {
  it("applies a partial patch and keeps untouched keys", () => {
    const current = { ...DEFAULT_EXPLORER_PREFS, showHidden: false, sort: "type" as const };
    const merged = mergeExplorerPrefs(current, { showIgnored: false });
    expect(merged).toEqual({ showHidden: false, showIgnored: false, sort: "type" });
  });

  it("ignores unknown patch keys", () => {
    expect(mergeExplorerPrefs(DEFAULT_EXPLORER_PREFS, { injected: true })).toEqual(
      DEFAULT_EXPLORER_PREFS,
    );
  });
});
