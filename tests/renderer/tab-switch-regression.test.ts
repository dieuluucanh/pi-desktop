import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * Regression guard for "the app switched tabs by itself" (2026-11-06 plan,
 * step 9).
 *
 * The reported sequence: the user works in one project's session while other
 * projects' sessions are open and doing background work; the window suddenly
 * shows one of those instead. This file models that sequence end to end at the
 * renderer boundary — a background wake push, then a background extension dialog
 * while the visible run is streaming — and asserts the selection never moves.
 *
 * It lives in its own file because the revision/selection counters are
 * process-lifetime by design; sharing a file with hand-built revisions would make
 * the outcome depend on test order.
 */

const STRATA = "tab-strata";
const DESKTOP = "tab-desktop";
const THIRD = "tab-third";

function tab(id: string, cwd: string, lastActiveAt: number): TabRecord {
  return {
    id,
    kind: "session",
    cwd,
    title: cwd,
    sessionFile: `/profile/${id}.jsonl`,
    status: "idle",
    createdAt: lastActiveAt,
    lastActiveAt,
    model: null,
  };
}

function reset(): void {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    tabs: [
      tab(STRATA, "C:/work/Strata", 30),
      tab(DESKTOP, "C:/work/pi-desktop", 20),
      tab(THIRD, "C:/work/third", 10),
    ],
    activeTabId: STRATA,
    sessionStates: { [STRATA]: { streaming: true } },
    transcripts: {},
    dialogAttention: {},
    extensionDialogs: [],
    extensionUi: {},
  });
}

beforeEach(reset);

describe("the window stays where the user put it", () => {
  it("does not follow a background wake push", () => {
    // Main re-published the table because the pi-desktop host woke. Only the
    // facts changed; the selection echo is the one this window already has.
    useAppStore.getState().applyTabs(
      {
        tabs: [
          tab(STRATA, "C:/work/Strata", 30),
          tab(DESKTOP, "C:/work/pi-desktop", 20),
          tab(THIRD, "C:/work/third", 10),
        ],
        activeTabId: STRATA,
        revision: 1,
        selectionSeq: 1,
      },
      { adoptSelection: false },
    );

    expect(useAppStore.getState().activeTabId).toBe(STRATA);
  });

  it("does not follow a dialog raised by a background session mid-run", () => {
    useAppStore.getState().applySessionEvents({
      tabId: DESKTOP,
      seq: 1,
      events: [
        {
          event: "oi.request",
          payload: { id: "q1", method: "confirm", params: { title: "Approve?", message: "?" } },
        },
      ],
    });

    expect(useAppStore.getState().activeTabId).toBe(STRATA);
    // The question is not lost: the tab carries a dot and the dialog is queued
    // against the tab that asked, ready to answer when the user gets there.
    expect(useAppStore.getState().dialogAttention[DESKTOP]).toBe(true);
    expect(useAppStore.getState().extensionDialogs.map((dialog) => dialog.tabId)).toEqual([
      DESKTOP,
    ]);
  });

  it("ignores a stale push from before the user's own switch", async () => {
    // The user moves to the third session while a slow response for the wake of
    // the desktop tab is still in flight.
    await useAppStore.getState().activateTab(THIRD);
    expect(useAppStore.getState().activeTabId).toBe(THIRD);

    useAppStore.getState().applyTabs(
      {
        tabs: [
          tab(STRATA, "C:/work/Strata", 30),
          tab(DESKTOP, "C:/work/pi-desktop", 20),
          tab(THIRD, "C:/work/third", 10),
        ],
        activeTabId: DESKTOP,
        revision: 2,
        selectionSeq: 1,
      },
      { adoptSelection: false },
    );

    expect(useAppStore.getState().activeTabId).toBe(THIRD);
  });
});
