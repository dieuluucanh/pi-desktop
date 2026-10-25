import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer, isSendKey } from "../../src/renderer/src/session/Composer";
import type { ImageAttachment } from "../../src/renderer/src/session/image-attachment";
import type { CompletionProvider } from "../../src/renderer/src/completion/types";
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
  const rendered = render(<Composer {...props} />);
  return { onSend, onStop, onClearQueue, onSendModeChange, onDraftChange, ...rendered };
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
    expect(screen.getByTestId("workflow-mode-badge")).toHaveTextContent("Plan");
    plan.unmount();

    renderComposer({ workflowStatus: "\u25b6 build 3/8" });
    expect(promptBox()).toHaveClass("border-accent");
    expect(screen.getByTestId("workflow-mode-badge")).toHaveTextContent("Build");
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
    expect(screen.getByTestId("workflow-mode-badge")).toHaveTextContent("Default");
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
          sendMode="steer"
          onDraftChange={setDraft}
          onSend={async () => true}
          onStop={() => undefined}
          onClearQueue={() => undefined}
          onSendModeChange={() => undefined}
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
        sendMode="steer"
        onDraftChange={setDraft}
        onSend={async () => true}
        onStop={() => undefined}
        onClearQueue={() => undefined}
        onSendModeChange={() => undefined}
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
