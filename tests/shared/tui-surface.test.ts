import { describe, expect, it } from "vitest";
import {
  EMPTY_TUI_SURFACE,
  isSingleLineFrame,
  isTuiSlot,
  sanitizeTuiBounds,
  sanitizeTuiFrame,
  sanitizeTuiInput,
  sanitizeTuiResize,
  sanitizeTuiSurfaceSnapshot,
  splitSingleLineFrames,
  tuiSurfaceNeedsAttention,
} from "../../src/shared/tui-surface";

/**
 * The TUI-surface wire model (plan step 17).
 *
 * The renderer must be able to trust nothing: every field of an untrusted push
 * is coerced, oversized frames are bounded, and a malformed snapshot degrades to
 * the empty surface instead of throwing inside render.
 */

describe("tui surface sanitizers", () => {
  it("accepts a well-formed snapshot", () => {
    const snapshot = sanitizeTuiSurfaceSnapshot({
      active: true,
      overlay: false,
      bounds: { row: 2, col: 3, width: 40, height: 10 },
      focus: "custom",
      custom: { seq: 1, width: 40, height: 2, lines: ["hi"], cursor: { row: 1, col: 2 } },
    });
    expect(snapshot.active).toBe(true);
    expect(snapshot.focus).toBe("custom");
    expect(snapshot.custom?.lines).toEqual(["hi"]);
    expect(snapshot.custom?.cursor).toEqual({ row: 1, col: 2 });
    expect(snapshot.bounds).toEqual({ row: 2, col: 3, width: 40, height: 10 });
  });

  it("degrades a malformed snapshot to the empty surface", () => {
    expect(sanitizeTuiSurfaceSnapshot(null)).toEqual(EMPTY_TUI_SURFACE);
    expect(sanitizeTuiSurfaceSnapshot({ focus: "nope", custom: 5 }).focus).toBeNull();
    expect(sanitizeTuiSurfaceSnapshot({}).custom).toBeNull();
  });

  it("rejects impossible frames and bounds", () => {
    expect(sanitizeTuiFrame({ seq: 1, width: 0, height: 1, lines: [] })).toBeNull();
    expect(sanitizeTuiFrame({ seq: 1, width: 10, height: 1, lines: ["a"] })?.width).toBe(10);
    expect(sanitizeTuiBounds({ row: 0, col: 0, width: 0, height: 2 })).toBeNull();
    expect(sanitizeTuiBounds({ row: -1, col: 0, width: 2, height: 2 })).toBeNull();
  });

  it("bounds line count and line length", () => {
    const lines = Array.from({ length: 1500 }, () => "x".repeat(5000));
    const frame = sanitizeTuiFrame({ seq: 1, width: 10, height: 1, lines });
    expect(frame?.lines).toHaveLength(1000);
    expect(frame?.lines[0]).toHaveLength(4000);
  });

  it("keeps a widget key and drops malformed or oversized ones", () => {
    expect(
      sanitizeTuiFrame({ seq: 1, key: "  workflow-todos ", width: 10, height: 1, lines: ["a"] })
        ?.key,
    ).toBe("workflow-todos");
    expect(sanitizeTuiFrame({ seq: 1, key: 7, width: 10, height: 1, lines: ["a"] })?.key).toBe(
      undefined,
    );
    expect(sanitizeTuiFrame({ seq: 1, key: "   ", width: 10, height: 1, lines: ["a"] })?.key).toBe(
      undefined,
    );
    expect(
      sanitizeTuiFrame({ seq: 1, key: "k".repeat(200), width: 10, height: 1, lines: ["a"] })?.key,
    ).toHaveLength(80);
  });

  it("validates resize and input requests", () => {
    expect(sanitizeTuiResize({ rows: 12, cols: 80 })).toEqual({ rows: 12, cols: 80 });
    expect(sanitizeTuiResize({ rows: 0, cols: 80 })).toBeNull();
    expect(sanitizeTuiResize({ rows: 12, cols: 5000 })).toBeNull();
    expect(sanitizeTuiInput({ data: "\x1b[A" })).toEqual({ data: "\x1b[A" });
    expect(sanitizeTuiInput({ data: "" })).toBeNull();
  });

  it("knows its slots and has no editor slot", () => {
    expect(isTuiSlot("custom")).toBe(true);
    expect(isTuiSlot("editor")).toBe(false);
    expect(isTuiSlot("nope")).toBe(false);
  });

  it("ignores an old host's editor frame", () => {
    const snapshot = sanitizeTuiSurfaceSnapshot({
      active: true,
      focus: "editor",
      editor: { seq: 1, width: 10, height: 1, lines: ["EXTENSION EDITOR"], cursor: null },
    });
    expect(snapshot.focus).toBeNull();
    expect("editor" in snapshot).toBe(false);
    expect(snapshot.active).toBe(true);
  });

  it("sanitizes component-widget frames and bounds their count", () => {
    const frame = (seq: number) => ({ seq, width: 20, height: 1, lines: ["widget"] });
    const snapshot = sanitizeTuiSurfaceSnapshot({
      active: true,
      widgetsAbove: [frame(1), { broken: true }, frame(2)],
      widgetsBelow: Array.from({ length: 20 }, (_, index) => frame(index + 10)),
    });
    expect(snapshot.widgetsAbove.map((entry) => entry.lines)).toEqual([["widget"], ["widget"]]);
    expect(snapshot.widgetsBelow).toHaveLength(16);
    expect(sanitizeTuiSurfaceSnapshot({}).widgetsBelow).toEqual([]);
  });

  it("splits only one-line widgets into footer columns", () => {
    const frame = (seq: number, lines: string[]) => ({
      seq,
      width: 20,
      height: lines.length,
      lines,
      cursor: null,
    });
    const one = frame(1, ["pi-lens compact"]);
    const two = frame(2, ["pi-lens", "src/a.ts"]);
    const empty = frame(3, []);

    expect(isSingleLineFrame(one)).toBe(true);
    expect(isSingleLineFrame(two)).toBe(false);
    expect(isSingleLineFrame(empty)).toBe(false);
    expect(splitSingleLineFrames([one, two, empty])).toEqual({
      inline: [one],
      stacked: [two, empty],
    });
  });
});

describe("tui surface stack (row 28)", () => {
  it("keeps every mounted surface bottom-to-top, with the top one mirrored", () => {
    const frame = (seq: number, lines: string[]) => ({
      seq,
      width: 20,
      height: lines.length,
      lines,
      cursor: null,
    });
    const snapshot = sanitizeTuiSurfaceSnapshot({
      active: true,
      overlay: true,
      bounds: { row: 2, col: 0, width: 20, height: 4 },
      focus: "custom",
      custom: frame(3, ["questionnaire"]),
      layers: [
        {
          id: "custom-1",
          overlay: false,
          bounds: null,
          focused: false,
          frame: frame(1, ["review"]),
        },
        {
          id: "overlay-2",
          overlay: true,
          bounds: { row: 2, col: 0, width: 20, height: 4 },
          focused: true,
          frame: frame(2, ["questionnaire"]),
        },
      ],
    });
    expect(snapshot.layers.map((layer) => layer.id)).toEqual(["custom-1", "overlay-2"]);
    expect(snapshot.layers[0]?.frame.lines).toEqual(["review"]);
    expect(snapshot.layers[1]?.focused).toBe(true);
    expect(snapshot.layers[1]?.bounds?.height).toBe(4);
  });

  it("bounds the stack and drops malformed layers", () => {
    const frame = (seq: number) => ({ seq, width: 10, height: 1, lines: ["x"] });
    const layers = Array.from({ length: 20 }, (_, index) => ({
      id: `layer-${index}`,
      overlay: index > 0,
      frame: frame(index + 1),
    }));
    const snapshot = sanitizeTuiSurfaceSnapshot({ active: true, layers });
    expect(snapshot.layers).toHaveLength(8);
    expect(snapshot.layers[0]?.id).toBe("layer-0");
    expect(sanitizeTuiSurfaceSnapshot({ layers: [{ id: "", frame: frame(1) }] }).layers).toEqual(
      [],
    );
    expect(sanitizeTuiSurfaceSnapshot({ layers: [{ id: "a", frame: null }] }).layers).toEqual([]);
  });

  it("raises attention when a background surface newly owns the keyboard", () => {
    const frame = (seq: number) => ({ seq, width: 10, height: 2, lines: ["a", "b"] });
    const empty = sanitizeTuiSurfaceSnapshot({ active: false });
    const one = sanitizeTuiSurfaceSnapshot({
      active: true,
      custom: frame(1),
      layers: [{ id: "custom-1", overlay: false, focused: true, frame: frame(1) }],
    });
    const rerender = sanitizeTuiSurfaceSnapshot({
      active: true,
      custom: frame(2),
      layers: [{ id: "custom-1", overlay: false, focused: true, frame: frame(2) }],
    });
    expect(tuiSurfaceNeedsAttention(undefined, empty)).toBe(false);
    expect(tuiSurfaceNeedsAttention(empty, one)).toBe(true);
    // A repaint of the same mounted surface is not a new request.
    expect(tuiSurfaceNeedsAttention(one, rerender)).toBe(false);
    expect(tuiSurfaceNeedsAttention(empty, empty)).toBe(false);
  });
});
