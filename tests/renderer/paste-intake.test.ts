import { describe, expect, it } from "vitest";
import {
  PASTE_DUPLICATE_WINDOW_MS,
  createPasteIntake,
  type PasteIntake,
} from "../../src/renderer/src/ui/paste-intake";

/**
 * The paste intake (2026-11-14 terminal paste plan, step 4).
 *
 * The clock is injected so a window boundary is tested exactly rather than by
 * sleeping. The invariant under test: one clipboard gesture, one PTY write,
 * without ever dropping a legitimate repeat.
 */

function intakeAt(clock: { at: number }, windowMs?: number): PasteIntake {
  return createPasteIntake({
    ...(windowMs === undefined ? {} : { windowMs }),
    now: () => clock.at,
  });
}

describe("createPasteIntake", () => {
  it("accepts the first paste", () => {
    const clock = { at: 1_000 };
    expect(intakeAt(clock).accept("hello", "app")).toBe(true);
  });

  it("refuses empty text without disturbing the record", () => {
    const clock = { at: 1_000 };
    const intake = intakeAt(clock);
    expect(intake.accept("hello", "app")).toBe(true);
    clock.at += 10;
    expect(intake.accept("", "native")).toBe(false);
    // The empty attempt must not count as the "last" delivery.
    clock.at += 10;
    expect(intake.accept("hello", "native")).toBe(false);
  });

  it("drops the same text delivered by the other source inside the window", () => {
    const clock = { at: 1_000 };
    const intake = intakeAt(clock);
    expect(intake.accept("hello", "native")).toBe(true);
    clock.at += 30;
    expect(intake.accept("hello", "app")).toBe(false);
  });

  it("accepts the other source once the window has passed", () => {
    const clock = { at: 1_000 };
    const intake = intakeAt(clock);
    expect(intake.accept("hello", "native")).toBe(true);
    clock.at += PASTE_DUPLICATE_WINDOW_MS;
    expect(intake.accept("hello", "app")).toBe(true);
  });

  it("accepts different text even from the other source", () => {
    const clock = { at: 1_000 };
    const intake = intakeAt(clock);
    expect(intake.accept("hello", "native")).toBe(true);
    clock.at += 5;
    expect(intake.accept("world", "app")).toBe(true);
  });

  it("never drops a same-source repeat (key repeat, two deliberate pastes)", () => {
    const clock = { at: 1_000 };
    const intake = intakeAt(clock);
    for (let index = 0; index < 3; index += 1) {
      clock.at += 20;
      expect(intake.accept("hello", "app")).toBe(true);
    }
  });

  it("does not let a rejected duplicate refresh the window", () => {
    const clock = { at: 1_000 };
    const intake = intakeAt(clock, 200);
    expect(intake.accept("hello", "native")).toBe(true);
    clock.at += 150;
    expect(intake.accept("hello", "app")).toBe(false);
    // Judged against the accepted write at 1_000, not the dropped one at 1_150.
    clock.at += 60;
    expect(intake.accept("hello", "app")).toBe(true);
  });

  it("collapses the reported triple delivery into one write", () => {
    // The bug: keydown + keyup through the app, plus the browser's own paste.
    const clock = { at: 1_000 };
    const intake = intakeAt(clock);
    const written = [
      intake.accept("hello", "native"),
      intake.accept("hello", "app"),
      intake.accept("hello", "app"),
    ].filter(Boolean);
    expect(written).toHaveLength(1);
  });
});
