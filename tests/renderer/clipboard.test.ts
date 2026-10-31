import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyText,
  hasSelectionWithin,
  selectedTextWithin,
} from "../../src/renderer/src/ui/clipboard";

/**
 * Clipboard helpers (2026-10-30 copy plan).
 *
 * `copyText` must try the async clipboard, fall back to `execCommand`, and
 * report the result honestly; the selection helpers must reject a selection that
 * starts outside the requested root.
 */

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

function stubClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

function stubExecCommand(result: boolean): ReturnType<typeof vi.fn> {
  const exec = vi.fn(() => result);
  Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
  return exec;
}

function selectInside(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  if (originalExecCommand) {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: originalExecCommand,
    });
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("uses the async clipboard and reports success", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);

    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when the clipboard rejects", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });
    const exec = stubExecCommand(true);

    await expect(copyText("fallback")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("reports failure when both paths fail", async () => {
    stubClipboard(null);
    stubExecCommand(false);

    await expect(copyText("nope")).resolves.toBe(false);
  });

  it("never touches the clipboard for empty text", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);

    await expect(copyText("")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("selection helpers", () => {
  it("returns a selection whose ends are both inside the root", () => {
    const root = document.createElement("div");
    root.textContent = "hello world";
    document.body.append(root);
    selectInside(root);

    expect(selectedTextWithin(root)).toBe("hello world");
    expect(hasSelectionWithin(root)).toBe(true);
  });

  it("rejects a collapsed or outside selection", () => {
    const root = document.createElement("div");
    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.append(root, outside);

    expect(selectedTextWithin(root)).toBeNull();
    window.getSelection()?.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(outside);
    window.getSelection()?.addRange(range);

    expect(selectedTextWithin(root)).toBeNull();
    expect(hasSelectionWithin(root)).toBe(false);
  });
});
