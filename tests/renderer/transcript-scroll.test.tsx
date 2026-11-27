import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Transcript } from "../../src/renderer/src/session/Transcript";
import {
  createTranscriptState,
  reduceSessionEvents,
  type TranscriptItem,
} from "../../src/renderer/src/session/session-events";
import { fixtures } from "./fixtures/session-events";
import { installBridge } from "./fixtures";
import { withVirtualizedGeometry } from "./fixtures/virtualizer-geometry";
import { TRANSCRIPT_VIRTUALIZE_THRESHOLD } from "../../src/shared/performance";

/**
 * Auto-follow and jump-to-latest (2026-10-26 session-parity plan step 10,
 * rewritten for pinned-state follow in the 2026-11-25 transcript follow plan
 * step 2).
 *
 * The old viewport only scrolled when the item count changed, so streaming
 * deltas — which grow a block without adding an item — scrolled out of view.
 * The follow decision is now a state: content growth never detaches, only a
 * real gesture (wheel up, touch drag, PageUp/Home/ArrowUp) or a scrollbar drag
 * above the recorded baseline does.
 *
 * jsdom has no layout and no `ResizeObserver`; these tests prime the scroller's
 * metrics by hand and drive the deterministic size-signature fallback.
 */

const VIEWPORT_PX = 400;
/** The tail of the initial 2 000 px transcript (2 000 − 400). */
const TAIL_PX = 1_600;

beforeEach(() => {
  installBridge();
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

/** One assistant message whose text is progressively longer. */
function streamingItems(text: string): TranscriptItem[] {
  return reduceSessionEvents(createTranscriptState(), [
    fixtures.messageStart({ role: "assistant" }, "assistant-1"),
    fixtures.messageUpdate({ type: "text_start", contentIndex: 0 }),
    fixtures.messageUpdate({ type: "text_delta", contentIndex: 0, delta: text }),
  ]).items;
}

interface ScrollGeometry {
  read: () => number;
  write: (value: number) => void;
  setScrollHeight: (value: number) => void;
}

/**
 * jsdom reports zero scroll metrics. Give the scroll container a fixed geometry
 * so the component's real maths can run, and let a test grow the content the way
 * a coalesced `message_update` does.
 */
function primeScrollGeometry(): ScrollGeometry {
  const element = screen.getByTestId("transcript");
  let scrollTop = 0;
  let scrollHeight = 2_000;
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", { value: VIEWPORT_PX, configurable: true });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  return {
    read: () => scrollTop,
    write: (value) => {
      scrollTop = value;
    },
    setScrollHeight: (value) => {
      scrollHeight = value;
    },
  };
}

function scroller(): HTMLElement {
  return screen.getByTestId("transcript");
}

/**
 * Geometry for the virtualized branch. Unlike `primeScrollGeometry`, the
 * `scrollTop` setter clamps the way a browser does, because the pin writes the
 * whole `scrollHeight` and lands on `scrollHeight - clientHeight`.
 */
function primeVirtualizedGeometry(): ScrollGeometry {
  const element = scroller();
  let scrollTop = 0;
  let scrollHeight = 2_000;
  const bottom = (): number => Math.max(0, scrollHeight - VIEWPORT_PX);
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", { value: VIEWPORT_PX, configurable: true });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, bottom()));
    },
  });
  return {
    read: () => scrollTop,
    write: (value) => {
      scrollTop = Math.max(0, Math.min(value, bottom()));
    },
    setScrollHeight: (value) => {
      scrollHeight = value;
    },
  };
}

/** Items that only render a notice, so a test can pad past the threshold. */
function noticeItems(count: number): TranscriptItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "notice",
    id: `virtual-notice-${index}`,
    notice: {
      id: `virtual-n-${index}`,
      severity: "info",
      event: "notice",
      text: `notice ${index}`,
    },
  }));
}

/**
 * Put the viewport on the tail the way the mount pin does. The geometry is
 * primed after the first render, so the first scroll is what records the
 * baseline the detach tests measure against.
 */
function settleOnTail(scroll: ScrollGeometry): void {
  scroll.write(TAIL_PX);
  fireEvent.scroll(scroller());
}

/** A real upward gesture: wheel up, then the scroll event the browser fires. */
function scrollUp(scroll: ScrollGeometry, to = TAIL_PX - 700): void {
  fireEvent.wheel(scroller(), { deltaY: -120 });
  scroll.write(to);
  fireEvent.scroll(scroller());
}

describe("auto-follow", () => {
  it("follows streamed text growth without a new item", () => {
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();

    rerender(<Transcript items={streamingItems("first and a much longer continuation")} />);
    expect(scroll.read()).toBe(2_000);
  });

  it("keeps following when one commit adds more than the old threshold", () => {
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();
    settleOnTail(scroll);

    // A single coalesced delta adds 400 px: the browser fires `scroll` after the
    // content grew, with `scrollTop` still on the old tail. The 80 px distance
    // rule detached here; pinned-state follow must not.
    scroll.setScrollHeight(2_400);
    fireEvent.scroll(scroller());

    expect(scroll.read()).toBe(TAIL_PX);
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();

    rerender(<Transcript items={streamingItems("first and a much longer continuation")} />);
    expect(scroll.read()).toBe(2_400);
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });

  it("keeps following through a burst of growth across several scroll events", () => {
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();
    settleOnTail(scroll);

    for (const height of [2_100, 2_200, 2_300, 2_400]) {
      scroll.setScrollHeight(height);
      fireEvent.scroll(scroller());
      expect(screen.queryByTestId("jump-to-latest")).toBeNull();
    }
    expect(scroll.read()).toBe(TAIL_PX);

    rerender(<Transcript items={streamingItems("first and a much longer continuation")} />);
    expect(scroll.read()).toBe(2_400);
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });

  it("detaches on a scrollbar drag upward, without any gesture event", () => {
    render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();
    settleOnTail(scroll);

    // No wheel: a scrollbar drag only ever produces scroll events.
    scroll.write(900);
    fireEvent.scroll(scroller());

    expect(screen.getByTestId("jump-to-latest")).toHaveTextContent("Jump to latest");
  });

  it("re-attaches and clears the pill when the reader scrolls back to the bottom", () => {
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();
    settleOnTail(scroll);
    scrollUp(scroll);
    rerender(<Transcript items={streamingItems("first + more text")} />);
    expect(screen.getByTestId("jump-to-latest")).toHaveTextContent("New messages");

    scroll.write(TAIL_PX);
    fireEvent.scroll(scroller());

    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
    rerender(<Transcript items={streamingItems("first + more text, continued")} />);
    expect(scroll.read()).toBe(2_000);
  });

  it("stops following when the user scrolls up and offers the pill", () => {
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();
    scrollUp(scroll, 0);

    rerender(<Transcript items={streamingItems("first + more text")} />);
    expect(scroll.read()).toBe(0);
    expect(screen.getByTestId("jump-to-latest")).toHaveTextContent("New messages");
  });

  it("does not mistake a smooth pill jump for a user scroll", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();
    settleOnTail(scroll);
    scrollUp(scroll);
    rerender(<Transcript items={streamingItems("first + more text")} />);
    expect(screen.getByTestId("jump-to-latest")).toHaveTextContent("New messages");

    await user.click(screen.getByTestId("jump-to-latest"));
    expect(scroll.read()).toBe(2_000);

    // The animation's own frames are ours, not the reader's: a mid-flight scroll
    // event that lands short must neither detach nor re-pin.
    scroll.setScrollHeight(2_400);
    scroll.write(1_200);
    fireEvent.scroll(scroller());
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
    expect(scroll.read()).toBe(1_200);

    // The next pin answers the growth instantly.
    rerender(<Transcript items={streamingItems("first + much more text")} />);
    expect(scroll.read()).toBe(2_400);
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });

  it("re-pins and clears the pill when it is clicked", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();
    scrollUp(scroll);
    rerender(<Transcript items={streamingItems("first + more text")} />);

    await user.click(screen.getByTestId("jump-to-latest"));
    expect(scroll.read()).toBe(2_000);
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });

  it("pins instantly, not smoothly, when a delta grows the content", () => {
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();

    // `scrollToBottom("auto")` is the follow path: the fallback writes
    // `scrollTop = scrollHeight` synchronously, so there is no animated middle
    // to observe (and no guard to miss).
    rerender(<Transcript items={streamingItems("first + more text")} />);
    expect(scroll.read()).toBe(2_000);
  });

  it("pins instantly, not smoothly, when a delta grows the content", () => {
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();

    // `scrollToBottom("auto")` is the follow path: the fallback writes
    // `scrollTop = scrollHeight` synchronously, so there is no animated middle
    // to observe (and no guard to miss).
    rerender(<Transcript items={streamingItems("first + more text")} />);
    expect(scroll.read()).toBe(2_000);
  });

  it("does not chase the content while an overlay pauses follow", () => {
    const { rerender } = render(<Transcript items={streamingItems("first")} followPaused />);
    const scroll = primeScrollGeometry();

    rerender(<Transcript items={streamingItems("first + more text")} followPaused />);
    expect(scroll.read()).toBe(0);

    // Resuming re-pins only because the reader never left the tail.
    rerender(<Transcript items={streamingItems("first + more text")} />);
    expect(scroll.read()).toBe(2_000);
  });

  it("does not chase the content while the user has a selection", () => {
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();
    const transcript = scroller();
    const row = transcript.querySelector("[data-row-index='0']") ?? transcript;
    const range = document.createRange();
    range.selectNodeContents(row);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    rerender(<Transcript items={streamingItems("first + more text")} />);

    // The selection is the user's; auto-follow offers the pill instead of
    // scrolling the viewport (and the selection) away.
    expect(scroll.read()).toBe(0);
    expect(screen.getByTestId("jump-to-latest")).toHaveTextContent("New messages");
  });

  it("jumps to the bottom on Ctrl+End, but not from inside a textarea", () => {
    render(
      <div>
        <Transcript items={streamingItems("first")} />
        <textarea aria-label="editor" />
      </div>,
    );
    const scroll = primeScrollGeometry();

    const editor = screen.getByLabelText("editor");
    editor.focus();
    fireEvent.keyDown(editor, { key: "End", ctrlKey: true });
    expect(scroll.read()).toBe(0);

    fireEvent.keyDown(document.body, { key: "End", ctrlKey: true });
    expect(scroll.read()).toBe(2_000);
  });

  it("does not raise the pill just by mounting a session", () => {
    render(<Transcript items={streamingItems("first")} />);
    primeScrollGeometry();

    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });
});

/**
 * The virtualized path (2026-11-25 plan step 3).
 *
 * Past `TRANSCRIPT_VIRTUALIZE_THRESHOLD` the rows are absolute and estimated at
 * 96 px, so the scroller's `scrollHeight` comes from the virtualizer's total
 * size. That total size is a content signal of its own: a measured row settling
 * changes it without changing any text, and the viewport must still land on the
 * true tail instead of detaching into the pill.
 */
describe("virtualized follow", () => {
  /** The item count the user reported: 60 rows, still one live tail. */
  const VIRTUALIZED_ITEM_COUNT = TRANSCRIPT_VIRTUALIZE_THRESHOLD + 10;

  /** 59 notices plus one streamed message: past the threshold, with a live tail. */
  const tail = (text: string): TranscriptItem[] => [
    ...noticeItems(VIRTUALIZED_ITEM_COUNT - 1),
    ...streamingItems(text),
  ];

  it("keeps a 60-item transcript pinned to the measured tail", () => {
    withVirtualizedGeometry(() => {
      const { container, rerender } = render(<Transcript items={tail("tail")} />);

      // The virtualized branch: absolute `data-index` rows and a total-size
      // spacer instead of the plain list's `data-row-index` rows.
      const rows = container.querySelectorAll("[data-index]");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.className).toContain("absolute");
      expect(container.querySelector("[data-row-index]")).toBeNull();
      const content = screen.getByTestId("transcript-content");
      expect(Number.parseInt(content.style.height, 10)).toBeGreaterThan(0);
      // The browser's scroll anchoring must never compete with the pin.
      expect(scroller().style.overflowAnchor).toBe("none");

      const scroll = primeVirtualizedGeometry();
      // Put the viewport on the primed tail, the way a real mount pin lands.
      scroll.write(2_000);
      fireEvent.scroll(scroller());
      expect(scroll.read()).toBe(2_000 - VIEWPORT_PX);

      // A coalesced delta grows the tail and the virtualizer's total size.
      scroll.setScrollHeight(2_600);
      rerender(<Transcript items={tail("tail, then a burst of streamed text")} />);

      expect(scroll.read()).toBe(2_600 - VIEWPORT_PX);
      expect(screen.queryByTestId("jump-to-latest")).toBeNull();
    });
  });
});
