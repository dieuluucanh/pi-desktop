import { describe, expect, it } from "vitest";

import { TAB_DRAG_MIME, TAB_DRAG_VERSION } from "../../src/shared/tab-drag";
import { isTabDrag, readTabDrop, writeTabDrag } from "../../src/renderer/src/layout/tab-drag";
import { isExternalFileDrag, isWorkspaceDrag } from "../../src/renderer/src/files/workspace-drag";

/**
 * Renderer tab drag helpers (2026-11-03 grid plan step 2).
 *
 * A pane drop target asks two questions: is this a tab drag at all, and which tab
 * is it? `isTabDrag` reads the type list (available during `dragover`, when
 * `getData` is still empty in Chromium); `readTabDrop` reads the payload only
 * after `drop`.
 */

class FakeTransfer {
  readonly data = new Map<string, string>();
  readonly types: string[] = [];
  effectAllowed = "none";

  setData(type: string, value: string): void {
    this.data.set(type, value);
    if (!this.types.includes(type)) this.types.push(type);
  }

  getData(type: string): string {
    return this.data.get(type) ?? "";
  }
}

describe("writeTabDrag", () => {
  it("writes the typed payload and a plain-text fallback", () => {
    const transfer = new FakeTransfer();
    writeTabDrag(transfer, "tab-1");

    expect(transfer.getData(TAB_DRAG_MIME)).toBe(
      JSON.stringify({ version: TAB_DRAG_VERSION, tabId: "tab-1" }),
    );
    // Reorder inside a strip still uses the plain form.
    expect(transfer.getData("text/plain")).toBe("tab-1");
    expect(transfer.effectAllowed).toBe("move");
  });

  it("writes nothing for an empty id", () => {
    const transfer = new FakeTransfer();
    writeTabDrag(transfer, "");
    expect(transfer.types).toEqual([]);
    expect(transfer.effectAllowed).toBe("none");
  });
});

describe("isTabDrag", () => {
  it("is true only for the typed MIME", () => {
    const transfer = new FakeTransfer();
    writeTabDrag(transfer, "tab-1");
    expect(isTabDrag(transfer)).toBe(true);

    const plain = new FakeTransfer();
    plain.setData("text/plain", "tab-1");
    expect(isTabDrag(plain)).toBe(false);
  });

  it("does not treat a workspace-file drag as a tab drag", () => {
    const transfer = new FakeTransfer();
    transfer.setData("application/x-pi-workspace-path", '{"version":1}');
    expect(isTabDrag(transfer)).toBe(false);
    expect(isWorkspaceDrag(transfer)).toBe(true);
  });

  it("leaves the OS file-drag guard alone", () => {
    const transfer = new FakeTransfer();
    transfer.setData("Files", "");
    expect(isTabDrag(transfer)).toBe(false);
    expect(isExternalFileDrag(transfer)).toBe(true);
  });
});

describe("readTabDrop", () => {
  it("reads and validates the payload", () => {
    const transfer = new FakeTransfer();
    writeTabDrag(transfer, "tab-1");
    expect(readTabDrop(transfer)).toEqual({ version: TAB_DRAG_VERSION, tabId: "tab-1" });
  });

  it("never falls back to the plain-text form", () => {
    const transfer = new FakeTransfer();
    transfer.setData("text/plain", "tab-1");
    expect(readTabDrop(transfer)).toBeNull();
  });

  it("returns null for a corrupted payload", () => {
    const transfer = new FakeTransfer();
    transfer.setData(TAB_DRAG_MIME, "{not json");
    expect(readTabDrop(transfer)).toBeNull();
  });
});
