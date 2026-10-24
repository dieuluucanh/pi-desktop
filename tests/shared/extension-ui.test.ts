import { describe, expect, it } from "vitest";

import {
  applyCompletionInPlace,
  EMPTY_EXTENSION_UI,
  extensionWidgetsByPlacement,
  parseExtensionDialogRequest,
  parseExtensionNotification,
  sanitizeCompletionApplyRequest,
  sanitizeCompletionRequest,
  sanitizeCompletionSuggestions,
  sanitizeExtensionUiSnapshot,
  sanitizeExtensionWidget,
} from "../../src/shared/extension-ui";

/** The extension-UI wire model (plan step 16). */

describe("parseExtensionDialogRequest", () => {
  it("parses a select with options and a timeout", () => {
    const request = parseExtensionDialogRequest(
      {
        id: "ui-1",
        method: "select",
        params: { title: "Pick", options: ["a", "b"], timeout: 5000 },
      },
      "tab-1",
      100,
    );
    expect(request).toMatchObject({
      id: "ui-1",
      method: "select",
      title: "Pick",
      options: ["a", "b"],
      timeout: 5000,
      tabId: "tab-1",
      at: 100,
    });
  });

  it("parses confirm/input/editor params", () => {
    expect(
      parseExtensionDialogRequest(
        { id: "c", method: "confirm", params: { title: "?", message: "Sure?" } },
        "t",
      ),
    ).toMatchObject({ method: "confirm", message: "Sure?" });
    expect(
      parseExtensionDialogRequest(
        { id: "i", method: "input", params: { title: "Name", placeholder: "e.g. foo" } },
        "t",
      ),
    ).toMatchObject({ method: "input", placeholder: "e.g. foo" });
    expect(
      parseExtensionDialogRequest({ id: "e", method: "editor", params: { prefill: "hi" } }, "t"),
    ).toMatchObject({ method: "editor", prefill: "hi" });
  });

  it("ignores provider-login prompts (they carry a source) and unknown methods", () => {
    expect(
      parseExtensionDialogRequest(
        { id: "p", method: "input", params: { source: "provider-login", loginId: "l" } },
        "t",
      ),
    ).toBeNull();
    expect(parseExtensionDialogRequest({ id: "x", method: "custom", params: {} }, "t")).toBeNull();
    expect(parseExtensionDialogRequest({ method: "select", params: {} }, "t")).toBeNull();
  });

  it("rejects a non-positive timeout", () => {
    const request = parseExtensionDialogRequest(
      { id: "ui", method: "input", params: { title: "x", timeout: 0 } },
      "t",
    );
    expect(request?.timeout).toBeNull();
  });
});

describe("parseExtensionNotification", () => {
  it("keeps a valid type and defaults the rest to info", () => {
    expect(parseExtensionNotification({ message: "hi", type: "warning" }, "t", 5)).toMatchObject({
      message: "hi",
      type: "warning",
      tabId: "t",
      at: 5,
    });
    expect(parseExtensionNotification({ message: "hi", notifyType: "error" }, "t")?.type).toBe(
      "error",
    );
    expect(parseExtensionNotification({ message: "hi" }, "t")?.type).toBe("info");
    expect(parseExtensionNotification({ type: "error" }, "t")).toBeNull();
  });
});

describe("sanitizeExtensionUiSnapshot", () => {
  it("round-trips a full snapshot", () => {
    const snapshot = sanitizeExtensionUiSnapshot({
      statuses: { build: "passing", bad: 3 },
      widgets: [
        { key: "w", lines: ["one", "two"], placement: "belowEditor" },
        { key: "x", lines: ["above"] },
      ],
      working: { message: "Thinking", visible: false, frames: ["●"], intervalMs: 80 },
      hiddenThinkingLabel: "…",
      title: "My title",
      toolsExpanded: true,
      autocompleteProviders: 2,
      editor: { seq: 4, text: "hello" },
    });
    expect(snapshot).toEqual({
      statuses: { build: "passing" },
      widgets: [
        { key: "w", lines: ["one", "two"], placement: "belowEditor" },
        { key: "x", lines: ["above"], placement: "aboveEditor" },
      ],
      working: { message: "Thinking", visible: false, frames: ["●"], intervalMs: 80 },
      hiddenThinkingLabel: "…",
      title: "My title",
      toolsExpanded: true,
      autocompleteProviders: 2,
      editor: { seq: 4, text: "hello" },
    });
  });

  it("falls back to empty for junk", () => {
    expect(sanitizeExtensionUiSnapshot(null)).toEqual(EMPTY_EXTENSION_UI);
    expect(sanitizeExtensionUiSnapshot({ widgets: [null, 4, { lines: ["x"] }] })).toEqual(
      EMPTY_EXTENSION_UI,
    );
    expect(sanitizeExtensionUiSnapshot({ editor: { seq: "x", text: "y" } }).editor).toBeNull();
  });

  it("filters widgets by placement", () => {
    const snapshot = sanitizeExtensionUiSnapshot({
      widgets: [
        { key: "a", lines: ["1"], placement: "aboveEditor" },
        { key: "b", lines: ["2"], placement: "belowEditor" },
      ],
    });
    expect(extensionWidgetsByPlacement(snapshot, "aboveEditor").map((w) => w.key)).toEqual(["a"]);
    expect(extensionWidgetsByPlacement(snapshot, "belowEditor").map((w) => w.key)).toEqual(["b"]);
  });
});

describe("sanitizeExtensionWidget", () => {
  it("requires a key", () => {
    expect(sanitizeExtensionWidget({ lines: ["x"] })).toBeNull();
    expect(sanitizeExtensionWidget({ key: "k" })).toEqual({
      key: "k",
      lines: [],
      placement: "aboveEditor",
    });
  });
});

describe("completion wire shapes", () => {
  it("requires a usable request", () => {
    expect(sanitizeCompletionRequest({ lines: ["a"], cursorLine: 0, cursorCol: 1 })).toEqual({
      lines: ["a"],
      cursorLine: 0,
      cursorCol: 1,
      base: null,
    });
    expect(sanitizeCompletionRequest({ lines: [], cursorLine: 0, cursorCol: 0 })).toBeNull();
    expect(sanitizeCompletionRequest({ lines: ["a"], cursorLine: "0", cursorCol: 0 })).toBeNull();
  });

  it("drops malformed base suggestions", () => {
    const request = sanitizeCompletionRequest({
      lines: ["a"],
      cursorLine: 0,
      cursorCol: 1,
      base: { prefix: "/", items: [{ value: "/x", label: "/x" }, { label: "no value" }] },
    });
    expect(request?.base).toEqual({ prefix: "/", items: [{ value: "/x", label: "/x" }] });
    expect(
      sanitizeCompletionRequest({
        lines: ["a"],
        cursorLine: 0,
        cursorCol: 1,
        base: { prefix: "/", items: [] },
      })?.base,
    ).toBeNull();
  });

  it("requires a complete apply request", () => {
    expect(
      sanitizeCompletionApplyRequest({
        lines: ["#do"],
        cursorLine: 0,
        cursorCol: 3,
        item: { value: "#doc", label: "#doc" },
        prefix: "#do",
      }),
    ).toEqual({
      lines: ["#do"],
      cursorLine: 0,
      cursorCol: 3,
      item: { value: "#doc", label: "#doc" },
      prefix: "#do",
    });
    expect(
      sanitizeCompletionApplyRequest({ lines: ["x"], cursorLine: 0, cursorCol: 1, prefix: "#" }),
    ).toBeNull();
  });

  it("applies in place, replacing the prefix", () => {
    expect(applyCompletionInPlace(["#do"], 0, 3, { value: "#doc", label: "#doc" }, "#do")).toEqual({
      lines: ["#doc "],
      cursorLine: 0,
      cursorCol: 5,
    });
  });

  it("preserves source and argument apply semantics across the wire", () => {
    const suggestions = sanitizeCompletionSuggestions({
      prefix: "",
      items: [{ value: "use ", label: "use", source: "extension", appendSpace: false }],
    });
    expect(suggestions?.items[0]).toMatchObject({
      value: "use ",
      source: "extension",
      appendSpace: false,
    });

    expect(
      applyCompletionInPlace(
        ["/profile "],
        0,
        9,
        { value: "use ", label: "use", appendSpace: false },
        "",
      ),
    ).toEqual({ lines: ["/profile use "], cursorLine: 0, cursorCol: 13 });
  });
});
