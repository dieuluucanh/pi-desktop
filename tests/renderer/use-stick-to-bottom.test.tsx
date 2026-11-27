import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  useStickToBottom,
  type StickToBottom,
} from "../../src/renderer/src/session/use-stick-to-bottom";

/**
 * The engine contract for the transcript follow hook (plan step 1, extended for
 * pinned-state follow in step 2).
 *
 * jsdom has no layout and no `ResizeObserver`; these tests prime the scroller's
 * metrics by hand, the same way `transcript-scroll.test.tsx` does, and drive the
 * hook through its own minimal harness so the assertions are about the engine
 * rather than the transcript's markup.
 */

let api: StickToBottom | null = null;

function Harness({
  itemCount = 1,
  contentSignature = 1,
  contentSize = 0,
  paused = false,
}: {
  itemCount?: number;
  contentSignature?: number;
  contentSize?: number;
  paused?: boolean;
}) {
  const follow = useStickToBottom({ itemCount, contentSignature, contentSize, paused });
  api = follow;
  return (
    <div>
      <div ref={follow.scrollRef} data-testid="scroller">
        <div ref={follow.contentRef} data-testid="content">
          streamed text
        </div>
      </div>
      <span data-testid="at-bottom">{String(follow.atBottom)}</span>
      <span data-testid="has-news">{String(follow.hasNews)}</span>
    </div>
  );
}

interface ScrollGeometry {
  read: () => number;
  write: (value: number) => void;
  setScrollHeight: (value: number) => void;
}

/** jsdom reports zero scroll metrics; give the scroller a fixed geometry. */
function primeScrollGeometry(): ScrollGeometry {
  const element = screen.getByTestId("scroller");
  let scrollTop = 0;
  let scrollHeight = 2_000;
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", { value: 400, configurable: true });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  return {
    read: () => scrollTop,
    write: (value: number) => {
      scrollTop = value;
    },
    setScrollHeight: (value: number) => {
      scrollHeight = value;
    },
  };
}

/** A scrollbar drag: the viewport moves and only a `scroll` event follows. */
function dragTo(scroll: ScrollGeometry, value: number): void {
  scroll.write(value);
  fireEvent.scroll(screen.getByTestId("scroller"));
}

/** A real upward gesture: wheel up, then the scroll event the browser fires. */
function gestureUp(scroll: ScrollGeometry, value: number): void {
  fireEvent.wheel(screen.getByTestId("scroller"), { deltaY: -120 });
  dragTo(scroll, value);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

describe("useStickToBottom", () => {
  it("starts pinned and pins again when streamed content grows without new items", () => {
    const { rerender } = render(<Harness contentSignature={1} />);
    const scroll = primeScrollGeometry();
    expect(api?.isPinned()).toBe(true);

    rerender(<Harness contentSignature={2} />);

    expect(scroll.read()).toBe(2_000);
    expect(screen.getByTestId("at-bottom")).toHaveTextContent("true");
    expect(screen.getByTestId("has-news")).toHaveTextContent("false");
  });

  it("pins when the item count grows", () => {
    const { rerender } = render(<Harness itemCount={1} contentSignature={1} />);
    const scroll = primeScrollGeometry();

    rerender(<Harness itemCount={2} contentSignature={1} />);

    expect(scroll.read()).toBe(2_000);
  });

  it("keeps following when the content grew and the viewport did not move", () => {
    const { rerender } = render(<Harness contentSignature={1} />);
    const scroll = primeScrollGeometry();
    dragTo(scroll, 1_600);

    // A coalesced delta adds 400 px; the scroll event arrives with `scrollTop`
    // still on the old tail. Only the pinned baseline can tell this from intent.
    scroll.setScrollHeight(2_400);
    dragTo(scroll, 1_600);

    expect(api?.isPinned()).toBe(true);
    expect(screen.getByTestId("at-bottom")).toHaveTextContent("true");
    expect(screen.getByTestId("has-news")).toHaveTextContent("false");

    rerender(<Harness contentSignature={2} />);
    expect(scroll.read()).toBe(2_400);
  });

  it("detaches on a wheel gesture and offers the pill on later growth", () => {
    const { rerender } = render(<Harness contentSignature={1} />);
    const scroll = primeScrollGeometry();
    gestureUp(scroll, 0);

    expect(api?.isPinned()).toBe(false);
    expect(screen.getByTestId("at-bottom")).toHaveTextContent("false");

    rerender(<Harness contentSignature={2} />);
    expect(scroll.read()).toBe(0);
    expect(screen.getByTestId("has-news")).toHaveTextContent("true");
  });

  it("detaches on a scrollbar drag that lands above the baseline", () => {
    render(<Harness contentSignature={1} />);
    const scroll = primeScrollGeometry();
    dragTo(scroll, 1_600);

    dragTo(scroll, 900);

    expect(api?.isPinned()).toBe(false);
    expect(screen.getByTestId("has-news")).toHaveTextContent("false");
  });

  it("re-records the baseline instead of detaching when the content shrinks", () => {
    const { rerender } = render(<Harness contentSignature={1} />);
    const scroll = primeScrollGeometry();
    dragTo(scroll, 1_600);

    // The content shrank to 1 000 px and the browser clamped `scrollTop` to the
    // new tail (600). That is not an upward move.
    scroll.setScrollHeight(1_000);
    dragTo(scroll, 600);

    expect(api?.isPinned()).toBe(true);
    expect(screen.getByTestId("has-news")).toHaveTextContent("false");

    rerender(<Harness contentSignature={2} />);
    expect(scroll.read()).toBe(1_000);
  });

  it("detaches on a keyboard PageUp gesture", () => {
    render(<Harness contentSignature={1} />);
    primeScrollGeometry();

    fireEvent.keyDown(screen.getByTestId("scroller"), { key: "PageUp" });

    expect(api?.isPinned()).toBe(false);
    expect(screen.getByTestId("at-bottom")).toHaveTextContent("false");
  });

  it("re-attaches when a scroll event proves the viewport is back at the bottom", () => {
    const { rerender } = render(<Harness contentSignature={1} />);
    const scroll = primeScrollGeometry();
    gestureUp(scroll, 0);
    rerender(<Harness contentSignature={2} />);
    expect(screen.getByTestId("has-news")).toHaveTextContent("true");

    dragTo(scroll, 1_600);

    expect(api?.isPinned()).toBe(true);
    expect(screen.getByTestId("has-news")).toHaveTextContent("false");

    rerender(<Harness contentSignature={3} />);
    expect(scroll.read()).toBe(2_000);
  });

  it("does not move the viewport out from under a live selection", () => {
    const { rerender } = render(<Harness contentSignature={1} />);
    const scroll = primeScrollGeometry();
    const range = document.createRange();
    range.selectNodeContents(screen.getByTestId("content"));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    rerender(<Harness contentSignature={2} />);

    expect(scroll.read()).toBe(0);
    expect(screen.getByTestId("at-bottom")).toHaveTextContent("false");
    expect(screen.getByTestId("has-news")).toHaveTextContent("true");
    // The pin itself was untouched, so clearing the selection resumes follow.
    expect(api?.isPinned()).toBe(true);

    window.getSelection()?.removeAllRanges();
    rerender(<Harness contentSignature={3} />);
    expect(scroll.read()).toBe(2_000);
    expect(screen.getByTestId("has-news")).toHaveTextContent("false");
  });

  it("stops chasing growth while follow is paused and re-pins on resume", () => {
    const { rerender } = render(<Harness contentSignature={1} paused />);
    const scroll = primeScrollGeometry();

    rerender(<Harness contentSignature={2} paused />);
    expect(scroll.read()).toBe(0);

    rerender(<Harness contentSignature={2} />);
    expect(scroll.read()).toBe(2_000);
  });

  it("a forced jump scrolls to the bottom, pins and clears the pill", () => {
    render(<Harness contentSignature={1} />);
    const scroll = primeScrollGeometry();
    gestureUp(scroll, 0);
    expect(api?.isPinned()).toBe(false);

    act(() => api?.scrollToBottom("smooth", { force: true }));

    expect(scroll.read()).toBe(2_000);
    expect(api?.isPinned()).toBe(true);
    expect(screen.getByTestId("at-bottom")).toHaveTextContent("true");
    expect(screen.getByTestId("has-news")).toHaveTextContent("false");
  });

  it("ignores the scroll events a smooth jump produces mid-flight", () => {
    render(<Harness contentSignature={1} />);
    const scroll = primeScrollGeometry();
    gestureUp(scroll, 0);

    act(() => api?.scrollToBottom("smooth", { force: true }));
    // An animation frame lands short of the tail; the guard must not read it as
    // the reader's intent.
    dragTo(scroll, 1_200);

    expect(api?.isPinned()).toBe(true);
    expect(screen.getByTestId("has-news")).toHaveTextContent("false");
  });

  it("treats the virtualizer's total size as content, exactly like the text signature", () => {
    // The virtualized transcript's total size changes when a measured row
    // settles — no text and no item changes — so it is a content signal of its
    // own (2026-11-25 plan step 3).
    const { rerender } = render(<Harness contentSignature={1} contentSize={5_760} />);
    const scroll = primeScrollGeometry();
    gestureUp(scroll, 0);
    expect(api?.isPinned()).toBe(false);

    rerender(<Harness contentSignature={1} contentSize={6_400} />);

    // The pill is honest: the content grew while the reader was above.
    expect(screen.getByTestId("has-news")).toHaveTextContent("true");
    expect(scroll.read()).toBe(0);

    // Back on the tail, the next size change pins to the new bottom.
    dragTo(scroll, 1_600);
    scroll.setScrollHeight(2_400);
    rerender(<Harness contentSignature={1} contentSize={6_800} />);

    expect(scroll.read()).toBe(2_400);
    expect(screen.getByTestId("has-news")).toHaveTextContent("false");
  });

  it("detachForJump unpins so a search jump does not fight the next pin", () => {
    const { rerender } = render(<Harness contentSignature={1} />);
    const scroll = primeScrollGeometry();

    act(() => api?.detachForJump());

    expect(api?.isPinned()).toBe(false);
    expect(screen.getByTestId("at-bottom")).toHaveTextContent("false");

    rerender(<Harness contentSignature={2} />);
    expect(scroll.read()).toBe(0);
    expect(screen.getByTestId("has-news")).toHaveTextContent("true");
  });
});
