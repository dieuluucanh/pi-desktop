import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  releaseStaleBodyPointerLock,
  scheduleBodyPointerLockCheck,
} from "../../src/renderer/src/ui/body-pointer-lock";

/**
 * The body-lock recovery net (2026-11-03 plan step 3).
 *
 * `releaseStaleBodyPointerLock` must only fire when the lock is stale: a
 * genuinely open dialog/menu still owns `pointer-events: none`.
 */

function openLayer(role: "dialog" | "menu"): void {
  const node = document.createElement("div");
  node.setAttribute("role", role);
  node.setAttribute("data-state", "open");
  node.setAttribute("data-test-open-layer", "");
  document.body.append(node);
}

beforeEach(() => {
  document.body.style.pointerEvents = "";
});

afterEach(() => {
  document.body.style.pointerEvents = "";
  for (const node of document.querySelectorAll("[data-test-open-layer]")) node.remove();
  vi.useRealTimers();
});

describe("releaseStaleBodyPointerLock", () => {
  it("clears a stale lock when no modal layer is open", () => {
    document.body.style.pointerEvents = "none";

    expect(releaseStaleBodyPointerLock(document)).toBe(true);
    expect(document.body.style.pointerEvents).toBe("");
  });

  it("keeps the lock while a dialog is open", () => {
    document.body.style.pointerEvents = "none";
    openLayer("dialog");

    expect(releaseStaleBodyPointerLock(document)).toBe(false);
    expect(document.body.style.pointerEvents).toBe("none");
  });

  it("keeps the lock while a menu is open", () => {
    document.body.style.pointerEvents = "none";
    openLayer("menu");

    expect(releaseStaleBodyPointerLock(document)).toBe(false);
    expect(document.body.style.pointerEvents).toBe("none");
  });

  it("does nothing when the body is already interactive", () => {
    expect(releaseStaleBodyPointerLock(document)).toBe(false);
    expect(document.body.style.pointerEvents).toBe("");
  });

  it("checks after the current task so Radix restores its own lock first", () => {
    vi.useFakeTimers();
    document.body.style.pointerEvents = "none";

    scheduleBodyPointerLockCheck(document);
    expect(document.body.style.pointerEvents).toBe("none");

    vi.runAllTimers();
    expect(document.body.style.pointerEvents).toBe("");
  });
});
