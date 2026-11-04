import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { openTabContextMenuFromKeyboard } from "../../src/renderer/src/layout/tab-menu-keyboard";

/**
 * The keyboard entry point for a tab's lifecycle menu (2026-11-03 tab-strip
 * plan). The strips test the whole menu; this file pins the key handling and the
 * editable-target guard on their own, so a change to either cannot hide behind
 * the Radix popup.
 */

function Harness({ spy }: { spy: () => void }): React.JSX.Element {
  return (
    <div data-testid="chip" onKeyDown={openTabContextMenuFromKeyboard} onContextMenu={spy}>
      <button type="button">tab</button>
      <input aria-label="rename" />
    </div>
  );
}

describe("openTabContextMenuFromKeyboard", () => {
  it("synthesizes the contextmenu event that Shift+F10 needs", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);

    fireEvent.keyDown(screen.getByTestId("chip"), { key: "F10", shiftKey: true });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("treats the Menu key (ContextMenu) as the same shortcut", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "tab" }), { key: "ContextMenu" });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ignores a bare F10 and keydowns inside an editable field", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "tab" }), { key: "F10" });
    fireEvent.keyDown(screen.getByLabelText("rename"), { key: "F10", shiftKey: true });

    expect(spy).not.toHaveBeenCalled();
  });
});
