import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  canonicalKey,
  detectKeybindingConflicts,
  groupKeybindingDefinitions,
  invalidKeyReason,
  KEYBINDING_DEFINITIONS,
  keybindingNamespace,
  normalizeBindingValue,
  resolveKeybindings,
  userKeybindingConflicts,
  validateKeybindings,
} from "../../src/shared/keybindings";

describe("keybinding definitions", () => {
  it("pins the SDK's documented id set (drift fails the test)", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.d.ts",
      ),
      "utf8",
    );
    const ids = new Set<string>();
    const pattern = /readonly "([^"]+)": \{\s*readonly defaultKeys:/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) ids.add(match[1] as string);
    expect(ids.size).toBeGreaterThan(0);
    expect(new Set(KEYBINDING_DEFINITIONS.map((entry) => entry.id))).toEqual(ids);
  });

  it("has no duplicate ids and every entry has a description", () => {
    const ids = KEYBINDING_DEFINITIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of KEYBINDING_DEFINITIONS) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("groups by namespace", () => {
    const groups = groupKeybindingDefinitions();
    const namespaces = groups.map((group) => group.namespace);
    expect(namespaces).toContain("app.session");
    expect(namespaces).toContain("tui.editor");
    expect(namespaces).toEqual([...namespaces].sort());
    expect(keybindingNamespace("app.model.cycleForward")).toBe("app.model");
  });
});

describe("canonicalKey", () => {
  it("treats modifier order as irrelevant", () => {
    expect(canonicalKey("shift+ctrl+o")).toBe(canonicalKey("ctrl+shift+o"));
    expect(canonicalKey("UP")).toBe("up");
  });
});

describe("invalidKeyReason", () => {
  it("accepts plausible keys", () => {
    for (const key of ["enter", "ctrl+c", "shift+tab", "alt+left", "ctrl+alt+]", "pageUp"]) {
      expect(invalidKeyReason(key)).toBeNull();
    }
  });

  it("rejects unknown modifiers with a helpful message", () => {
    expect(invalidKeyReason("control+x")).toMatch(/ctrl/);
    expect(invalidKeyReason("cmd+x")).toMatch(/ctrl/);
    expect(invalidKeyReason("")).not.toBeNull();
  });
});

describe("normalizeBindingValue", () => {
  it("accepts a string or string array, nothing else", () => {
    expect(normalizeBindingValue("ctrl+c")).toEqual(["ctrl+c"]);
    expect(normalizeBindingValue(["a", "b"])).toEqual(["a", "b"]);
    expect(normalizeBindingValue([])).toEqual([]);
    expect(normalizeBindingValue(42)).toBeNull();
    expect(normalizeBindingValue(["a", 1])).toBeNull();
  });
});

describe("validateKeybindings", () => {
  it("flags unknown ids and malformed values without rejecting", () => {
    const validation = validateKeybindings({
      "app.exit": ["ctrl+d"],
      "app.typo": ["ctrl+d"],
      "app.clear": 42,
      "app.tools.expand": ["control+o"],
    });
    expect(validation.unknownIds).toEqual(["app.typo"]);
    expect(validation.issues.map((issue) => issue.id).sort()).toEqual([
      "app.clear",
      "app.tools.expand",
    ]);
  });
});

describe("resolveKeybindings", () => {
  it("overrides defaults and honours unbinding", () => {
    const resolved = resolveKeybindings({ "app.exit": ["ctrl+q"], "app.clear": [] });
    expect(resolved["app.exit"]).toEqual(["ctrl+q"]);
    expect(resolved["app.clear"]).toEqual([]);
    expect(resolved["app.interrupt"]).toEqual(["escape"]);
  });
});

describe("detectKeybindingConflicts", () => {
  it("reports a chord claimed twice, canonically", () => {
    const conflicts = detectKeybindingConflicts({
      a: ["ctrl+o"],
      b: ["ctrl+shift+o", "shift+ctrl+o"],
      c: ["ctrl+o"],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.ids).toEqual(["a", "c"]);
  });

  it("is silent when nothing collides", () => {
    expect(detectKeybindingConflicts({ a: ["ctrl+q"], b: ["ctrl+w"] })).toEqual([]);
  });

  it("documents that Pi's own defaults overlap across modal contexts", () => {
    // Editor, selectors, tree filters and dialogs are modal in terminal Pi, so
    // the documented defaults share chords (e.g. ctrl+c copies, cancels a
    // selection and clears the editor). The UI shows these as informational;
    // only conflicts involving the user's own overrides are actionable.
    const defaults = detectKeybindingConflicts(resolveKeybindings({}));
    expect(defaults.length).toBeGreaterThan(0);
    const copy = defaults.find((entry) => entry.key === "ctrl+c");
    expect(copy?.ids).toEqual(
      expect.arrayContaining(["tui.input.copy", "tui.select.cancel", "app.clear"]),
    );
  });
});

describe("userKeybindingConflicts", () => {
  it("keeps only conflicts involving the user's own overrides", () => {
    const conflicts = detectKeybindingConflicts(resolveKeybindings({ "app.exit": ["ctrl+c"] }));
    const actionable = userKeybindingConflicts(conflicts, { "app.exit": ["ctrl+c"] });
    expect(actionable.map((entry) => entry.key)).toContain("ctrl+c");
    expect(actionable.every((entry) => entry.ids.includes("app.exit"))).toBe(true);
  });
});
