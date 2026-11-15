import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../../src/renderer/src/session/Composer";
import type { PromptHistoryStep } from "../../src/renderer/src/session/prompt-history";
import type { VisualLinePosition } from "../../src/renderer/src/session/textarea-visual-lines";

/**
 * The composer's history edges (2026-11-15 plan).
 *
 * jsdom has no textarea layout, so the measurement is mocked: these cases pin
 * how the composer reacts to a displayed row (soft wrap included), how it falls
 * back to logical lines, and which chords never reach history. The real mirror
 * measurement is covered by `tests/e2e/session.spec.ts`.
 */

const measure = vi.hoisted(() => vi.fn());
vi.mock("../../src/renderer/src/session/textarea-visual-lines", () => ({
  textareaVisualLines: measure,
}));

function renderComposer(draft: string) {
  const onHistoryStep = vi.fn((): PromptHistoryStep => ({ kind: "none" }));
  const onRestoreQueue = vi.fn();
  render(
    <Composer
      tabId="tab-1"
      running={false}
      draft={draft}
      queue={{ steering: [], followUp: [] }}
      onDraftChange={vi.fn()}
      onSend={async () => true}
      onStop={vi.fn()}
      onClearQueue={vi.fn()}
      onRestoreQueue={onRestoreQueue}
      onHistoryStep={onHistoryStep}
    />,
  );
  const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
  return { box, onHistoryStep, onRestoreQueue };
}

function rows(row: number, lastRow: number): VisualLinePosition {
  return { row, lastRow };
}

beforeEach(() => {
  measure.mockReset();
});

describe("displayed-row gates", () => {
  it("keeps Up native inside a soft-wrapped paragraph", () => {
    const { box, onHistoryStep } = renderComposer("one long paragraph that wraps");
    measure.mockReturnValue(rows(2, 4));
    box.setSelectionRange(12, 12);

    fireEvent.keyDown(box, { key: "ArrowUp" });

    expect(measure).toHaveBeenCalledWith(box, 12);
    expect(onHistoryStep).not.toHaveBeenCalled();
  });

  it("recalls on the first displayed row from any column", () => {
    const { box, onHistoryStep } = renderComposer("a wrapped draft");
    measure.mockReturnValue(rows(0, 4));
    box.setSelectionRange(6, 6);

    fireEvent.keyDown(box, { key: "ArrowUp" });

    expect(onHistoryStep).toHaveBeenCalledWith(-1, 6);
  });

  it("walks Down only on the last displayed row", () => {
    const middle = renderComposer("one long paragraph that wraps");
    measure.mockReturnValue(rows(1, 4));
    middle.box.setSelectionRange(10, 10);
    fireEvent.keyDown(middle.box, { key: "ArrowDown" });
    expect(middle.onHistoryStep).not.toHaveBeenCalled();
    middle.box.remove();

    const last = renderComposer("one long paragraph that wraps");
    measure.mockReturnValue(rows(4, 4));
    last.box.setSelectionRange(10, 10);
    fireEvent.keyDown(last.box, { key: "ArrowDown" });
    expect(last.onHistoryStep).toHaveBeenCalledWith(1, 10);
  });

  it("falls back to logical lines when layout cannot be measured", () => {
    const { box, onHistoryStep } = renderComposer("first line\nsecond line");
    measure.mockReturnValue(null);

    box.setSelectionRange(box.value.length, box.value.length);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(onHistoryStep).not.toHaveBeenCalled();

    box.setSelectionRange(2, 2);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(onHistoryStep).toHaveBeenCalledWith(-1, 2);
  });
});

describe("native chords", () => {
  it("leaves Shift/Ctrl/Meta arrows to the textarea", () => {
    const { box, onHistoryStep } = renderComposer("a wrapped draft");
    measure.mockReturnValue(rows(0, 4));
    box.setSelectionRange(4, 4);

    fireEvent.keyDown(box, { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(box, { key: "ArrowUp", ctrlKey: true });
    fireEvent.keyDown(box, { key: "ArrowUp", metaKey: true });
    fireEvent.keyDown(box, { key: "ArrowDown", altKey: true });

    expect(onHistoryStep).not.toHaveBeenCalled();
    // The modifier guard runs before the measurement: no layout work either.
    expect(measure).not.toHaveBeenCalled();
  });

  it("keeps Alt+Up as the dequeue chord, not history", () => {
    const { box, onHistoryStep, onRestoreQueue } = renderComposer("a wrapped draft");
    measure.mockReturnValue(rows(0, 4));
    box.setSelectionRange(4, 4);

    fireEvent.keyDown(box, { key: "ArrowUp", altKey: true });

    expect(onRestoreQueue).toHaveBeenCalledTimes(1);
    expect(onHistoryStep).not.toHaveBeenCalled();
  });

  it("leaves an active selection native even on the first displayed row", () => {
    const { box, onHistoryStep } = renderComposer("a wrapped draft");
    measure.mockReturnValue(rows(0, 4));
    box.setSelectionRange(2, 6);

    fireEvent.keyDown(box, { key: "ArrowUp" });

    expect(onHistoryStep).not.toHaveBeenCalled();
  });
});
