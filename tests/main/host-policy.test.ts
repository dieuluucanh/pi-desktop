import { describe, expect, it } from "vitest";
import { keepHostAlive } from "../../src/main/host-policy";
import { CONTROL_TAB_ID } from "../../src/shared/session-ipc";

/**
 * The idle reaper runs by default at 15 minutes, so the three protected hosts
 * must be unambiguous: the control host, the visible tab and the session that
 * owns the Office bridge.
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
});
