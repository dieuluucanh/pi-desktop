import { describe, expect, it } from "vitest";
import { nextActiveTabAfterClose, type SelectableTab } from "../../src/main/tab-selection";

/**
 * The post-close selection policy. The reported bug was a review tab closing
 * onto the strip's first tab: `lastActiveAt` is polluted by background RPCs, so
 * the opener link must win and the recency fallback must be deterministic.
 */

function tab(
  id: string,
  overrides: Partial<SelectableTab> = {},
): SelectableTab & { marker: string } {
  return {
    id,
    kind: "session",
    lastActiveAt: 1,
    createdAt: 1,
    marker: id,
    ...overrides,
  };
}

function webTab(id: string, sessionTabId: string | null): SelectableTab {
  return tab(id, { kind: "web", sessionTabId });
}

describe("nextActiveTabAfterClose", () => {
  it("returns the linked session even when another tab has newer activity", () => {
    const opener = tab("opener", { lastActiveAt: 10 });
    const newer = tab("newer", { lastActiveAt: 99 });

    expect(nextActiveTabAfterClose(webTab("review", "opener"), [newer, opener])).toBe(opener);
  });

  it("falls back to MRU for a web tab with no link", () => {
    const older = tab("older", { lastActiveAt: 10 });
    const newer = tab("newer", { lastActiveAt: 20 });

    expect(nextActiveTabAfterClose(webTab("review", null), [older, newer])).toBe(newer);
  });

  it("ignores a link that is missing, itself, another web tab or an editor", () => {
    const newer = tab("newer", { lastActiveAt: 20 });
    // The link targets are deliberately older than `newer`: if the policy
    // wrongly treated them as the opener, it would return them instead of MRU.
    const otherWeb = tab("other-web", { kind: "web", lastActiveAt: 5 });
    const editor = tab("editor", { kind: "editor", lastActiveAt: 5 });

    expect(nextActiveTabAfterClose(webTab("review", "gone"), [newer])).toBe(newer);
    expect(nextActiveTabAfterClose(webTab("review", "review"), [newer])).toBe(newer);
    expect(nextActiveTabAfterClose(webTab("review", "other-web"), [otherWeb, newer])).toBe(newer);
    expect(nextActiveTabAfterClose(webTab("review", "editor"), [editor, newer])).toBe(newer);
  });

  it("uses createdAt when the activity clocks are equal", () => {
    const older = tab("older", { lastActiveAt: 5, createdAt: 1 });
    const newer = tab("newer", { lastActiveAt: 5, createdAt: 2 });

    expect(nextActiveTabAfterClose(tab("closed"), [older, newer])).toBe(newer);
  });

  it("uses the id as the final deterministic tie-break", () => {
    const beta = tab("beta", { lastActiveAt: 5, createdAt: 1 });
    const alpha = tab("alpha", { lastActiveAt: 5, createdAt: 1 });

    expect(nextActiveTabAfterClose(tab("closed"), [beta, alpha])).toBe(alpha);
    expect(nextActiveTabAfterClose(tab("closed"), [alpha, beta])).toBe(alpha);
  });

  it("returns null when nothing remains", () => {
    expect(nextActiveTabAfterClose(webTab("review", "opener"), [])).toBeNull();
  });

  it("does not mutate the remaining list", () => {
    const list = [tab("a", { lastActiveAt: 1 }), tab("b", { lastActiveAt: 2 })];
    const before = [...list];

    nextActiveTabAfterClose(tab("closed"), list);

    expect(list).toEqual(before);
  });
});
