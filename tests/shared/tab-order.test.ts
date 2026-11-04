import { describe, expect, it } from "vitest";

import {
  moveTabWithinPinGroup,
  partitionPinnedTabs,
  type PinOrderTab,
} from "../../src/shared/tab-order";

function tab(id: string, pinned = false): PinOrderTab {
  return pinned ? { id, pinned: true } : { id };
}

describe("partitionPinnedTabs", () => {
  it("puts pinned tabs first and preserves both relative orders", () => {
    const tabs = [tab("a"), tab("p1", true), tab("b"), tab("p2", true)];
    expect(partitionPinnedTabs(tabs).map((entry) => entry.id)).toEqual(["p1", "p2", "a", "b"]);
  });

  it("is stable for an already-partitioned list and does not mutate its input", () => {
    const tabs = [tab("p1", true), tab("a"), tab("b")];
    const result = partitionPinnedTabs(tabs);
    expect(result.map((entry) => entry.id)).toEqual(["p1", "a", "b"]);
    expect(tabs.map((entry) => entry.id)).toEqual(["p1", "a", "b"]);
  });
});

describe("moveTabWithinPinGroup", () => {
  const tabs = [tab("p1", true), tab("p2", true), tab("a"), tab("b"), tab("c")];

  it("moves an unpinned tab within the unpinned group", () => {
    expect(moveTabWithinPinGroup(tabs, "a", 4).map((entry) => entry.id)).toEqual([
      "p1",
      "p2",
      "b",
      "c",
      "a",
    ]);
  });

  it("clamps an unpinned tab above the pinned boundary", () => {
    expect(moveTabWithinPinGroup(tabs, "c", 0).map((entry) => entry.id)).toEqual([
      "p1",
      "p2",
      "c",
      "a",
      "b",
    ]);
  });

  it("moves a pinned tab only inside the pinned group", () => {
    expect(moveTabWithinPinGroup(tabs, "p1", 4).map((entry) => entry.id)).toEqual([
      "p2",
      "p1",
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps a single pinned tab at the front", () => {
    const single = [tab("p1", true), tab("a"), tab("b")];
    expect(moveTabWithinPinGroup(single, "p1", 2).map((entry) => entry.id)).toEqual([
      "p1",
      "a",
      "b",
    ]);
  });

  it("keeps a single unpinned tab at the end", () => {
    const single = [tab("p1", true), tab("a")];
    expect(moveTabWithinPinGroup(single, "a", 0).map((entry) => entry.id)).toEqual(["p1", "a"]);
  });

  it("returns an unchanged copy for an unknown id or a no-op", () => {
    expect(moveTabWithinPinGroup(tabs, "missing", 1).map((entry) => entry.id)).toEqual(
      tabs.map((entry) => entry.id),
    );
    expect(moveTabWithinPinGroup(tabs, "a", 2).map((entry) => entry.id)).toEqual(
      tabs.map((entry) => entry.id),
    );
  });
});
