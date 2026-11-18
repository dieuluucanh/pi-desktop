import { describe, expect, it } from "vitest";

import {
  IDLE_TERMINAL_WHEEL,
  TERMINAL_PAGE_DOWN,
  TERMINAL_PAGE_UP,
  WHEEL_GESTURE_GAP_MS,
  pageSequence,
  stepTerminalWheel,
  type TerminalWheelContext,
  type TerminalWheelState,
} from "../../src/shared/terminal-wheel";

/**
 * The terminal's wheel policy (2026-11-18 terminal wheel plan, step 1).
 *
 * xterm turns a wheel into `ESC[A`/`ESC[B` in the alternate screen when the
 * program has no wheel reporting. These tests pin exactly the state in which
 * the app takes over, and that every intervention is a page or a swallow —
 * never an arrow.
 */

const alternate: TerminalWheelContext = { buffer: "alternate", mouseWheelReports: false };
const alternateMouse: TerminalWheelContext = { buffer: "alternate", mouseWheelReports: true };
const normal: TerminalWheelContext = { buffer: "normal", mouseWheelReports: false };

const idle: TerminalWheelState = IDLE_TERMINAL_WHEEL;

describe("stepTerminalWheel", () => {
  it("leaves the normal buffer to xterm's scrollback", () => {
    const step = stepTerminalWheel({ deltaY: -120 }, normal, idle, 1_000);
    expect(step.decision).toEqual({ kind: "native" });
    expect(step.state).toBe(idle);
  });

  it("leaves a wheel-reporting program to xterm's SGR path", () => {
    const step = stepTerminalWheel({ deltaY: 120 }, alternateMouse, idle, 1_000);
    expect(step.decision).toEqual({ kind: "native" });
    expect(step.state).toBe(idle);
  });

  it("pages up for a wheel up and down for a wheel down", () => {
    const up = stepTerminalWheel({ deltaY: -120 }, alternate, idle, 1_000);
    expect(up.decision).toEqual({ kind: "page", page: -1 });
    expect(up.state).toEqual({ direction: -1, at: 1_000 });

    const down = stepTerminalWheel({ deltaY: 120 }, alternate, idle, 1_000);
    expect(down.decision).toEqual({ kind: "page", page: 1 });
    expect(down.state).toEqual({ direction: 1, at: 1_000 });
  });

  it("emits one page per same-direction burst and swallows the rest", () => {
    const first = stepTerminalWheel({ deltaY: 100 }, alternate, idle, 1_000);
    expect(first.decision).toEqual({ kind: "page", page: 1 });

    const second = stepTerminalWheel({ deltaY: 100 }, alternate, first.state, 1_050);
    expect(second.decision).toEqual({ kind: "swallow" });
    expect(second.state).toEqual({ direction: 1, at: 1_050 });

    const third = stepTerminalWheel({ deltaY: 100 }, alternate, second.state, 1_100);
    expect(third.decision).toEqual({ kind: "swallow" });
  });

  it("pages again once the gesture gap has passed", () => {
    const first = stepTerminalWheel({ deltaY: 100 }, alternate, idle, 1_000);
    const later = stepTerminalWheel(
      { deltaY: 100 },
      alternate,
      first.state,
      1_000 + WHEEL_GESTURE_GAP_MS + 1,
    );
    expect(later.decision).toEqual({ kind: "page", page: 1 });
  });

  it("starts a new page when the direction reverses inside a burst", () => {
    const down = stepTerminalWheel({ deltaY: 100 }, alternate, idle, 1_000);
    const up = stepTerminalWheel({ deltaY: -100 }, alternate, down.state, 1_050);
    expect(up.decision).toEqual({ kind: "page", page: -1 });
    expect(up.state).toEqual({ direction: -1, at: 1_050 });
  });

  it("swallows zoom chords instead of letting xterm encode an arrow", () => {
    expect(stepTerminalWheel({ deltaY: 100, ctrlKey: true }, alternate, idle, 1).decision).toEqual({
      kind: "swallow",
    });
    expect(stepTerminalWheel({ deltaY: 100, metaKey: true }, alternate, idle, 1).decision).toEqual({
      kind: "swallow",
    });
  });

  it("swallows a zero or horizontal-dominant wheel", () => {
    expect(stepTerminalWheel({ deltaY: 0 }, alternate, idle, 1).decision).toEqual({
      kind: "swallow",
    });
    expect(stepTerminalWheel({ deltaY: 10, deltaX: 90 }, alternate, idle, 1).decision).toEqual({
      kind: "swallow",
    });
    expect(stepTerminalWheel({ deltaY: 90, deltaX: 10 }, alternate, idle, 1).decision).toEqual({
      kind: "page",
      page: 1,
    });
  });

  it("swallows a non-finite delta without corrupting the burst state", () => {
    const step = stepTerminalWheel({ deltaY: Number.NaN }, alternate, idle, 1_000);
    expect(step.decision).toEqual({ kind: "swallow" });
    expect(step.state).toBe(idle);
  });

  it("keeps a horizontal wheel from breaking the burst window", () => {
    const page = stepTerminalWheel({ deltaY: 100 }, alternate, idle, 1_000);
    const horizontal = stepTerminalWheel({ deltaY: 0, deltaX: 100 }, alternate, page.state, 1_050);
    expect(horizontal.decision).toEqual({ kind: "swallow" });
    expect(horizontal.state).toBe(page.state);
  });
});

describe("pageSequence", () => {
  it("matches pi-tui's pageUp/pageDown bytes", () => {
    expect(pageSequence(-1)).toBe(TERMINAL_PAGE_UP);
    expect(pageSequence(1)).toBe(TERMINAL_PAGE_DOWN);
    expect(TERMINAL_PAGE_UP).toBe("\x1b[5~");
    expect(TERMINAL_PAGE_DOWN).toBe("\x1b[6~");
  });
});
