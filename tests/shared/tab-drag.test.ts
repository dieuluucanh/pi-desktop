import { describe, expect, it } from "vitest";

import {
  MAX_TAB_DRAG_ID,
  TAB_DRAG_MIME,
  TAB_DRAG_VERSION,
  parseTabDrag,
  serializeTabDrag,
} from "../../src/shared/tab-drag";

/**
 * The tab drag payload (2026-11-03 grid plan step 2).
 *
 * A drag is external input: the parser must never throw, never repair a bad id
 * and never accept a payload without the typed MIME's own version marker.
 */

describe("TAB_DRAG_MIME", () => {
  it("is a custom, lowercase MIME distinct from the workspace drag", () => {
    expect(TAB_DRAG_MIME).toBe("application/x-pi-tab");
    // A pane drop and a composer drop must never be the same gesture.
    expect(TAB_DRAG_MIME).not.toBe("application/x-pi-workspace-path");
    expect(TAB_DRAG_MIME).toBe(TAB_DRAG_MIME.toLowerCase());
  });
});

describe("serializeTabDrag", () => {
  it("writes the versioned JSON shape", () => {
    expect(serializeTabDrag({ version: TAB_DRAG_VERSION, tabId: "tab-1" })).toBe(
      '{"version":1,"tabId":"tab-1"}',
    );
  });
});

describe("parseTabDrag", () => {
  it("round-trips a payload", () => {
    const raw = serializeTabDrag({ version: TAB_DRAG_VERSION, tabId: "tab-1" });
    expect(parseTabDrag(raw)).toEqual({ version: TAB_DRAG_VERSION, tabId: "tab-1" });
  });

  it("returns null for a missing or empty payload", () => {
    for (const value of [undefined, null, "", "   "]) {
      expect(parseTabDrag(value)).toBeNull();
    }
  });

  it("returns null for malformed JSON", () => {
    for (const value of ["{", "not json", '{"version":1,"tabId":']) {
      expect(parseTabDrag(value)).toBeNull();
    }
  });

  it("returns null for a non-object payload", () => {
    for (const value of ["null", "42", '"tab-1"', "[]", '["tab-1"]']) {
      expect(parseTabDrag(value)).toBeNull();
    }
  });

  it("rejects any version but the current one", () => {
    expect(parseTabDrag('{"version":2,"tabId":"tab-1"}')).toBeNull();
    expect(parseTabDrag('{"tabId":"tab-1"}')).toBeNull();
    expect(parseTabDrag('{"version":"1","tabId":"tab-1"}')).toBeNull();
  });

  it("rejects a missing, empty or non-string tab id", () => {
    expect(parseTabDrag('{"version":1}')).toBeNull();
    expect(parseTabDrag('{"version":1,"tabId":""}')).toBeNull();
    expect(parseTabDrag('{"version":1,"tabId":"   "}')).toBeNull();
    expect(parseTabDrag('{"version":1,"tabId":42}')).toBeNull();
    expect(parseTabDrag('{"version":1,"tabId":null}')).toBeNull();
  });

  it("rejects an oversized tab id", () => {
    const raw = JSON.stringify({
      version: TAB_DRAG_VERSION,
      tabId: "x".repeat(MAX_TAB_DRAG_ID + 1),
    });
    expect(parseTabDrag(raw)).toBeNull();
    const atLimit = JSON.stringify({
      version: TAB_DRAG_VERSION,
      tabId: "x".repeat(MAX_TAB_DRAG_ID),
    });
    expect(parseTabDrag(atLimit)?.tabId).toHaveLength(MAX_TAB_DRAG_ID);
  });

  it("trims surrounding whitespace from the id", () => {
    expect(parseTabDrag('{"version":1,"tabId":"  tab-1  "}')?.tabId).toBe("tab-1");
  });

  it("ignores unknown extra keys", () => {
    expect(parseTabDrag('{"version":1,"tabId":"tab-1","pane":2}')).toEqual({
      version: TAB_DRAG_VERSION,
      tabId: "tab-1",
    });
  });
});
