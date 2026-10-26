import { describe, expect, it } from "vitest";
import {
  acceleratorToChord,
  chordToAccelerator,
  DESKTOP_ACTIONS,
  detectDesktopConflicts,
  isMenuAcceleratorAction,
  menuAcceleratorsFor,
  parseMenuAccelerator,
  resolveDesktopKeymap,
  sanitizeDesktopKeybindings,
  validDesktopChord,
} from "../../src/shared/desktop-keymap";

/**
 * The desktop keymap (2026-10-26 session-parity plan step 22).
 *
 * Pi's actions keep `keybindings.json` as their only home; this registry owns
 * desktop-only actions, with menu accelerators in their own grammar and a
 * scope-aware conflict model.
 */

describe("registry", () => {
  it("has unique ids and valid default chords", () => {
    const ids = DESKTOP_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const action of DESKTOP_ACTIONS) {
      for (const chord of action.defaults) expect(validDesktopChord(chord)).toBe(true);
    }
  });

  it("restricts menu accelerators to menu/global actions", () => {
    expect(isMenuAcceleratorAction("session.new")).toBe(true);
    expect(isMenuAcceleratorAction("transcript.find")).toBe(false);
  });
});

describe("sanitize", () => {
  it("drops unknown actions, invalid chords, meta chords and duplicates", () => {
    const sanitized = sanitizeDesktopKeybindings({
      "session.new": ["ctrl+n", "ctrl+n", "cmd+n", "not a chord", "alt+shift+p"],
      "transcript.find": ["ctrl+f"],
      "not.an.action": ["ctrl+x"],
      broken: "ctrl+y",
    });
    expect(sanitized).toEqual({
      "session.new": ["ctrl+n", "alt+shift+p"],
      "transcript.find": ["ctrl+f"],
    });
  });

  it("rejects meta even though Pi's own grammar has no cmd", () => {
    expect(validDesktopChord("meta+n")).toBe(false);
    expect(validDesktopChord("cmd+n")).toBe(false);
    expect(validDesktopChord("ctrl+n")).toBe(true);
    expect(validDesktopChord("ctrl+,")).toBe(true);
  });
});

describe("resolution", () => {
  it("uses defaults unless an override exists, including an empty (unbound) list", () => {
    const keymap = resolveDesktopKeymap({ "session.new": [], "palette.open": ["alt+k"] });
    expect(keymap["session.new"]).toEqual([]);
    expect(keymap["palette.open"]).toEqual(["alt+k"]);
    expect(keymap["transcript.find"]).toEqual(["ctrl+f"]);
  });
});

describe("menu grammar", () => {
  it("parses and round-trips accelerators", () => {
    expect(parseMenuAccelerator("CmdOrCtrl+Shift+O")).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
      key: "O",
    });
    expect(acceleratorToChord("CmdOrCtrl+Shift+O")).toBe("ctrl+shift+o");
    expect(chordToAccelerator("ctrl+shift+o")).toBe("CmdOrCtrl+Shift+O");
    expect(acceleratorToChord("Ctrl+,")).toBe("ctrl+,");
    expect(parseMenuAccelerator("Hyper+Q")).toBeNull();
  });

  it("builds the accelerator map from a resolved keymap", () => {
    const accelerators = menuAcceleratorsFor(resolveDesktopKeymap({}));
    expect(accelerators["new-session"]).toBe("CmdOrCtrl+N");
    expect(accelerators["check-updates"]).toBeNull();
    expect(accelerators["view-settings"]).toBe("CmdOrCtrl+,");
  });
});

describe("conflicts", () => {
  it("warns when a desktop action collides with a Pi action in the same scope", () => {
    const conflicts = detectDesktopConflicts({
      desktop: resolveDesktopKeymap({ "palette.open": ["ctrl+x"] }),
      pi: { "app.message.copy": ["ctrl+x"] },
    });
    expect(conflicts).toContainEqual({
      chord: "ctrl+x",
      left: "app.message.copy",
      right: "palette.open",
      severity: "warning",
    });
  });

  it("marks Pi's own cross-modal overlap as informational", () => {
    const conflicts = detectDesktopConflicts({
      desktop: resolveDesktopKeymap({}),
      pi: { "app.model.select": ["ctrl+p"], "app.thinking.toggle": ["ctrl+p"] },
    });
    expect(conflicts).toContainEqual(
      expect.objectContaining({ chord: "ctrl+p", severity: "info" }),
    );
  });

  it("includes live extension shortcut chords", () => {
    const conflicts = detectDesktopConflicts({
      desktop: resolveDesktopKeymap({ "transcript.find": ["ctrl+alt+p"] }),
      extensions: [{ key: "ctrl+alt+p", description: "workflow: profile" }],
    });
    expect(
      conflicts.some(
        (conflict) =>
          conflict.left.startsWith("extension:") || conflict.right.startsWith("extension:"),
      ),
    ).toBe(true);
  });

  it("does not warn about a desktop action colliding with itself", () => {
    const conflicts = detectDesktopConflicts({
      desktop: resolveDesktopKeymap({ "session.new": ["ctrl+n"] }),
      pi: {},
    });
    expect(conflicts.filter((conflict) => conflict.chord === "ctrl+n")).toHaveLength(0);
  });
});
