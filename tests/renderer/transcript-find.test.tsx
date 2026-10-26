import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Transcript } from "../../src/renderer/src/session/Transcript";
import {
  createTranscriptState,
  reduceSessionEvents,
  type TranscriptItem,
} from "../../src/renderer/src/session/session-events";
import { fixtures } from "./fixtures/session-events";
import { installBridge } from "./fixtures";

/**
 * The transcript find bar (2026-10-26 session-parity plan step 11): `Ctrl+F`
 * opens it, matches highlight inline, and Enter/Shift+Enter walk them.
 */

beforeEach(() => {
  installBridge();
});

function items(): TranscriptItem[] {
  return reduceSessionEvents(createTranscriptState(), [
    fixtures.messageStart({ role: "user", content: "where is the gizmo" }, "u1"),
    fixtures.messageEnd({ role: "user", content: "where is the gizmo" }, "u1"),
    fixtures.messageStart({ role: "assistant" }, "a1"),
    fixtures.messageUpdate({ type: "text_start", contentIndex: 0 }),
    fixtures.messageUpdate({ type: "text_delta", contentIndex: 0, delta: "One gizmo here." }),
    fixtures.messageEnd(
      { role: "assistant", content: [{ type: "text", text: "One gizmo here." }] },
      "a1",
    ),
    fixtures.toolStart("call-1", "read", { path: "gizmo.txt" }),
    fixtures.toolEnd("call-1", "read", { content: [{ type: "text", text: "second gizmo" }] }),
  ]).items;
}

async function openFind(query: string): Promise<HTMLInputElement> {
  fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
  const input = screen.getByLabelText("Find in transcript") as HTMLInputElement;
  await userEvent.type(input, query);
  return input;
}

describe("transcript find", () => {
  it("opens on Ctrl+F and closes on Escape", async () => {
    render(<Transcript items={items()} />);
    const input = await openFind("gizmo");
    expect(input.value).toBe("gizmo");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("transcript-find")).toBeNull();
  });

  it("highlights matches inline and counts them", async () => {
    const { container } = render(<Transcript items={items()} />);
    await openFind("gizmo");

    await waitFor(() =>
      expect(screen.getByTestId("transcript-find-count")).toHaveTextContent(/^1\/\d+$/),
    );
    await waitFor(() => {
      const marks = container.querySelectorAll("mark.pi-find");
      expect(marks.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("walks matches with Enter and Shift+Enter, wrapping", async () => {
    render(<Transcript items={items()} />);
    const input = await openFind("gizmo");
    await waitFor(() =>
      expect(screen.getByTestId("transcript-find-count")).toHaveTextContent("1/"),
    );

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("transcript-find-count").textContent).toMatch(/^2\//),
    );

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("transcript-find-count").textContent).toMatch(/^1\//),
    );
  });

  it("shows an error for an invalid regex instead of failing silently", async () => {
    render(<Transcript items={items()} />);
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    const input = screen.getByLabelText("Find in transcript");
    await userEvent.click(screen.getByLabelText("Regular expression"));
    await userEvent.type(input, "a(");
    await waitFor(() =>
      expect(screen.getByTestId("transcript-find-count")).toHaveTextContent("invalid"),
    );
  });

  it("reports no results for a query that is not there", async () => {
    render(<Transcript items={items()} />);
    await openFind("nonexistent-token");
    await waitFor(() =>
      expect(screen.getByTestId("transcript-find-count")).toHaveTextContent("no results"),
    );
  });
});
