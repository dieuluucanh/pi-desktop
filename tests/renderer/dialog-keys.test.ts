import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SELECT_KEYS,
  dialogKeyAllowed,
  dialogKeyIntent,
  isForeignOverlayTarget,
  moveSelection,
  selectKeysFrom,
  type DialogKeyEvent,
} from "../../src/renderer/src/extension-ui/dialog-keys";

/**
 * The pure dialog-key policy (2026-11-18 dialog parity plan).
 *
 * Terminal Pi's selector owns Up/Down + j/k, clamps at the ends, selects with
 * Enter and cancels with Escape/Ctrl+C. The desktop must reach the same decision
 * whether focus is on an option or on `document.body`.
 */

function key(key: string, overrides: Partial<DialogKeyEvent> = {}): DialogKeyEvent {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...overrides,
  };
}

const keys = DEFAULT_SELECT_KEYS;

afterEach(() => {
  document.body.replaceChildren();
});

describe("selectKeysFrom", () => {
  it("uses Pi's defaults when nothing is loaded", () => {
    expect(selectKeysFrom(null)).toEqual(DEFAULT_SELECT_KEYS);
    expect(DEFAULT_SELECT_KEYS.up).toEqual(["up"]);
    expect(DEFAULT_SELECT_KEYS.down).toEqual(["down"]);
    expect(DEFAULT_SELECT_KEYS.confirm).toEqual(["enter"]);
    expect(DEFAULT_SELECT_KEYS.cancel).toContain("escape");
    expect(DEFAULT_SELECT_KEYS.cancel).toContain("ctrl+c");
  });

  it("keeps the default for an id missing from the effective snapshot", () => {
    const resolved = selectKeysFrom({ "tui.select.down": ["ctrl+shift+d"] });
    expect(resolved.down).toEqual(["ctrl+shift+d"]);
    expect(resolved.up).toEqual(DEFAULT_SELECT_KEYS.up);
    expect(resolved.confirm).toEqual(DEFAULT_SELECT_KEYS.confirm);
    expect(resolved.cancel).toEqual(DEFAULT_SELECT_KEYS.cancel);
  });

  it("treats an empty remap as missing", () => {
    const resolved = selectKeysFrom({ "tui.select.up": [] });
    expect(resolved.up).toEqual(DEFAULT_SELECT_KEYS.up);
  });
});

describe("dialogKeyIntent (select)", () => {
  const context = { method: "select" as const, keys };

  it("moves with the arrow keys", () => {
    expect(dialogKeyIntent(key("ArrowUp"), context)).toBe("up");
    expect(dialogKeyIntent(key("ArrowDown"), context)).toBe("down");
  });

  it("moves with j/k, like terminal Pi", () => {
    expect(dialogKeyIntent(key("k"), context)).toBe("up");
    expect(dialogKeyIntent(key("j"), context)).toBe("down");
  });

  it("does not treat modified j/k as navigation", () => {
    expect(dialogKeyIntent(key("k", { ctrlKey: true }), context)).toBeNull();
    expect(dialogKeyIntent(key("j", { altKey: true }), context)).toBeNull();
  });

  it("selects with Enter", () => {
    expect(dialogKeyIntent(key("Enter"), context)).toBe("confirm");
  });

  it("cancels with Escape and Ctrl+C", () => {
    expect(dialogKeyIntent(key("Escape"), context)).toBe("cancel");
    expect(dialogKeyIntent(key("c", { ctrlKey: true }), context)).toBe("cancel");
  });

  it("keeps Ctrl+C as copy when there is a text selection", () => {
    expect(
      dialogKeyIntent(key("c", { ctrlKey: true }), { ...context, hasSelection: true }),
    ).toBeNull();
    // Escape still cancels even with a selection.
    expect(dialogKeyIntent(key("Escape"), { ...context, hasSelection: true })).toBe("cancel");
  });

  it("honours a remapped down binding and stops using ArrowDown", () => {
    const remapped = selectKeysFrom({ "tui.select.down": ["ctrl+shift+d"] });
    const remappedContext = { method: "select" as const, keys: remapped };
    // A real Shift+D arrives as "D"; domKeyId turns that into ctrl+shift+d.
    expect(dialogKeyIntent(key("D", { ctrlKey: true, shiftKey: true }), remappedContext)).toBe(
      "down",
    );
    expect(dialogKeyIntent(key("ArrowDown"), remappedContext)).toBeNull();
  });

  it("lets j/k win over a remapped cancel binding, as terminal Pi does", () => {
    const remapped = selectKeysFrom({ "tui.select.cancel": ["j"] });
    const remappedContext = { method: "select" as const, keys: remapped };
    expect(dialogKeyIntent(key("j"), remappedContext)).toBe("down");
  });
});

describe("dialogKeyIntent (confirm)", () => {
  const context = { method: "confirm" as const, keys };

  it("moves between Confirm and Cancel with Up/Down and j/k", () => {
    expect(dialogKeyIntent(key("ArrowUp"), context)).toBe("up");
    expect(dialogKeyIntent(key("ArrowDown"), context)).toBe("down");
    expect(dialogKeyIntent(key("k"), context)).toBe("up");
    expect(dialogKeyIntent(key("j"), context)).toBe("down");
  });

  it("leaves Enter to the focused button", () => {
    expect(dialogKeyIntent(key("Enter"), context)).toBeNull();
  });

  it("cancels with Escape and Ctrl+C", () => {
    expect(dialogKeyIntent(key("Escape"), context)).toBe("cancel");
    expect(dialogKeyIntent(key("c", { ctrlKey: true }), context)).toBe("cancel");
    expect(
      dialogKeyIntent(key("c", { ctrlKey: true }), { ...context, hasSelection: true }),
    ).toBeNull();
  });
});

describe("dialogKeyIntent (input/editor)", () => {
  for (const method of ["input", "editor"] as const) {
    it(`${method}: only Escape cancels; typing and Ctrl+C stay native`, () => {
      const context = { method, keys };
      expect(dialogKeyIntent(key("Escape"), context)).toBe("cancel");
      expect(dialogKeyIntent(key("c", { ctrlKey: true }), context)).toBeNull();
      expect(dialogKeyIntent(key("Enter"), context)).toBeNull();
      expect(dialogKeyIntent(key("ArrowDown"), context)).toBeNull();
      expect(dialogKeyIntent(key("j"), context)).toBeNull();
    });
  }
});

describe("dialogKeyIntent (guards)", () => {
  it("ignores IME composition", () => {
    expect(
      dialogKeyIntent(key("ArrowDown", { isComposing: true }), {
        method: "select",
        keys,
      }),
    ).toBeNull();
  });

  it("ignores modifier-only and unknown keys", () => {
    expect(dialogKeyIntent(key("Shift"), { method: "select", keys })).toBeNull();
    expect(dialogKeyIntent(key("F5"), { method: "select", keys })).toBeNull();
  });
});

describe("moveSelection", () => {
  it("clamps at both ends instead of wrapping", () => {
    expect(moveSelection(0, -1, 3)).toBe(0);
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(1, 1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(2);
    expect(moveSelection(2, -1, 3)).toBe(1);
  });

  it("handles an empty list and a non-finite index", () => {
    expect(moveSelection(4, 1, 0)).toBe(0);
    expect(moveSelection(Number.NaN, 1, 3)).toBe(1);
  });
});

describe("dialogKeyAllowed", () => {
  const state = { paletteOpen: false, shortcutsHelpOpen: false };

  function keydown(init: KeyboardEventInit = {}): KeyboardEvent {
    return new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
      ...init,
    });
  }

  it("accepts a normal key event", () => {
    expect(dialogKeyAllowed(keydown(), null, state)).toBe(true);
  });

  it("rejects an already-handled or composing event", () => {
    const handled = keydown();
    handled.preventDefault();
    expect(dialogKeyAllowed(handled, null, state)).toBe(false);
    expect(dialogKeyAllowed(keydown({ isComposing: true }), null, state)).toBe(false);
  });

  it("rejects an open palette or shortcuts help", () => {
    expect(dialogKeyAllowed(keydown(), null, { ...state, paletteOpen: true })).toBe(false);
    expect(dialogKeyAllowed(keydown(), null, { ...state, shortcutsHelpOpen: true })).toBe(false);
  });

  it("rejects a key owned by another overlay", () => {
    const own = document.createElement("div");
    own.setAttribute("data-extension-dialog", "ui-1");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("button");
    menu.append(item);
    document.body.append(own, menu);

    const event = keydown();
    item.dispatchEvent(event);
    expect(dialogKeyAllowed(event, own, state)).toBe(false);
  });
});

describe("isForeignOverlayTarget", () => {
  function dialogRoot(): HTMLElement {
    const own = document.createElement("div");
    own.setAttribute("data-extension-dialog", "ui-1");
    const list = document.createElement("div");
    list.setAttribute("role", "listbox");
    list.tabIndex = -1;
    own.append(list);
    document.body.append(own);
    return own;
  }

  it("accepts the dialog's own listbox and the page", () => {
    const own = dialogRoot();
    const list = own.querySelector('[role="listbox"]');
    expect(isForeignOverlayTarget(list, own)).toBe(false);
    expect(isForeignOverlayTarget(document.body, own)).toBe(false);
  });

  it("rejects a key owned by another menu or modal", () => {
    const own = dialogRoot();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("button");
    menu.append(item);
    document.body.append(menu);

    expect(isForeignOverlayTarget(item, own)).toBe(true);
  });

  it("rejects when the focused element belongs to another overlay", () => {
    const own = dialogRoot();
    const panel = document.createElement("div");
    panel.setAttribute("role", "dialog");
    const button = document.createElement("button");
    panel.append(button);
    document.body.append(panel);
    button.focus();

    expect(isForeignOverlayTarget(document.body, own)).toBe(true);
  });
});
