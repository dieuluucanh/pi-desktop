import { describe, expect, it } from "vitest";

import type { ExtensionWidget } from "../../src/shared/extension-ui";
import type { TuiFrame } from "../../src/shared/tui-surface";
import {
  TODO_PANEL_WIDGET_KEY,
  TODO_STATUS_KEY,
  parseTodoStatus,
  resolveTodoPanel,
  todoPanelActions,
  todoPanelPaletteActions,
  todoPanelToggle,
} from "../../src/shared/workflow-todos";

function frame(lines: string[], key?: string): TuiFrame {
  return {
    seq: 1,
    ...(key === undefined ? {} : { key }),
    width: 80,
    height: lines.length,
    lines,
    cursor: null,
  };
}

function widget(
  lines: string[],
  placement: ExtensionWidget["placement"] = "aboveEditor",
): ExtensionWidget {
  return { key: TODO_PANEL_WIDGET_KEY, lines, placement };
}

describe("parseTodoStatus", () => {
  it("parses the compact expanded, collapsed and hidden statuses", () => {
    expect(parseTodoStatus("☐ Todos 3/12 · expanded")).toEqual({
      done: 3,
      total: 12,
      cancelled: 0,
      stale: false,
      settled: false,
      state: "expanded",
    });
    expect(parseTodoStatus("☐ Todos 3/12 · collapsed")).toMatchObject({
      done: 3,
      total: 12,
      state: "collapsed",
    });
    expect(parseTodoStatus("☐ Todos 3/12 · hidden")).toMatchObject({
      done: 3,
      total: 12,
      state: "hidden",
    });
  });

  it("parses the settled, cancelled, stale and ANSI forms", () => {
    expect(parseTodoStatus("\x1b[32m☑ Todos 2/2 · all done\x1b[0m")).toMatchObject({
      done: 2,
      total: 2,
      settled: true,
      state: "collapsed",
    });
    expect(parseTodoStatus("☑ Todos 1/2 · 1 cancelled · collapsed")).toMatchObject({
      done: 1,
      total: 2,
      cancelled: 1,
      settled: true,
      state: "collapsed",
    });
    expect(parseTodoStatus("☐ Todos 3/12 ⚠ · hidden")).toMatchObject({
      stale: true,
      state: "hidden",
    });
    expect(parseTodoStatus("☐ 3/12 · hidden")).toMatchObject({
      done: 3,
      total: 12,
      state: "hidden",
    });
  });

  it("infers collapsed from a summary line", () => {
    expect(parseTodoStatus("☐ Todos 3/12 · next 4. Build the thing · /todos expand")).toMatchObject(
      {
        done: 3,
        total: 12,
        state: "collapsed",
      },
    );
  });

  it("rejects malformed and impossible counts", () => {
    expect(parseTodoStatus(null)).toBeNull();
    expect(parseTodoStatus("")).toBeNull();
    expect(parseTodoStatus("▶ 3. Step")).toBeNull();
    expect(parseTodoStatus("☐ Todos 0/0 · expanded")).toBeNull();
    expect(parseTodoStatus("☐ Todos 13/12 · expanded")).toBeNull();
    expect(parseTodoStatus("☐ Todos x/12 · expanded")).toBeNull();
  });
});

describe("resolveTodoPanel", () => {
  it("is absent when no source exists", () => {
    expect(resolveTodoPanel()).toMatchObject({ present: false, source: "none" });
    expect(resolveTodoPanel({ statuses: { workflow: "▶ build" } })).toMatchObject({
      present: false,
    });
  });

  it("prefers the compact status, including Review and a hidden panel", () => {
    const snapshot = resolveTodoPanel({
      statuses: {
        workflow: "🔍 review",
        [TODO_STATUS_KEY]: "☐ Todos 3/12 · hidden",
      },
      frames: [frame(["▶ 3. Build"], TODO_PANEL_WIDGET_KEY)],
    });
    expect(snapshot).toMatchObject({
      present: true,
      state: "hidden",
      done: 3,
      total: 12,
      settled: false,
      source: "status",
    });
  });

  it("reads a keyed expanded frame and keeps the status counts", () => {
    const snapshot = resolveTodoPanel({
      frames: [frame(["▶ 3. Build", "☐ 4. Test"], TODO_PANEL_WIDGET_KEY)],
      statuses: { [TODO_STATUS_KEY]: "☐ Todos 3/12 · expanded" },
    });
    expect(snapshot).toMatchObject({
      present: true,
      state: "expanded",
      done: 3,
      total: 12,
      source: "status",
    });
  });

  it("reads a keyed collapsed frame", () => {
    const snapshot = resolveTodoPanel({
      frames: [frame(["☐ Todos 3/12 · next 4. Test · /todos expand"], TODO_PANEL_WIDGET_KEY)],
    });
    expect(snapshot).toMatchObject({
      present: true,
      state: "collapsed",
      done: 3,
      total: 12,
      settled: false,
      source: "frame",
    });
  });

  it("treats an empty keyed frame as hidden", () => {
    expect(resolveTodoPanel({ frames: [frame([], TODO_PANEL_WIDGET_KEY)] })).toMatchObject({
      present: true,
      state: "hidden",
      source: "frame",
    });
  });

  it("reads the above-editor string widget and ignores below-editor ones", () => {
    expect(
      resolveTodoPanel({ widgets: [widget(["☑ Todos 2/2 · all done · /todos expand"])] }),
    ).toMatchObject({ present: true, state: "collapsed", done: 2, total: 2, source: "widget" });
    expect(resolveTodoPanel({ widgets: [widget(["☐ Todos 3/12"], "belowEditor")] })).toMatchObject({
      present: false,
      source: "none",
    });
  });

  it("falls back to the workflow progress and calls the panel hidden", () => {
    expect(resolveTodoPanel({ statuses: { workflow: "▶ build 3/12" }, frames: [] })).toMatchObject({
      present: true,
      state: "hidden",
      done: 3,
      total: 12,
      settled: false,
      source: "workflow",
    });
    expect(resolveTodoPanel({ statuses: { workflow: "◦ 12/12" } })).toMatchObject({
      present: true,
      state: "hidden",
      done: 12,
      total: 12,
      settled: true,
    });
  });

  it("keeps Review progress absent when an old extension sends no todo status", () => {
    expect(
      resolveTodoPanel({
        statuses: { workflow: "🔍 review" },
        frames: [],
      }),
    ).toMatchObject({ present: false, source: "none" });
  });

  it("falls back to a keyless todo frame by its summary or rows", () => {
    expect(
      resolveTodoPanel({ frames: [frame(["☐ Todos 3/12 · next 4. Test · /todos expand"])] }),
    ).toMatchObject({ present: true, state: "collapsed", source: "frame" });
    expect(resolveTodoPanel({ frames: [frame(["▶ 1. Build", "☐ 2. Test"])] })).toMatchObject({
      present: true,
      state: "expanded",
      source: "frame",
    });
  });

  it("ignores unrelated keyless frames", () => {
    expect(resolveTodoPanel({ frames: [frame(["pi-lens: 3 warnings"])] })).toMatchObject({
      present: false,
    });
  });

  it("keeps a stale marker from any source", () => {
    expect(
      resolveTodoPanel({
        statuses: { [TODO_STATUS_KEY]: "☐ Todos 3/12 ⚠ · hidden" },
      }).stale,
    ).toBe(true);
    expect(
      resolveTodoPanel({
        frames: [frame(["☐ Todos 3/12 ⚠ · next 4. Test"])],
      }).stale,
    ).toBe(true);
  });
});

describe("action models", () => {
  it("disables only the action matching the effective state", () => {
    expect(
      todoPanelActions({ state: "expanded" }).map((action) => [action.id, action.disabled]),
    ).toEqual([
      ["auto", false],
      ["expand", true],
      ["collapse", false],
      ["hide", false],
    ]);
    expect(
      todoPanelActions({ state: "collapsed" }).map((action) => [action.id, action.disabled]),
    ).toEqual([
      ["auto", false],
      ["expand", false],
      ["collapse", true],
      ["hide", false],
    ]);
    expect(
      todoPanelActions({ state: "hidden" }).map((action) => [action.id, action.disabled]),
    ).toEqual([
      ["auto", false],
      ["expand", false],
      ["collapse", false],
      ["hide", true],
    ]);
  });

  it("toggles expanded to collapse and everything else to expand", () => {
    expect(todoPanelToggle({ state: "expanded" })).toMatchObject({
      action: "collapse",
      label: "Collapse",
    });
    expect(todoPanelToggle({ state: "collapsed" })).toMatchObject({
      action: "expand",
      label: "Expand",
    });
    expect(todoPanelToggle({ state: "hidden" })).toMatchObject({ action: "expand" });
    expect(todoPanelToggle({ state: null })).toMatchObject({ action: "expand" });
  });

  it("exposes the palette rows with the four verbs and a derived toggle", () => {
    const rows = todoPanelPaletteActions();
    expect(rows.map((row) => row.id)).toEqual(["auto", "expand", "collapse", "hide", "toggle"]);
    expect(rows.at(-1)).toMatchObject({ label: "Todos: Toggle panel", args: null });
    expect(rows.find((row) => row.id === "expand")?.args).toBe("expand");
  });
});
