import { describe, expect, it } from "vitest";
import {
  COMMIT_MESSAGE_MAX_HEIGHT_PX,
  PROMPT_MAX_HEIGHT_PX,
  clampedTextareaHeight,
} from "../../src/renderer/src/ui/auto-grow";

/**
 * The textarea auto-grow contract.
 *
 * jsdom has no layout, so the DOM hook's behaviour is asserted in the composer
 * and commit-box tests with a mocked `scrollHeight`. The arithmetic that decides
 * the height lives here and is tested without a DOM.
 */

describe("clampedTextareaHeight", () => {
  it("treats a missing measurement as no layout", () => {
    expect(clampedTextareaHeight(0, 192)).toBe(0);
    expect(clampedTextareaHeight(-10, 192)).toBe(0);
    expect(clampedTextareaHeight(Number.NaN, 192)).toBe(0);
    expect(clampedTextareaHeight(100, 0)).toBe(0);
    expect(clampedTextareaHeight(100, Number.NaN)).toBe(0);
  });

  it("keeps a content height below the cap", () => {
    expect(clampedTextareaHeight(61, 192)).toBe(61);
    expect(clampedTextareaHeight(160.2, 192)).toBe(161);
  });

  it("caps a long message and pins the two composers' limits", () => {
    expect(clampedTextareaHeight(400, PROMPT_MAX_HEIGHT_PX)).toBe(192);
    expect(clampedTextareaHeight(400, COMMIT_MESSAGE_MAX_HEIGHT_PX)).toBe(160);
  });
});
