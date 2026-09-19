import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer, isSendKey } from "../../src/renderer/src/session/Composer";
import type { ImageAttachment } from "../../src/renderer/src/session/image-attachment";

/**
 * The composer (plan step 6). The behaviours worth pinning are the ones that
 * silently lose a user's work or send at the wrong moment: Enter vs Shift+Enter,
 * an IME composition, and the steer/follow-up choice while streaming.
 */

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn(async (_text: string, _images: ImageAttachment[]) => true);
  const onStop = vi.fn();
  const onClearQueue = vi.fn();
  const onSendModeChange = vi.fn();
  const onDraftChange = vi.fn();
  const props: Parameters<typeof Composer>[0] = {
    tabId: "tab-1",
    running: false,
    draft: "",
    queue: { steering: [], followUp: [] },
    sendMode: "steer",
    onDraftChange,
    onSend,
    onStop,
    onClearQueue,
    onSendModeChange,
    onHistoryStep: () => null,
    ...overrides,
  };
  render(<Composer {...props} />);
  return { onSend, onStop, onClearQueue, onSendModeChange, onDraftChange };
}

describe("sending", () => {
  it("sends on Enter and not on Shift+Enter", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ draft: "hello" });

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe("hello");
  });

  it("does nothing for an empty prompt", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ draft: "   " });
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("never sends while an IME composition is in progress", () => {
    const { onSend } = renderComposer({ draft: "こんにち" });
    const textarea = screen.getByLabelText("Prompt");

    const composing = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    Object.defineProperty(composing, "isComposing", { value: true });
    textarea.dispatchEvent(composing);
    expect(onSend).not.toHaveBeenCalled();

    // The guard itself, independent of the DOM plumbing.
    expect(isSendKey({ key: "Enter", shiftKey: false, altKey: false, isComposing: true })).toBe(
      false,
    );
    expect(isSendKey({ key: "Enter", shiftKey: false, altKey: false })).toBe(true);
    expect(isSendKey({ key: "Enter", shiftKey: true, altKey: false })).toBe(false);
  });
});

describe("streaming delivery", () => {
  it("marks a send with the chosen mode while running", async () => {
    const user = userEvent.setup();
    const { onSend, onSendModeChange } = renderComposer({ running: true, draft: "change of plan" });
    const prompt = screen.getByLabelText("Prompt");

    // The default delivery mode comes from the store (steer), so a plain Enter sends.
    await user.click(prompt);
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "follow-up mode" }));
    expect(onSendModeChange).toHaveBeenCalledWith("followUp");

    await user.click(prompt);
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it("stops the run on Escape while streaming", async () => {
    const user = userEvent.setup();
    const { onStop } = renderComposer({ running: true, draft: "half typed" });
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Escape}");
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("offers Stop only while running", () => {
    renderComposer({ running: true });
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    screen.getByRole("button", { name: /stop/i }).remove();
  });
});

describe("queue and attachments", () => {
  it("shows the queue and clears it", async () => {
    const user = userEvent.setup();
    const { onClearQueue } = renderComposer({
      running: true,
      queue: { steering: ["stop and test"], followUp: ["then commit"] },
    });

    const chips = screen.getByTestId("queue-chips");
    expect(chips.textContent).toContain("stop and test");
    expect(chips.textContent).toContain("then commit");

    await user.click(screen.getByRole("button", { name: /clear queue/i }));
    expect(onClearQueue).toHaveBeenCalledTimes(1);
  });

  it("turns a pasted image into an attachment sent with the prompt", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ draft: "look at this" });
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

    fireEvent.paste(screen.getByLabelText("Prompt"), { clipboardData: { files: [file] } });
    expect(await screen.findByTestId("attachments")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledTimes(1);
    const images = onSend.mock.calls[0]?.[1];
    expect(images).toHaveLength(1);
    expect(images?.[0]?.mimeType).toBe("image/png");
    expect((images?.[0]?.data.length ?? 0) > 0).toBe(true);
  });

  it("removes an attachment again", async () => {
    const user = userEvent.setup();
    renderComposer({ draft: "look" });
    const file = new File([new Uint8Array([9])], "shot.png", { type: "image/png" });
    fireEvent.paste(screen.getByLabelText("Prompt"), { clipboardData: { files: [file] } });
    await screen.findByTestId("attachments");

    await user.click(screen.getByRole("button", { name: /remove shot\.png/i }));
    expect(screen.queryByTestId("attachments")).not.toBeInTheDocument();
  });

  it("explains itself when the session cannot take prompts", () => {
    renderComposer({ enabled: false });
    expect(screen.getByLabelText("Prompt")).toBeDisabled();
  });
});

describe("history", () => {
  it("walks back through previous prompts from an empty draft", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    renderComposer({
      draft: "",
      onDraftChange,
      onHistoryStep: (direction: 1 | -1) => (direction === -1 ? "earlier prompt" : null),
    });
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{ArrowUp}");
    expect(onDraftChange).toHaveBeenCalledWith("earlier prompt");
  });
});

describe("send mode memory", () => {
  it("reports a mode change", async () => {
    const user = userEvent.setup();
    const { onSendModeChange } = renderComposer({ running: true });
    await user.click(screen.getByRole("button", { name: "follow-up mode" }));
    expect(onSendModeChange).toHaveBeenCalledWith("followUp");
  });

  it("renders the hint row", () => {
    renderComposer();
    const hints = screen.getByText(/commands/);
    expect(hints.textContent).toContain("commands");
  });
});
