import { describe, expect, it } from "vitest";

import { createTuiFocusRegistry } from "../../src/main/tui-focus";

/**
 * The per-window TUI focus registry (2026-11-18 questionnaire paste plan).
 *
 * Menu and context-menu Paste resolve "is an extension frame focused?" through
 * this map, so a stale entry would paste into the wrong tab and a missing one
 * would silently no-op.
 */

describe("createTuiFocusRegistry", () => {
  it("remembers and replaces the focused tab per window", () => {
    const registry = createTuiFocusRegistry();

    expect(registry.tabId(1)).toBeNull();
    registry.set(1, "tab-a");
    expect(registry.tabId(1)).toBe("tab-a");
    registry.set(1, "tab-b");
    expect(registry.tabId(1)).toBe("tab-b");
  });

  it("clears a window without touching the others", () => {
    const registry = createTuiFocusRegistry();
    registry.set(1, "tab-a");
    registry.set(2, "tab-b");

    registry.set(1, null);
    expect(registry.tabId(1)).toBeNull();
    expect(registry.tabId(2)).toBe("tab-b");

    registry.clear(2);
    expect(registry.tabId(2)).toBeNull();
  });

  it("treats an unknown or closed window as unfocused", () => {
    const registry = createTuiFocusRegistry();
    expect(registry.tabId(99)).toBeNull();
    registry.clear(99);
    expect(registry.tabId(99)).toBeNull();
  });
});
