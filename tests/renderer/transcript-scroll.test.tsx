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

/**
 * Auto-follow and jump-to-latest (2026-10-26 session-parity plan step 10).
 *
 * The old viewport only scrolled when the item count changed, so streaming
 * deltas — which grow a block without adding an item — scrolled out of view.
 * jsdom has no layout and no `ResizeObserver`; these tests exercise the
 * deterministic size-signature fallback and the pill.
 */

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

/**
 * jsdom reports zero scroll metrics. Give the scroll container a fixed
 * geometry so the component's real maths can run.
 */
function primeScrollGeometry(): { read: () => number } {
  const element = screen.getByTestId("transcript");
  let scrollTop = 0;
  Object.defineProperty(element, "scrollHeight", { value: 2_000, configurable: true });
  Object.defineProperty(element, "clientHeight", { value: 400, configurable: true });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  return { read: () => scrollTop };
}

function scrollUp(): void {
  const element = screen.getByTestId("transcript");
  // At the top: far from the bottom, so follow detaches.
  element.scrollTop = 0;
  fireEvent.scroll(element);
}

describe("auto-follow", () => {
  it("follows streamed text growth without a new item", () => {
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();

    rerender(<Transcript items={streamingItems("first and a much longer continuation")} />);
    expect(scroll.read()).toBe(2_000);
  });

  it("stops following when the user scrolls up and offers the pill", () => {
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();
    scrollUp();

    rerender(<Transcript items={streamingItems("first + more text")} />);
    expect(scroll.read()).toBe(0);
    expect(screen.getByTestId("jump-to-latest")).toHaveTextContent("New messages");
  });

  it("re-pins and clears the pill when it is clicked", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();
    scrollUp();
    rerender(<Transcript items={streamingItems("first + more text")} />);

    await user.click(screen.getByTestId("jump-to-latest"));
    expect(scroll.read()).toBe(2_000);
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });

  it("does not chase the content while an overlay pauses follow", () => {
    const { rerender } = render(<Transcript items={streamingItems("first")} followPaused />);
    const scroll = primeScrollGeometry();

    rerender(<Transcript items={streamingItems("first + more text")} followPaused />);
    expect(scroll.read()).toBe(0);
  });

  it("does not chase the content while the user has a selection", () => {
    const { rerender } = render(<Transcript items={streamingItems("first")} />);
    const scroll = primeScrollGeometry();
    const transcript = screen.getByTestId("transcript");
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
});
