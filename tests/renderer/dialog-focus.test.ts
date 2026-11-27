import { describe, expect, it } from "vitest";

import {
  shouldFocusDialog,
  type DialogFocusInput,
} from "../../src/renderer/src/session/dialog-focus";

/**
 * Focus policy for a background tab's extension dialog (2026-11-06 tab-switch
 * plan, step 8). Stealing the window mid-typing is indistinguishable from the app
 * jumping to another project by itself, so every "do not move" branch is pinned.
 */

function input(overrides: Partial<DialogFocusInput> = {}): DialogFocusInput {
  return {
    policy: "blocking",
    blocking: true,
    windowFocused: true,
    composerFocused: false,
    streaming: false,
    ...overrides,
  };
}

describe("shouldFocusDialog", () => {
  it("takes the window for a blocking dialog when the user is idle", () => {
    expect(shouldFocusDialog(input())).toBe(true);
  });

  it("never takes the window while the user is typing", () => {
    expect(shouldFocusDialog(input({ composerFocused: true }))).toBe(false);
  });

  it("never takes the window while the active tab is streaming", () => {
    expect(shouldFocusDialog(input({ streaming: true }))).toBe(false);
  });

  it("leaves a non-blocking (auto-dismissing) dialog to the badge", () => {
    expect(shouldFocusDialog(input({ blocking: false }))).toBe(false);
  });

  it("never moves a window that does not have OS focus", () => {
    expect(shouldFocusDialog(input({ windowFocused: false }))).toBe(false);
  });

  it("honours the never policy", () => {
    expect(shouldFocusDialog(input({ policy: "never" }))).toBe(false);
  });
});
