import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer, isSendKey } from "../../src/renderer/src/session/Composer";
import type { ImageAttachment } from "../../src/renderer/src/session/image-attachment";
import type { CompletionProvider } from "../../src/renderer/src/completion/types";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  WORKSPACE_PATH_DRAG_MIME,
  WORKSPACE_PATH_DRAG_VERSION,
  serializeWorkspaceDrag,
  type WorkspaceDragPayload,
} from "../../src/shared/workspace-drag";
import { TAB_DRAG_MIME, TAB_DRAG_VERSION } from "../../src/shared/tab-drag";
/**
 * The composer (plan step 6). The behaviours worth pinning are the ones that
 * silently lose a user's work or send at the wrong moment: Enter vs Shift+Enter,
 * an IME composition, and the steer/follow-up choice while streaming.
 */

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn(
    async (
      _text: string,
      _images: ImageAttachment[],
      _options?: { preferredSource?: unknown; followUp?: boolean },
    ) => true,
  );
  const onStop = vi.fn();
  const onClearQueue = vi.fn();
  const onRestoreQueue = vi.fn();
  const onDraftChange = vi.fn();
  const props: Parameters<typeof Composer>[0] = {
    tabId: "tab-1",
    running: false,
    draft: "",
    queue: { steering: [], followUp: [] },
    onDraftChange,
    onSend,
    onStop,
    onClearQueue,
    onRestoreQueue,
    onHistoryStep: () => null,
    ...overrides,
  };
  const rendered = render(<Composer {...props} />);
  return {
    props,
    onSend,
    onStop,
    onClearQueue,
    onRestoreQueue,
    onDraftChange,
    ...rendered,
  };
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
  it("sends a steer on Enter and a follow-up on Alt+Enter while running", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ running: true, draft: "change of plan" });
    const prompt = screen.getByLabelText("Prompt");

    await user.click(prompt);
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[2]?.followUp).toBeUndefined();

    await user.click(prompt);
    await user.keyboard("{Alt>}{Enter}{/Alt}");
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1]?.[2]?.followUp).toBe(true);
  });

  it("offers one Send button and no steer/follow-up toggles", () => {
    renderComposer({ running: true });

    const send = screen.getByRole("button", { name: /^send$/i });
    expect(send).toHaveClass("h-7", "w-7");
    expect(send.textContent).toBe("");
    expect(screen.getByRole("button", { name: "Attach image" })).toHaveClass("h-7", "w-7");
    expect(screen.getByRole("button", { name: "Stop" })).toHaveClass("h-7", "w-7");
    expect(screen.queryByRole("button", { name: "steer mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "follow-up mode" })).toBeNull();
    expect(screen.getByText(/Alt\+Enter queues a follow-up/)).toBeInTheDocument();
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
  it("shows pending rows with their delivery kind and full text", async () => {
    const user = userEvent.setup();
    const { onClearQueue, onRestoreQueue } = renderComposer({
      running: true,
      queue: {
        steering: ["stop and test the parser"],
        followUp: ["then commit with a long message that would not fit a chip"],
      },
    });

    const pending = screen.getByTestId("pending-queue");
    expect(pending.textContent).toContain("Steering");
    expect(pending.textContent).toContain("Follow-up");
    expect(pending.textContent).toContain("stop and test the parser");
    expect(pending.textContent).toContain(
      "then commit with a long message that would not fit a chip",
    );

    await user.click(screen.getByRole("button", { name: /restore all/i }));
    expect(onRestoreQueue).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /clear queue/i }));
    expect(onClearQueue).toHaveBeenCalledTimes(1);
  });

  it("restores the whole queue on Alt+Up", async () => {
    const user = userEvent.setup();
    const { onRestoreQueue } = renderComposer({
      running: true,
      queue: { steering: ["one"], followUp: [] },
    });
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(onRestoreQueue).toHaveBeenCalledTimes(1);
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

  it("leaves a multi-line draft's caret movement native inside the buffer", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    renderComposer({ draft: "first line\nsecond line", onDraftChange });
    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(box);
    // Caret on the second line: Up must move the caret, not recall history.
    box.setSelectionRange(box.value.length, box.value.length);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("walks forward only at the last line", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    renderComposer({
      draft: "first line\nsecond line",
      onDraftChange,
      onHistoryStep: (direction: 1 | -1) => (direction === 1 ? "newer prompt" : null),
    });
    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(box);
    // Middle of the first line: Down stays native.
    box.setSelectionRange(2, 2);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(onDraftChange).not.toHaveBeenCalled();
    // Last line: Down walks history.
    box.setSelectionRange(box.value.length, box.value.length);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(onDraftChange).toHaveBeenCalledWith("newer prompt");
  });
});

describe("follow-up chords (plan step 9)", () => {
  it("Alt+Enter queues a follow-up while a run is streaming", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ running: true, draft: "then commit" });
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Alt>}{Enter}{/Alt}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[2]).toMatchObject({ followUp: true });
  });

  it("Ctrl+Q queues a follow-up too", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ running: true, draft: "then commit" });
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Control>}q{/Control}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[2]).toMatchObject({ followUp: true });
  });

  it("acts like Enter when nothing is streaming (terminal Pi's fallback)", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ running: false, draft: "just send" });
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Alt>}{Enter}{/Alt}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[2]?.followUp).toBeUndefined();
  });
});

describe("hint row", () => {
  it("renders the hint row", () => {
    renderComposer();
    const hints = screen.getByText(/commands/);
    expect(hints.textContent).toContain("commands");
  });

  it("stops at the hint row, since the footer is a sibling in the session view", () => {
    // 2026-10-19: the session footer moved out of the composer (so it survives an
    // extension-owned editor), so the composer now ends at its hint row.
    renderComposer();
    expect(screen.getByText(/commands/)).toBeInTheDocument();
    expect(screen.queryByTestId("composer-footer")).toBeNull();
  });
});

describe("workflow mode border", () => {
  function promptBox(): HTMLElement {
    return screen.getByLabelText("Prompt");
  }

  it("colours the border and shows a badge in Plan and Build modes", () => {
    // The extension's own status colours (`index.ts:919/928`): plan → warning,
    // build → accent. The border is what tells the user Tab did something —
    // without it the mode changes with no visible feedback in the composer.
    const plan = renderComposer({ workflowStatus: "\u23f8 plan" });
    expect(promptBox()).toHaveClass("border-warn");
    expect(promptBox()).toHaveClass("pr-14");
    expect(screen.getByTestId("workflow-mode-badge")).toHaveTextContent("Plan");
    expect(screen.getByTestId("workflow-mode-badge").firstElementChild).toHaveClass("text-warn");
    plan.unmount();

    renderComposer({ workflowStatus: "\u25b6 build 3/8" });
    expect(promptBox()).toHaveClass("border-accent");
    expect(screen.getByTestId("workflow-mode-badge")).toHaveTextContent("Build");
    expect(screen.getByTestId("workflow-mode-badge").firstElementChild).toHaveClass("text-accent");
  });

  it("decodes an ANSI-coloured status exactly like a plain one", () => {
    renderComposer({ workflowStatus: "\x1b[33m\u23f8 plan\x1b[0m" });
    expect(promptBox()).toHaveClass("border-warn");
  });

  it("labels the plannotator browser-review phase as Plan, not Review", () => {
    // The "reviewing in browser" phrase is a Plan sub-state (Plannotator's
    // phase label), never a mode: the badge always reads Plan (2026-10-20
    // startup-tab-cycle plan). The raw phrase stays visible in the badge's
    // tooltip and the footer's extension-status row.
    renderComposer({ workflowStatus: "\u23f8 plan — reviewing in browser" });
    expect(promptBox()).toHaveClass("border-warn");
    expect(screen.getByTestId("workflow-mode-badge")).toHaveTextContent("Plan");
  });

  it("names the default mode instead of showing nothing", () => {
    // 2026-10-19: the badge was silent in Default, so the only mode with no
    // workflow had no textual indicator at all. Every recognised mode is named.
    renderComposer({ workflowStatus: "\u25e6 commits:never" });
    expect(promptBox()).toHaveClass("border-line");
    expect(promptBox()).toHaveClass("pr-14");
    expect(screen.getByTestId("workflow-mode-badge")).toHaveTextContent("Default");
    expect(screen.getByTestId("workflow-mode-badge").firstElementChild).toHaveClass(
      "text-ink-faint",
    );
  });

  it("renders the badge inside the input's top-right corner", () => {
    renderComposer({ workflowStatus: "\u23f8 plan" });
    const input = screen.getByTestId("composer-input");
    const badge = within(input).getByTestId("workflow-mode-badge");
    // It is part of the composer box, not a floating sibling above it.
    expect(input.contains(badge)).toBe(true);
    expect(badge.className).toContain("absolute");
    expect(badge.className).toContain("top-1");
    expect(badge.className).not.toContain("bottom-1");
  });

  it("keeps the badge readable at every width and to assistive tech", () => {
    renderComposer({ workflowStatus: "\u23f8 plan" });
    const badge = screen.getByTestId("workflow-mode-badge");
    // No breakpoint hiding: the old badge vanished below `sm`.
    expect(badge.className).not.toMatch(/\bhidden\b/);
    expect(badge.className).not.toMatch(/sm:inline-block/);
    // Announced, not `aria-hidden`.
    expect(badge).not.toHaveAttribute("aria-hidden");
    expect(badge).toHaveAttribute("role", "status");
    // The full status stays reachable on hover (profile/role/commit policy).
    expect(badge.getAttribute("title")?.startsWith("\u23f8 plan")).toBe(true);
  });

  it("survives focus without a ring that hides the mode colour", () => {
    // The global `:focus-visible` used to paint a blue outline over the border.
    // Focus is now an outer ring, so `border-*` stays legible; the textarea must
    // never carry a `focus:border-*` that would clobber the mode colour.
    renderComposer({ workflowStatus: "\u25b6 build" });
    const box = promptBox();
    expect(box).toHaveClass("outline-none");
    expect(box.className).toMatch(/focus-visible:ring-2/);
    expect(box.className).toMatch(/ring-line-strong/);
    expect(box.className).not.toMatch(/focus:border-/);
    expect(box).toHaveClass("border-accent");
  });

  it("stays neutral for a missing, empty or unknown status", () => {
    // A wrong colour is worse than no colour: another extension's status must
    // never be misread as a workflow mode.
    for (const value of [undefined, null, "", "office: Excel attached (bridge :38617)"]) {
      const view = renderComposer({ workflowStatus: value });
      expect(promptBox()).toHaveClass("border-line");
      expect(screen.queryByTestId("workflow-mode-badge")).toBeNull();
      view.unmount();
    }
  });
});

describe("auto-growing height", () => {
  function promptBox(): HTMLTextAreaElement {
    return screen.getByLabelText("Prompt") as HTMLTextAreaElement;
  }

  it("grows to its cap and shrinks with the draft", () => {
    const { props, rerender } = renderComposer();
    const box = promptBox();
    Object.defineProperty(box, "scrollHeight", { value: 400, configurable: true });

    rerender(<Composer {...props} draft={"line\n".repeat(20)} />);
    expect(box.style.height).toBe("192px");
    expect(box.style.maxHeight).toBe("192px");

    Object.defineProperty(box, "scrollHeight", { value: 42, configurable: true });
    rerender(<Composer {...props} draft="short" />);
    expect(box.style.height).toBe("42px");
  });

  it("keeps the two-row floor and drops the manual handle", () => {
    renderComposer();
    const box = promptBox();
    expect(box).toHaveAttribute("rows", "2");
    expect(box).toHaveClass("min-h-16", "overflow-y-auto");
    expect(box).not.toHaveClass("resize-y");
    expect(box).not.toHaveClass("max-h-48");
  });
});

describe("extension shortcut dispatch (Tab)", () => {
  function promptBox(): HTMLElement {
    return screen.getByLabelText("Prompt");
  }

  it("runs a registered `tab` shortcut instead of asking for completion", () => {
    // The workflow extension registers `tab` for its mode cycle
    // (`index.ts:2591`). Terminal Pi checks extension shortcuts before the
    // editor (`custom-editor.js:60`), so Tab must reach it — this is the bug
    // that left the mode stuck in Default.
    const onInvokeShortcut = vi.fn();
    renderComposer({
      extensionShortcuts: [{ key: "tab" }],
      onInvokeShortcut,
    });
    fireEvent.keyDown(promptBox(), { key: "Tab" });
    expect(onInvokeShortcut).toHaveBeenCalledTimes(1);
    expect(onInvokeShortcut).toHaveBeenCalledWith("tab");
  });

  it("matches modifiers canonically, so a remap still fires", () => {
    const onInvokeShortcut = vi.fn();
    renderComposer({
      extensionShortcuts: [{ key: "ctrl+alt+p" }],
      onInvokeShortcut,
    });
    fireEvent.keyDown(promptBox(), { key: "p", ctrlKey: true, altKey: true });
    expect(onInvokeShortcut).toHaveBeenCalledWith("ctrl+alt+p");
  });

  it("requests the list when no shortcut is known yet", () => {
    // On a fresh session the shortcuts have not been listed, so the first Tab
    // asks for them (and still falls back to completion).
    const onRequestShortcuts = vi.fn();
    renderComposer({ extensionShortcuts: [], onRequestShortcuts });
    fireEvent.keyDown(promptBox(), { key: "Tab" });
    expect(onRequestShortcuts).toHaveBeenCalledTimes(1);
  });

  it("leaves Tab to an open completion menu", async () => {
    // A visible menu means the user is picking a suggestion; the mode cycle must
    // never steal that Tab (deliberate deviation from Pi, documented in D7).
    const onInvokeShortcut = vi.fn();
    const provider: CompletionProvider = {
      id: "fake",
      async getSuggestions(lines, cursorLine, cursorCol) {
        const line = lines[cursorLine] ?? "";
        if (cursorLine !== 0 || !line.slice(0, cursorCol).startsWith("/")) return null;
        return {
          items: [{ value: "/deploy", label: "/deploy", source: "extension" }],
          prefix: line.slice(0, cursorCol),
        };
      },
      applyCompletion: (lines) => ({ lines: [...lines], cursorLine: 0, cursorCol: 7 }),
    };

    function Harness() {
      const [draft, setDraft] = useState("/");
      return (
        <Composer
          tabId="tab-1"
          running={false}
          draft={draft}
          queue={{ steering: [], followUp: [] }}
          onDraftChange={setDraft}
          onSend={async () => true}
          onStop={() => undefined}
          onClearQueue={() => undefined}
          onRestoreQueue={() => undefined}
          onHistoryStep={() => null}
          extensionShortcuts={[{ key: "tab" }]}
          onInvokeShortcut={onInvokeShortcut}
          completion={{ provider }}
        />
      );
    }

    render(<Harness />);
    const user = userEvent.setup();
    const box = screen.getByLabelText("Prompt");
    await user.click(box);
    await user.keyboard("/");
    await screen.findByTestId("completion-overlay");
    // The menu is open now: a following Tab accepts the item, not the mode.
    await user.keyboard("{Tab}");
    expect(onInvokeShortcut).not.toHaveBeenCalled();
  });
});

describe("sleeping session (2026-10-24 plan)", () => {
  it("stays enabled and wakes on focus, pointer-down and typing", () => {
    const onWake = vi.fn();
    renderComposer({ enabled: true, sleeping: true, onWake });
    const box = screen.getByLabelText("Prompt");

    expect(box).toBeEnabled();
    expect(screen.getByPlaceholderText(/asleep/i)).toBe(box);

    fireEvent.focus(box);
    expect(onWake).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(box);
    expect(onWake).toHaveBeenCalledTimes(2);

    fireEvent.change(box, { target: { value: "/profile" } });
    expect(onWake).toHaveBeenCalledTimes(3);
  });

  it("wakes on interaction even when the tab is ready, not only when asleep", () => {
    const onWake = vi.fn();
    renderComposer({ enabled: true, sleeping: false, onWake });
    const box = screen.getByLabelText("Prompt");

    fireEvent.focus(box);
    fireEvent.pointerDown(box);
    fireEvent.change(box, { target: { value: "hello" } });

    expect(onWake).toHaveBeenCalledTimes(3);
  });

  it("focuses the composer when the view asks (transcript background click)", () => {
    const { rerender } = renderComposer({ enabled: true });
    const box = screen.getByLabelText("Prompt");
    box.blur();
    expect(box).not.toHaveFocus();

    rerender(
      <Composer
        tabId="tab-1"
        running={false}
        draft=""
        queue={{ steering: [], followUp: [] }}
        onDraftChange={() => undefined}
        onSend={async () => true}
        onStop={() => undefined}
        onClearQueue={() => undefined}
        onRestoreQueue={() => undefined}
        onHistoryStep={() => null}
        focusToken={1}
      />,
    );

    expect(box).toHaveFocus();
  });

  it("still gives Tab to the workflow shortcut while sleeping", () => {
    const onInvokeShortcut = vi.fn();
    renderComposer({
      enabled: true,
      sleeping: true,
      extensionShortcuts: [{ key: "tab" }],
      onInvokeShortcut,
    });

    fireEvent.keyDown(screen.getByLabelText("Prompt"), { key: "Tab" });

    expect(onInvokeShortcut).toHaveBeenCalledWith("tab");
  });
});

describe("caret readout", () => {
  // The composer is a controlled textarea, so the readout can only be trusted
  // when the draft follows the keystrokes: this harness keeps them in step.
  function ControlledComposer({ initial = "" }: { initial?: string }) {
    const [draft, setDraft] = useState(initial);
    return (
      <Composer
        tabId="tab-1"
        running={false}
        draft={draft}
        queue={{ steering: [], followUp: [] }}
        onDraftChange={setDraft}
        onSend={async () => true}
        onStop={() => undefined}
        onClearQueue={() => undefined}
        onRestoreQueue={() => undefined}
        onHistoryStep={() => null}
      />
    );
  }

  it("starts at the first line and column", () => {
    render(<ControlledComposer />);
    expect(screen.getByTestId("composer-caret")).toHaveTextContent("Ln 1 · Col 1");
  });

  it("follows the typed characters", async () => {
    const user = userEvent.setup();
    render(<ControlledComposer />);
    await user.type(screen.getByLabelText("Prompt"), "ab");
    expect(screen.getByTestId("composer-caret")).toHaveTextContent("Ln 1 · Col 3");
  });

  it("follows the caret onto a second line", async () => {
    const user = userEvent.setup();
    render(<ControlledComposer />);
    // Shift+Enter inserts the newline; plain Enter would send the prompt.
    await user.type(screen.getByLabelText("Prompt"), "one{Shift>}{Enter}{/Shift}two");
    expect(screen.getByTestId("composer-caret")).toHaveTextContent("Ln 2 · Col 4");
  });

  it("follows a caret move inside the text", async () => {
    const user = userEvent.setup();
    render(<ControlledComposer initial="hello" />);
    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(box);
    box.setSelectionRange(2, 2);
    fireEvent.keyUp(box, { key: "ArrowRight" });
    expect(screen.getByTestId("composer-caret")).toHaveTextContent("Ln 1 · Col 3");
  });

  it("paints the caret with the app accent", () => {
    // The browser's own caret is a thin blinking line; the accent makes it
    // findable in a dark buffer (plan step 1).
    renderComposer();
    expect(screen.getByLabelText("Prompt")).toHaveClass("caret-accent");
  });
});

describe("shell mode", () => {
  it("advertises ! shell in the idle placeholder", () => {
    renderComposer();
    expect(screen.getByLabelText("Prompt")).toHaveAttribute(
      "placeholder",
      "Ask Pi to change something…  / commands · ! shell · @ files · # documents",
    );
  });

  it("lets Tab cycle a shortcut on a shell line when no menu is open", () => {
    const onInvokeShortcut = vi.fn();
    renderComposer({
      draft: "!git status",
      extensionShortcuts: [{ key: "tab" }],
      onInvokeShortcut,
    });

    fireEvent.keyDown(screen.getByLabelText("Prompt"), { key: "Tab" });
    expect(onInvokeShortcut).toHaveBeenCalledTimes(1);
    expect(onInvokeShortcut).toHaveBeenCalledWith("tab");
    expect(screen.queryByTestId("completion-overlay")).toBeNull();
  });

  it("names the mode and explains whether output stays in context", () => {
    const { rerender, props } = renderComposer({ draft: "!git status" });
    expect(screen.getByTestId("composer-shell-mode")).toHaveTextContent(
      "shell · output kept in context",
    );
    expect(screen.getByTestId("composer-shell-hint")).toHaveTextContent("! shell");
    expect(screen.getByLabelText("Prompt")).toHaveClass("border-warn");

    rerender(<Composer {...props} draft="!!git status" />);
    expect(screen.getByTestId("composer-shell-mode")).toHaveTextContent(
      "shell · output excluded from model",
    );
  });

  it("disappears when the shell prefix is removed", () => {
    const { rerender, props } = renderComposer({ draft: "!pwd" });
    expect(screen.getByTestId("composer-shell-mode")).toBeInTheDocument();

    rerender(<Composer {...props} draft="pwd" />);
    expect(screen.queryByTestId("composer-shell-mode")).not.toBeInTheDocument();
  });
});

describe("session tools slot (minimal-session-ui step 4)", () => {
  it("renders the view's tools above Send", () => {
    renderComposer({ toolsSlot: <button type="button">Model picker</button> });

    const tools = screen.getByTestId("composer-tools");
    expect(tools).toHaveTextContent("Model picker");
    const send = screen.getByRole("button", { name: /send/i });
    // The tools row sits in the blank space above the Send row.
    expect(tools.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("adds no row when the view supplies no tools", () => {
    renderComposer();
    expect(screen.queryByTestId("composer-tools")).toBeNull();
  });
});

function workspacePayload(overrides: Partial<WorkspaceDragPayload> = {}): WorkspaceDragPayload {
  return {
    version: WORKSPACE_PATH_DRAG_VERSION,
    projectPath: "C:/work/app",
    path: "src/app.ts",
    kind: "file",
    ...overrides,
  };
}

function fakeDropTransfer(payload?: WorkspaceDragPayload, files: File[] = []) {
  const data = new Map<string, string>();
  if (payload) {
    data.set(WORKSPACE_PATH_DRAG_MIME, serializeWorkspaceDrag(payload));
    data.set("text/plain", payload.path);
  }
  const types = [...data.keys(), ...(files.length > 0 ? ["Files"] : [])];
  return {
    types,
    files,
    dropEffect: "none",
    effectAllowed: "none",
    getData: (type: string) => data.get(type) ?? "",
    setData: (type: string, value: string) => data.set(type, value),
  };
}

describe("workspace drops", () => {
  it("inserts an @mention at the caret", () => {
    const onDraftChange = vi.fn();
    renderComposer({
      draft: "look at ",
      onDraftChange,
      workspaceRoot: "C:/work/app",
    });
    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    box.setSelectionRange(box.value.length, box.value.length);

    fireEvent.drop(screen.getByTestId("composer-drop"), {
      dataTransfer: fakeDropTransfer(workspacePayload()),
    });

    expect(onDraftChange).toHaveBeenCalledWith("look at @src/app.ts ");
  });

  it("quotes a path with spaces and appends at the end", () => {
    const onDraftChange = vi.fn();
    renderComposer({ draft: "", onDraftChange, workspaceRoot: "C:/work/app" });

    fireEvent.drop(screen.getByTestId("composer-drop"), {
      dataTransfer: fakeDropTransfer(workspacePayload({ path: "my file.ts" })),
    });

    expect(onDraftChange).toHaveBeenCalledWith('@"my file.ts" ');
  });

  it("keeps the directory slash", () => {
    const onDraftChange = vi.fn();
    renderComposer({ draft: "", onDraftChange, workspaceRoot: "C:/work/app" });

    fireEvent.drop(screen.getByTestId("composer-drop"), {
      dataTransfer: fakeDropTransfer(workspacePayload({ path: "src", kind: "directory" })),
    });

    expect(onDraftChange).toHaveBeenCalledWith("@src/ ");
  });

  it("refuses a file from a different folder", () => {
    const onDraftChange = vi.fn();
    useAppStore.setState({ hint: null });
    renderComposer({ draft: "", onDraftChange, workspaceRoot: "C:/other" });

    fireEvent.drop(screen.getByTestId("composer-drop"), {
      dataTransfer: fakeDropTransfer(workspacePayload()),
    });

    expect(onDraftChange).not.toHaveBeenCalled();
    expect(useAppStore.getState().hint).toMatch(/different folder/);
  });

  it("still accepts an image drop", async () => {
    renderComposer({ draft: "look" });
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

    fireEvent.drop(screen.getByTestId("composer-drop"), {
      dataTransfer: fakeDropTransfer(undefined, [file]),
    });

    expect(await screen.findByTestId("attachments")).toBeInTheDocument();
  });

  it("does not highlight for an in-app tab drag", () => {
    renderComposer();
    const drop = screen.getByTestId("composer-drop");

    fireEvent.dragOver(drop, {
      dataTransfer: { types: [TAB_DRAG_MIME], files: [] },
    });
    expect(drop.className).not.toContain("ring-accent");

    fireEvent.dragOver(drop, {
      dataTransfer: { types: [WORKSPACE_PATH_DRAG_MIME], files: [] },
    });
    expect(drop.className).toContain("ring-accent");
  });

  it("lets a tab drag bubble to the enclosing pane", () => {
    const onDraftChange = vi.fn();
    renderComposer({ draft: "", onDraftChange, workspaceRoot: "C:/work/app" });
    const transfer = {
      types: [TAB_DRAG_MIME],
      files: [] as File[],
      dropEffect: "none",
      effectAllowed: "move",
      getData: (type: string) =>
        type === TAB_DRAG_MIME ? JSON.stringify({ version: TAB_DRAG_VERSION, tabId: "tab-1" }) : "",
      setData: () => undefined,
    };

    const notPrevented = fireEvent.drop(screen.getByTestId("composer-drop"), {
      dataTransfer: transfer,
    });

    expect(notPrevented).toBe(true);
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("attachments")).toBeNull();
  });

  it("ignores a drop while the session cannot accept prompts", () => {
    const onDraftChange = vi.fn();
    useAppStore.setState({ hint: null });
    renderComposer({
      enabled: false,
      onDraftChange,
      workspaceRoot: "C:/work/app",
    });

    fireEvent.drop(screen.getByTestId("composer-drop"), {
      dataTransfer: fakeDropTransfer(workspacePayload()),
    });

    expect(onDraftChange).not.toHaveBeenCalled();
    expect(useAppStore.getState().hint).toMatch(/cannot accept prompts/);
  });

  it("inserts a mention request from the session pane", async () => {
    const onDraftChange = vi.fn();
    const onMentionHandled = vi.fn();
    renderComposer({
      draft: "review ",
      onDraftChange,
      onMentionHandled,
      workspaceRoot: "C:/work/app",
      mentionRequest: { id: 4, tabId: "tab-1", path: "src/a.ts", kind: "file" },
    });

    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith("review @src/a.ts "));
    expect(onMentionHandled).toHaveBeenCalledWith(4);
  });
});
