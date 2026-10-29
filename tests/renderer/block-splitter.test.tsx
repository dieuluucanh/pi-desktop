import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { BlockSplitter } from "../../src/renderer/src/rail/BlockSplitter";
import {
  DEFAULT_RAIL_SPLIT,
  MAX_SPLIT_FRACTION,
  MIN_BLOCK_PX,
  MIN_SPLIT_FRACTION,
  SPLITTER_KEYBOARD_STEP,
  SPLITTER_KEYBOARD_STEP_LARGE,
  type RailSplitPrefs,
} from "../../src/shared/rail";

/**
 * The horizontal block splitter.
 *
 * jsdom has no layout, so the container height the drag math needs is stubbed on
 * the ref target. What these tests pin is the gesture contract, not the pixels:
 * a drag commits exactly once (on release, never per move), the keyboard path
 * reaches the same places, the px floor holds at both edges, and a container that
 * measures nothing never fabricates a change.
 */

const BODY = 500;

function renderSplitter(
  overrides: Partial<React.ComponentProps<typeof BlockSplitter>> = {},
  containerHeight: number = BODY,
  edge: "top" | "middle" = "top",
): {
  onChange: ReturnType<typeof vi.fn>;
  onReset: ReturnType<typeof vi.fn>;
  containerRef: React.RefObject<HTMLDivElement | null>;
} {
  const onChange = vi.fn();
  const onReset = vi.fn();
  const containerRef = createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement | null>;
  render(
    <div ref={containerRef} data-testid="container">
      <BlockSplitter
        edge={edge}
        split={DEFAULT_RAIL_SPLIT}
        containerRef={containerRef}
        label="Resize Source Control and Changes"
        onChange={onChange}
        onReset={onReset}
        {...overrides}
      />
    </div>,
  );
  // `clientHeight` is a layout fact jsdom does not compute.
  Object.defineProperty(containerRef.current as HTMLDivElement, "clientHeight", {
    configurable: true,
    value: containerHeight,
  });
  return { onChange, onReset, containerRef };
}

function splitter(edge: "top" | "middle" = "top"): HTMLElement {
  return screen.getByTestId(`rail-splitter-${edge}`);
}

/** jsdom implements no pointer capture, so the handle must tolerate its absence. */
function stubPointerCapture(handle: HTMLElement): void {
  (handle as HTMLElement & { setPointerCapture?: unknown }).setPointerCapture = () => {};
  (handle as HTMLElement & { releasePointerCapture?: unknown }).releasePointerCapture = () => {};
}

describe("BlockSplitter", () => {
  it("is a horizontal separator that a keyboard user can reach", () => {
    renderSplitter();
    expect(splitter()).toHaveAttribute("role", "separator");
    expect(splitter()).toHaveAttribute("aria-orientation", "horizontal");
    expect(splitter()).toHaveAttribute("aria-label", "Resize Source Control and Changes");
    expect(splitter()).toHaveAttribute("tabIndex", "0");
  });

  it("reports the boundary position for assistive tech", () => {
    renderSplitter();
    // Default top is 34 % of the panel.
    expect(splitter()).toHaveAttribute("aria-valuenow", "34");
    expect(splitter()).toHaveAttribute(
      "aria-valuemin",
      String(Math.round(MIN_SPLIT_FRACTION * 100)),
    );
    expect(splitter()).toHaveAttribute(
      "aria-valuemax",
      String(Math.round(MAX_SPLIT_FRACTION * 100)),
    );
  });

  it("moves the reported boundary with the persisted split", () => {
    renderSplitter({ split: { top: 0.5, middle: 0.25 } });
    expect(splitter()).toHaveAttribute("aria-valuenow", "50");
    cleanup();
    // The middle handle sits at top + middle, i.e. 75 %.
    renderSplitter({ split: { top: 0.25, middle: 0.5 } }, BODY, "middle");
    expect(splitter("middle")).toHaveAttribute("aria-valuenow", "75");
  });

  it("commits one change on pointer release, none during the move", () => {
    const { onChange } = renderSplitter();
    const handle = splitter();
    stubPointerCapture(handle);

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 120 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 130 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 130 });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as RailSplitPrefs;
    // Down 30 px of a 500 px body: Top grows, Changes gives the height up, and
    // History — the third block — keeps its 26 %.
    expect(next.top).toBeCloseTo(0.34 + 30 / BODY, 6);
    expect(next.middle).toBeCloseTo(0.4 - 30 / BODY, 6);
    expect(1 - next.top - next.middle).toBeCloseTo(0.26, 6);
  });

  it("stops the drag where the neighbour's px floor begins", () => {
    const { onChange } = renderSplitter();
    const handle = splitter();
    stubPointerCapture(handle);
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 });
    // Far past what `top` may take: Top and Changes share what History leaves,
    // so the drag halts when Changes reaches MIN_BLOCK_PX.
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 400 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 400 });
    const next = onChange.mock.calls[0]?.[0] as RailSplitPrefs;
    expect(next.middle * BODY).toBeCloseTo(MIN_BLOCK_PX, 6);
    // History did not move at this edge.
    expect(1 - next.top - next.middle).toBeCloseTo(0.26, 6);
  });

  it("does not write when a drag lands where it started", () => {
    const { onChange } = renderSplitter();
    const handle = splitter();
    stubPointerCapture(handle);
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cancelling a drag also commits once and clears the in-flight state", () => {
    const { onChange } = renderSplitter();
    const handle = splitter();
    stubPointerCapture(handle);
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 140 });
    fireEvent.pointerCancel(handle, { pointerId: 1, clientY: 140 });
    expect(onChange).toHaveBeenCalledTimes(1);
    // A move after the gesture is over must not resurrect it.
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 300 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("nudges by the keyboard step, and further with Shift", async () => {
    const { onChange } = renderSplitter();
    const user = userEvent.setup();
    splitter().focus();
    await user.keyboard("{ArrowDown}");
    const small = onChange.mock.calls[0]?.[0] as RailSplitPrefs;
    expect(small.top).toBeCloseTo(0.34 + SPLITTER_KEYBOARD_STEP / BODY, 6);

    onChange.mockClear();
    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    const large = onChange.mock.calls[0]?.[0] as RailSplitPrefs;
    expect(large.top).toBeCloseTo(0.34 - SPLITTER_KEYBOARD_STEP_LARGE / BODY, 6);
  });

  it("honours the px floor instead of walking a block to zero", async () => {
    const { onChange } = renderSplitter();
    const user = userEvent.setup();
    splitter().focus();
    // Far more than the block has to give.
    await user.keyboard("{Shift>}{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}{/Shift}");
    for (const call of onChange.mock.calls) {
      const next = call[0] as RailSplitPrefs;
      expect(next.top * BODY).toBeGreaterThanOrEqual(MIN_BLOCK_PX - 1e-6);
      expect(next.top).toBeGreaterThanOrEqual(MIN_SPLIT_FRACTION - 1e-9);
    }
  });

  it("jumps to the floor on Home and the ceiling on End", async () => {
    const { onChange } = renderSplitter();
    const user = userEvent.setup();
    splitter().focus();

    await user.keyboard("{Home}");
    const floor = onChange.mock.calls[0]?.[0] as RailSplitPrefs;
    expect(floor.top).toBeCloseTo(Math.max(MIN_SPLIT_FRACTION, MIN_BLOCK_PX / BODY), 6);
    // History is untouched by this edge; Changes takes the rest.
    expect(1 - floor.top - floor.middle).toBeCloseTo(0.26, 6);

    onChange.mockClear();
    await user.keyboard("{End}");
    const ceiling = onChange.mock.calls[0]?.[0] as RailSplitPrefs;
    expect(ceiling.top).toBeGreaterThan(floor.top);
    // Changes is what gives way, and it too stops at its floor.
    expect(ceiling.middle * BODY).toBeGreaterThanOrEqual(MIN_BLOCK_PX - 1e-6);
    expect(1 - ceiling.top - ceiling.middle).toBeCloseTo(0.26, 6);
  });

  it("moves only the middle boundary for the middle edge", async () => {
    const { onChange } = renderSplitter({ edge: "middle" });
    const user = userEvent.setup();
    screen.getByTestId("rail-splitter-middle").focus();
    await user.keyboard("{ArrowDown}");
    const next = onChange.mock.calls[0]?.[0] as RailSplitPrefs;
    expect(next.top).toBe(DEFAULT_RAIL_SPLIT.top);
    expect(next.middle).toBeCloseTo(0.4 + SPLITTER_KEYBOARD_STEP / BODY, 6);
    // History absorbs the change; Top is fixed.
    expect(1 - next.top - next.middle).toBeCloseTo(0.26 - SPLITTER_KEYBOARD_STEP / BODY, 6);
  });

  it("resets on double-click", async () => {
    const { onReset, onChange } = renderSplitter();
    const user = userEvent.setup();
    await user.dblClick(splitter());
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves the split alone when the container measures nothing", async () => {
    const containerRef = createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement | null>;
    const onChange = vi.fn();
    render(
      <div ref={containerRef}>
        <BlockSplitter
          edge="top"
          split={DEFAULT_RAIL_SPLIT}
          containerRef={containerRef}
          label="Resize Source Control and Changes"
          onChange={onChange}
          onReset={() => {}}
        />
      </div>,
    );
    Object.defineProperty(containerRef.current as HTMLDivElement, "clientHeight", {
      configurable: true,
      value: 0,
    });
    const user = userEvent.setup();
    screen.getByTestId("rail-splitter-top").focus();
    await user.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as RailSplitPrefs;
    // No height means no px scaling: the split comes back unchanged, so the
    // component never fabricates a delta it cannot measure.
    expect(next).toEqual(DEFAULT_RAIL_SPLIT);
  });
});
