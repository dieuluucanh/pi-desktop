import { describe, expect, it } from "vitest";
import { keepHostAlive } from "../../src/main/host-policy";
import { CONTROL_TAB_ID } from "../../src/shared/session-ipc";

/**
 * The idle reaper runs by default at 15 minutes, so the protected hosts must be
 * unambiguous: the control host, the focused tab, every tab a grid pane shows
 * (2026-11-03 plan) and the session that owns the Office bridge.
 */

describe("keepHostAlive", () => {
  it("always protects the control host", () => {
    expect(
      keepHostAlive(CONTROL_TAB_ID, { activeSessionId: null, bridgeOwnerSessionId: null }),
    ).toBe(true);
  });

  it("protects the active tab and the bridge owner", () => {
    const state = { activeSessionId: "tab-active", bridgeOwnerSessionId: "tab-bridge" };
    expect(keepHostAlive("tab-active", state)).toBe(true);
    expect(keepHostAlive("tab-bridge", state)).toBe(true);
  });

  it("lets an ordinary background session sleep", () => {
    const state = { activeSessionId: "tab-active", bridgeOwnerSessionId: "tab-bridge" };
    expect(keepHostAlive("tab-idle", state)).toBe(false);
    expect(keepHostAlive("tab-idle", { activeSessionId: null, bridgeOwnerSessionId: null })).toBe(
      false,
    );
  });

  it("protects a pane that is visible but not focused", () => {
    const state = {
      activeSessionId: "tab-active",
      visibleSessionIds: new Set(["tab-active", "tab-pane-2", "tab-pane-3"]),
      bridgeOwnerSessionId: null,
    };
    expect(keepHostAlive("tab-pane-2", state)).toBe(true);
    expect(keepHostAlive("tab-pane-3", state)).toBe(true);
    // A tab that is neither focused nor on screen still sleeps.
    expect(keepHostAlive("tab-behind", state)).toBe(false);
  });

  it("accepts the visible set as an array as well as a Set", () => {
    const state = {
      activeSessionId: null,
      visibleSessionIds: ["tab-a", "tab-b"] as const,
      bridgeOwnerSessionId: null,
    };
    expect(keepHostAlive("tab-a", state)).toBe(true);
    expect(keepHostAlive("tab-c", state)).toBe(false);
  });

  it("treats an empty or missing visible set as nothing visible", () => {
    expect(
      keepHostAlive("tab-x", {
        activeSessionId: null,
        visibleSessionIds: [],
        bridgeOwnerSessionId: null,
      }),
    ).toBe(false);
    expect(
      keepHostAlive("tab-x", {
        activeSessionId: null,
        visibleSessionIds: new Set(),
        bridgeOwnerSessionId: null,
      }),
    ).toBe(false);
  });
});
