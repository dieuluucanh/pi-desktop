import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * `applyTabs` identity preservation (2026-11-03 plan step 5).
 *
 * Main sends a deep copy of the whole tab table on every publish, including
 * every session state frame. Reusing an unchanged record is what stops an open
 * editor from re-reading its file when a background session produces a message.
 * A real change must still replace the record.
 */

function tab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "session-1",
    kind: "session",
    cwd: "C:/work/app",
    title: "app",
    sessionFile: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
    ...overrides,
  };
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    tabs: [],
    activeTabId: null,
    webTabStates: {},
    webNavigationPrompt: null,
  });
});

describe("applyTabs", () => {
  it("reuses unchanged records and skips the state write entirely", () => {
    const first = tab();
    useAppStore.getState().applyTabs({ tabs: [first], activeTabId: first.id });
    const before = useAppStore.getState().tabs;
    const subscriber = vi.fn();
    const unsubscribe = useAppStore.subscribe(subscriber);

    // A fresh copy with the same fields, exactly what main sends on a state
    // frame that only touched another tab's transcript.
    useAppStore.getState().applyTabs({ tabs: [{ ...first }], activeTabId: first.id });

    expect(useAppStore.getState().tabs).toBe(before);
    expect(subscriber).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("replaces a record when a rendered field changes", () => {
    const first = tab();
    useAppStore.getState().applyTabs({ tabs: [first], activeTabId: first.id });

    useAppStore.getState().applyTabs({
      tabs: [{ ...first, status: "running" }],
      activeTabId: first.id,
    });

    const next = useAppStore.getState().tabs[0]!;
    expect(next).not.toBe(first);
    expect(next.status).toBe("running");
  });

  it("updates the selection without rebuilding the records", () => {
    const first = tab();
    const second = tab({ id: "session-2", lastActiveAt: 2 });
    useAppStore.getState().applyTabs({ tabs: [first, second], activeTabId: first.id });

    useAppStore.getState().applyTabs({
      tabs: [{ ...first }, { ...second }],
      activeTabId: second.id,
    });

    const state = useAppStore.getState();
    expect(state.activeTabId).toBe(second.id);
    expect(state.tabs[0]).toBe(first);
    expect(state.tabs[1]).toBe(second);
  });

  it("keeps the envelope order while reusing each record by id", () => {
    const first = tab();
    const second = tab({ id: "session-2", lastActiveAt: 2 });
    useAppStore.getState().applyTabs({ tabs: [first, second], activeTabId: first.id });

    useAppStore
      .getState()
      .applyTabs({ tabs: [{ ...second }, { ...first }], activeTabId: first.id });

    const state = useAppStore.getState();
    expect(state.tabs[0]).toBe(second);
    expect(state.tabs[1]).toBe(first);
  });

  it("clears a navigation prompt whose tab is gone", () => {
    const web = tab({ id: "web-1", kind: "web", url: "https://example.com/review" });
    useAppStore.getState().applyTabs({ tabs: [web], activeTabId: web.id });
    useAppStore.setState({
      webNavigationPrompt: {
        tabId: web.id,
        url: "https://example.com/elsewhere",
        disposition: "link",
        at: 1,
      },
    });

    useAppStore.getState().applyTabs({ tabs: [], activeTabId: null });

    expect(useAppStore.getState().webNavigationPrompt).toBeNull();
  });
});
