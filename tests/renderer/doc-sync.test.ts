import { describe, expect, it, vi } from "vitest";

import { syncDocToView, type DocSyncView } from "../../src/renderer/src/editor/doc-sync";

/**
 * In-place document sync (2026-11-03 plan step 8).
 *
 * A background reload must replace the doc with one transaction, not recreate
 * the view; an unchanged doc must not dispatch at all.
 */

type ReplaceSpec = { changes: { from: number; to: number; insert: string } };

function fakeView(doc: string) {
  const dispatch = vi.fn<(spec: ReplaceSpec) => void>();
  const view: DocSyncView = {
    state: { doc: { toString: () => doc, length: doc.length } },
    dispatch,
  };
  return { view, dispatch };
}

describe("syncDocToView", () => {
  it("does not dispatch when the document is already current", () => {
    const { view, dispatch } = fakeView("same text");

    expect(syncDocToView(view, "same text")).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("replaces the whole document with one transaction", () => {
    const { view, dispatch } = fakeView("old");

    expect(syncDocToView(view, "new text")).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 3, insert: "new text" },
    });
  });

  it("handles an empty document", () => {
    const { view, dispatch } = fakeView("");

    expect(syncDocToView(view, "first line")).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      changes: { from: 0, to: 0, insert: "first line" },
    });
  });
});
