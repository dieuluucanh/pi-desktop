import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { EditorTabStrip } from "../../src/renderer/src/layout/EditorTabStrip";
import { SessionTabStrip } from "../../src/renderer/src/layout/SessionTabStrip";
import {
  clampScrollLeft,
  revealScrollLeft,
  wheelScrollDelta,
} from "../../src/renderer/src/layout/tab-scroll";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * Tab-strip overflow (2026-11-02 plan step 6).
 *
 * The wheel must scroll either bar horizontally like VS Code, ctrl/cmd+wheel
 * must remain pinch-zoom, a strip that fits must not swallow the wheel, and a
 * selection change must reveal the active tab without overwriting a manual
 * scroll position when only the tab list is republished.
 */

const WORK = "C:\\work\\pi-desktop";

function tab(id: string, title: string): TabRecord {
  return {
    id,
    kind: "session",
    cwd: WORK,
    title,
    sessionFile: `${WORK}\\sessions\\${id}.jsonl`,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
  };
}

function editor(id: string, title: string): TabRecord {
  return { ...tab(id, title), kind: "editor", filePath: title, sessionFile: null };
}

function defineBox(element: HTMLElement, box: { scrollWidth: number; clientWidth: number }): void {
  Object.defineProperty(element, "scrollWidth", { value: box.scrollWidth, configurable: true });
  Object.defineProperty(element, "clientWidth", { value: box.clientWidth, configurable: true });
}

function defineChip(element: HTMLElement, left: number, width: number): void {
  Object.defineProperty(element, "offsetLeft", { value: left, configurable: true });
  Object.defineProperty(element, "offsetWidth", { value: width, configurable: true });
}

function wheel(target: HTMLElement, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    view: "session",
    project: { path: WORK, name: "pi-desktop" },
    prefs: { ...DEFAULT_PREFS },
    tabs: [tab("tab-1", "first"), tab("tab-2", "second")],
    activeTabId: "tab-1",
  });
});

describe("tab-scroll math", () => {
  it("normalizes wheel deltas by dominant axis and delta mode", () => {
    expect(wheelScrollDelta({ deltaX: 0, deltaY: 120, deltaMode: 0 }, 300)).toBe(120);
    expect(wheelScrollDelta({ deltaX: 50, deltaY: 5, deltaMode: 0 }, 300)).toBe(50);
    expect(wheelScrollDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 300)).toBe(48);
    expect(wheelScrollDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 300)).toBe(300);
  });

  it("ignores pinch-zoom and empty deltas", () => {
    expect(wheelScrollDelta({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: true }, 300)).toBe(
      null,
    );
    expect(wheelScrollDelta({ deltaX: 0, deltaY: 120, deltaMode: 0, metaKey: true }, 300)).toBe(
      null,
    );
    expect(wheelScrollDelta({ deltaX: 0, deltaY: 0, deltaMode: 0 }, 300)).toBe(null);
  });

  it("reveals with the least movement and clamps to the scroll range", () => {
    const viewport = { scrollLeft: 100, clientWidth: 300, scrollWidth: 800 };
    // Already visible: unchanged.
    expect(revealScrollLeft(viewport, { left: 150, width: 50 })).toBe(100);
    // Left of the viewport: align start.
    expect(revealScrollLeft(viewport, { left: 20, width: 60 })).toBe(20);
    // Right of the viewport: align end.
    expect(revealScrollLeft(viewport, { left: 500, width: 100 })).toBe(300);
    // Never past the end.
    expect(revealScrollLeft(viewport, { left: 790, width: 100 })).toBe(500);
    // A strip that fits stays at zero.
    expect(
      revealScrollLeft(
        { scrollLeft: 0, clientWidth: 300, scrollWidth: 300 },
        { left: 20, width: 60 },
      ),
    ).toBe(0);
  });

  it("clamps negative and oversized values", () => {
    expect(clampScrollLeft(-5, 800, 300)).toBe(0);
    expect(clampScrollLeft(900, 800, 300)).toBe(500);
    expect(clampScrollLeft(42, 800, 300)).toBe(42);
  });
});

describe("tab-strip wheel", () => {
  it("scrolls horizontally with a vertical wheel", () => {
    render(<SessionTabStrip />);
    const list = screen.getByRole("tablist", { name: "Session tabs" });
    defineBox(list, { scrollWidth: 600, clientWidth: 300 });

    const event = wheel(list, { deltaY: 120 });

    expect(event.defaultPrevented).toBe(true);
    expect(list.scrollLeft).toBe(120);
  });

  it("does not claim the wheel when the tabs fit", () => {
    render(<SessionTabStrip />);
    const list = screen.getByRole("tablist", { name: "Session tabs" });
    defineBox(list, { scrollWidth: 300, clientWidth: 300 });

    const event = wheel(list, { deltaY: 120 });

    expect(event.defaultPrevented).toBe(false);
    expect(list.scrollLeft).toBe(0);
  });

  it("leaves ctrl+wheel to pinch-zoom", () => {
    render(<SessionTabStrip />);
    const list = screen.getByRole("tablist", { name: "Session tabs" });
    defineBox(list, { scrollWidth: 600, clientWidth: 300 });

    const event = wheel(list, { deltaY: 120, ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(list.scrollLeft).toBe(0);
  });

  it("uses a trackpad's horizontal delta", () => {
    render(<SessionTabStrip />);
    const list = screen.getByRole("tablist", { name: "Session tabs" });
    defineBox(list, { scrollWidth: 600, clientWidth: 300 });

    wheel(list, { deltaX: 50, deltaY: 5 });

    expect(list.scrollLeft).toBe(50);
  });

  it("applies the same behaviour to the editor strip", () => {
    useAppStore.setState({
      tabs: [tab("tab-1", "first"), editor("editor-1", "a.ts"), editor("editor-2", "b.ts")],
      activeTabId: "editor-1",
    });
    render(
      <>
        <SessionTabStrip />
        <EditorTabStrip />
      </>,
    );
    const editorList = screen.getByRole("tablist", { name: "Editor tabs" });
    defineBox(editorList, { scrollWidth: 600, clientWidth: 300 });

    wheel(editorList, { deltaY: 90 });

    expect(editorList.scrollLeft).toBe(90);
  });

  it("uses the scoped thin scrollbar on both strips", () => {
    useAppStore.setState({
      tabs: [tab("tab-1", "first"), editor("editor-1", "a.ts")],
      activeTabId: "tab-1",
    });
    render(
      <>
        <SessionTabStrip />
        <EditorTabStrip />
      </>,
    );

    const sessionList = screen.getByRole("tablist", { name: "Session tabs" });
    const editorList = screen.getByRole("tablist", { name: "Editor tabs" });
    // `relative` is load-bearing for the reveal offset math; the scrollbar class
    // is what scopes the 2 px override to the two tab strips.
    expect(sessionList).toHaveClass("relative", "tab-strip-scrollbar");
    expect(editorList).toHaveClass("relative", "tab-strip-scrollbar");
  });
});

describe("tab reveal", () => {
  it("does not move the strip when a tab merely receives focus", () => {
    render(<SessionTabStrip />);
    const list = screen.getByRole("tablist", { name: "Session tabs" });
    defineBox(list, { scrollWidth: 600, clientWidth: 300 });
    defineChip(screen.getByTestId("tab-tab-2"), 500, 100);

    // Window re-activation re-dispatches focus; it must not scroll a strip the
    // user positioned by hand. Native keyboard focus scrolling still works.
    fireEvent.focus(screen.getByRole("tab", { name: /second/ }));

    expect(list.scrollLeft).toBe(0);
  });

  it("keeps a manual scroll position when tabs are republished", () => {
    // The reported bug: window focus calls resyncSessions → applyTabs, which
    // replaces the tabs array. The active (far-right) tab must not be revealed
    // again, because that overwrites the user's latest scroll position.
    useAppStore.setState({ activeTabId: "tab-2" });
    render(<SessionTabStrip />);
    const list = screen.getByRole("tablist", { name: "Session tabs" });
    defineBox(list, { scrollWidth: 600, clientWidth: 300 });
    defineChip(screen.getByTestId("tab-tab-2"), 500, 100);
    list.scrollLeft = 0;

    act(() => {
      useAppStore.setState({ tabs: [tab("tab-1", "first"), tab("tab-2", "second")] });
    });

    expect(list.scrollLeft).toBe(0);
  });

  it("reveals the newly active tab", () => {
    render(<SessionTabStrip />);
    const list = screen.getByRole("tablist", { name: "Session tabs" });
    defineBox(list, { scrollWidth: 600, clientWidth: 300 });
    defineChip(screen.getByTestId("tab-tab-2"), 500, 100);

    act(() => {
      useAppStore.setState({ activeTabId: "tab-2" });
    });

    expect(list.scrollLeft).toBe(300);
  });
});
