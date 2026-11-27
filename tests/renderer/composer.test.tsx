import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, isSendKey } from "../../src/renderer/src/session/Composer";
import type { ImageAttachment } from "../../src/renderer/src/session/image-attachment";
import {
  stepPromptHistory,
  type PromptHistoryBrowse,
} from "../../src/renderer/src/session/prompt-history";
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

beforeEach(() => {
  // The revisioned composer draft is tab state on purpose (plan step 18), so it
  // outlives a component. Clear the slice between cases so an image pasted in
  // one test cannot appear in the next one's composer.
  useAppStore.setState({ composerDrafts: {} });
});

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn(
    async (
      _text: string,
      _images: readonly ImageAttachment[],
      _options?: { preferredSource?: unknown; followUp?: boolean },
    ) => "sent" as const,
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
    onHistoryStep: () => ({ kind: "none" }),
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

  it("routes Escape through onEscape when the view provides one", async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    const { onStop } = renderComposer({ running: true, draft: "half typed", onEscape });
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("routes Escape through onEscape for idle extension work", async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    const onStop = vi.fn();
    renderComposer({
      running: false,
      escapeActive: true,
      onEscape,
      onStop,
      draft: "half typed",
    });
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("keeps the Stop button on onStop even with an onEscape", async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    const { onStop } = renderComposer({ running: true, draft: "half typed", onEscape });
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("offers Stop only while running", () => {
    renderComposer({ running: true });
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    screen.getByRole("button", { name: /stop/i }).remove();
  });

  it("hides Stop and names the locked turn while another surface owns it", () => {
    renderComposer({ running: true, inputLocked: true });

    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByText(/An extension owns this turn/)).toBeInTheDocument();
  });
});

describe("Escape precedence (plan step 23)", () => {
  it("lets an open completion menu keep Escape while streaming", async () => {
    const onEscape = vi.fn();
    const onStop = vi.fn();
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
          running
          draft={draft}
          queue={{ steering: [], followUp: [] }}
          onDraftChange={setDraft}
          onSend={async () => "sent"}
          onStop={onStop}
          onEscape={onEscape}
          onClearQueue={() => undefined}
          onRestoreQueue={() => undefined}
          onHistoryStep={() => ({ kind: "none" })}
          completion={{ provider }}
        />
      );
    }

    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("/");
    await screen.findByTestId("completion-overlay");

    await user.keyboard("{Escape}");
    expect(onEscape).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("completion-overlay")).toBeNull());
  });
});

describe("queue and attachments", () => {
  it("shows pending rows with their delivery kind and full text", async () => {
    const user = userEvent.setup();
    const { onClearQueue, onRestoreQueue } = renderComposer({
      running: true,
      queue: {
        steering: [{ text: "stop and test the parser", origin: "user" }],
        followUp: [
          { text: "then commit with a long message that would not fit a chip", origin: "user" },
        ],
      },
    });

    const pending = screen.getByTestId("pending-queue");
    expect(pending.textContent).toContain("Steering");
    expect(pending.textContent).toContain("Follow-up");
    expect(pending.textContent).toContain("stop and test the parser");
    expect(pending.textContent).toContain(
      "then commit with a long message that would not fit a chip",
    );
    // A user row keeps its whole text in the DOM and in the tooltip.
    expect(screen.getByText("stop and test the parser")).toHaveAttribute(
      "title",
      "stop and test the parser",
    );
    expect(
      screen.getByText("then commit with a long message that would not fit a chip"),
    ).toHaveAttribute("title", "then commit with a long message that would not fit a chip");

    await user.click(screen.getByRole("button", { name: /restore all/i }));
    expect(onRestoreQueue).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /clear queue/i }));
    expect(onClearQueue).toHaveBeenCalledTimes(1);
  });

  it("shows an extension's queued turn as one dim first line, with no actions", () => {
    // The workflow extension queues its own Planner revision while the run is
    // streaming; the panel must not present it as the user's row (terminal Pi
    // renders it as a single dim line, `interactive-mode.js:3943-3959`).
    const revision =
      "# Planner revision — round 1 of 3\n\nPlan file: C:\\plans\\x.md\nR1 · secret detail";
    const { container } = renderComposer({
      running: true,
      queue: {
        steering: [{ text: revision, origin: "extension" }],
        followUp: [],
      },
    });

    const row = screen.getByTestId("pending-queue-extension");
    expect(row.textContent).toContain("Steering");
    expect(row.textContent).toContain("# Planner revision — round 1 of 3");
    expect(row.className).toContain("text-ink-faint");
    expect(screen.getByTestId("pending-queue")).toBeInTheDocument();

    // Only line 1 is in the DOM, so nothing beyond it can leak.
    expect(screen.queryByText(/Planner revision/)).toBeInTheDocument();
    expect(screen.queryByText(/Plan file/)).toBeNull();
    expect(screen.queryByText(/R1 · secret detail/)).toBeNull();
    for (const element of container.querySelectorAll("[title]")) {
      const title = element.getAttribute("title") ?? "";
      expect(title).not.toContain("Plan file");
      expect(title).not.toContain("secret detail");
    }

    // Nothing to restore or clear, so the footer is absent.
    expect(screen.queryByRole("button", { name: /restore all/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /clear queue/i })).toBeNull();
  });

  it("keeps the actions when the queue mixes a user row with an extension row", async () => {
    const user = userEvent.setup();
    const { onClearQueue, onRestoreQueue } = renderComposer({
      running: true,
      queue: {
        steering: [{ text: "only the user's", origin: "user" }],
        followUp: [
          { text: "# Planner revision — round 1 of 3\nR1 · secret detail", origin: "extension" },
        ],
      },
    });

    expect(screen.getByText("only the user's")).toBeInTheDocument();
    expect(screen.getAllByTestId("pending-queue-extension")).toHaveLength(1);
    expect(screen.getByTestId("pending-queue").textContent).toContain(
      "# Planner revision — round 1 of 3",
    );

    const restore = screen.getAllByRole("button", { name: /restore all/i });
    const clear = screen.getAllByRole("button", { name: /clear queue/i });
    expect(restore).toHaveLength(1);
    expect(clear).toHaveLength(1);

    await user.click(restore[0] as HTMLElement);
    expect(onRestoreQueue).toHaveBeenCalledTimes(1);
    await user.click(clear[0] as HTMLElement);
    expect(onClearQueue).toHaveBeenCalledTimes(1);
  });

  it("restores the whole queue on Alt+Up", async () => {
    const user = userEvent.setup();
    const { onRestoreQueue } = renderComposer({
      running: true,
      queue: { steering: [{ text: "one", origin: "user" }], followUp: [] },
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

/**
 * A parent that behaves like the store: a history step writes the draft and the
 * browse record. The composer is presentational for history, so this is where
 * "the step wrote the text" happens.
 */
function HistoryHarness({
  entries,
  initialDraft = "",
}: {
  entries: string[];
  initialDraft?: string;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [browse, setBrowse] = useState<PromptHistoryBrowse | undefined>(undefined);
  return (
    <Composer
      tabId="tab-1"
      running={false}
      draft={draft}
      queue={{ steering: [], followUp: [] }}
      onDraftChange={setDraft}
      onSend={async () => "sent"}
      onStop={() => undefined}
      onClearQueue={() => undefined}
      onRestoreQueue={() => undefined}
      onHistoryStep={(direction, caret) => {
        const step = stepPromptHistory({ direction, entries, browse, draft, caret });
        if (step.kind === "applied") {
          setBrowse(step.browse ?? undefined);
          setDraft(step.text);
        }
        return step;
      }}
    />
  );
}

describe("history", () => {
  it("recalls a prompt and restores the draft and caret on the way back", async () => {
    const user = userEvent.setup();
    render(<HistoryHarness entries={["earlier prompt"]} initialDraft="pending draft" />);
    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(box);
    box.setSelectionRange(7, 7);

    await user.keyboard("{ArrowUp}");
    expect(box).toHaveValue("earlier prompt");
    expect(box.selectionStart).toBe("earlier prompt".length);

    await user.keyboard("{ArrowDown}");
    expect(box).toHaveValue("pending draft");
    expect(box.selectionStart).toBe(7);
  });

  it("clears the composer when the pending draft was empty", async () => {
    const user = userEvent.setup();
    render(<HistoryHarness entries={["earlier prompt"]} />);
    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(box);

    await user.keyboard("{ArrowUp}");
    expect(box).toHaveValue("earlier prompt");

    // Regression: returning to "" must be applied, not treated as "no step".
    await user.keyboard("{ArrowDown}");
    expect(box).toHaveValue("");
  });

  it("leaves a multi-line draft's caret movement native inside the buffer", async () => {
    const user = userEvent.setup();
    const onHistoryStep = vi.fn(() => ({ kind: "none" as const }));
    renderComposer({ draft: "first line\nsecond line", onHistoryStep });
    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(box);
    // Caret on the second line: Up must move the caret, not recall history.
    box.setSelectionRange(box.value.length, box.value.length);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(onHistoryStep).not.toHaveBeenCalled();
  });

  it("walks the history only from the last line and passes the caret", async () => {
    const user = userEvent.setup();
    const onHistoryStep = vi.fn(() => ({ kind: "none" as const }));
    renderComposer({ draft: "first line\nsecond line", onHistoryStep });
    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(box);
    // Middle of the first line: Down stays native.
    box.setSelectionRange(2, 2);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(onHistoryStep).not.toHaveBeenCalled();
    // Last line: Down walks history, and the offset is the live caret.
    box.setSelectionRange(box.value.length, box.value.length);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(onHistoryStep).toHaveBeenCalledWith(1, box.value.length);
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

describe("composer mode control", () => {
  const mode = (
    over: Partial<Parameters<typeof Composer>[0]["contributionMode"] & object> = {},
  ) => ({
    ownerId: "fixture.ext",
    id: "mode",
    kind: "mode" as const,
    slot: "mode" as const,
    tone: "accent" as const,
    order: 0,
    text: "Analyze",
    detail: "fixture detail",
    enabled: true,
    ...over,
  });

  const modeAction = (
    over: Partial<
      NonNullable<Parameters<typeof Composer>[0]["contributionModeAction"]> & object
    > = {},
  ) => ({
    ownerId: "fixture.ext",
    id: "mode-cycle",
    text: "Cycle mode",
    enabled: true,
    ...over,
  });

  function promptBox(): HTMLElement {
    return screen.getByLabelText("Prompt");
  }

  it("colours the border from the mode tone and shows its current label", () => {
    // No mode names or glyphs: an arbitrary publisher's tone and label are the
    // only inputs, so a third-party extension looks native with no app change.
    const plan = renderComposer({
      contributionMode: mode({ tone: "warning", text: "Plan" }),
    });
    expect(promptBox()).toHaveClass("border-warn");
    expect(screen.getByTestId("composer-contribution-badge")).toHaveTextContent("Plan");
    expect(screen.getByTestId("composer-contribution-badge")).toHaveAttribute(
      "data-tone",
      "warning",
    );
    expect(
      within(screen.getByTestId("composer-contribution-badge")).getByTestId("composer-mode-label"),
    ).toHaveClass("text-warn");
    plan.unmount();

    renderComposer({ contributionMode: mode({ tone: "accent", text: "Build 3/8" }) });
    expect(promptBox()).toHaveClass("border-accent");
    expect(screen.getByTestId("composer-contribution-badge")).toHaveTextContent("Build 3/8");
    expect(
      within(screen.getByTestId("composer-contribution-badge")).getByTestId("composer-mode-label"),
    ).toHaveClass("text-accent");
  });

  it("renders the control inside the input's top-right corner with a capped width", () => {
    renderComposer({ contributionMode: mode(), contributionModeAction: modeAction() });
    const input = screen.getByTestId("composer-input");
    const element = within(input).getByTestId("composer-contribution-badge");
    expect(input.contains(element)).toBe(true);
    expect(element.className).toContain("absolute");
    expect(element.className).toContain("top-1");
    expect(element.className).not.toContain("bottom-1");
    // Long/localized labels truncate visually instead of covering the prompt.
    expect(element.className).toMatch(/max-w-\[/);
    expect(within(element).getByTestId("composer-mode-button")).toHaveClass("truncate");
  });

  it("is a real button that runs the referenced action, keeping the prompt's focus", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn(async () => true);
    renderComposer({
      contributionMode: mode({ text: "Orchestrator" }),
      contributionModeAction: modeAction(),
      onRunContributionMode: onRun,
    });
    const button = screen.getByTestId("composer-mode-button");
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
    // The accessible name carries the current mode and the action.
    expect(button).toHaveAttribute("aria-label", "Orchestrator — Cycle mode");
    expect(button).toHaveTextContent("Orchestrator");

    await user.click(button);
    expect(onRun).toHaveBeenCalledWith("fixture.ext", "mode-cycle");
    // The label follows published state, never an optimistic local step.
    expect(screen.getByTestId("composer-mode-button")).toHaveTextContent("Orchestrator");
  });

  it("supports keyboard activation like any other button", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn(async () => true);
    renderComposer({
      contributionMode: mode(),
      contributionModeAction: modeAction(),
      onRunContributionMode: onRun,
    });
    await user.tab();
    const button = screen.getByTestId("composer-mode-button");
    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("refuses a disabled action, explains why, and ignores repeat clicks", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn(async () => true);
    renderComposer({
      contributionMode: mode({ text: "Review" }),
      contributionModeAction: modeAction({
        enabled: false,
        disabledReason: "a review owns this turn",
      }),
      onRunContributionMode: onRun,
    });
    const button = screen.getByTestId("composer-mode-button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "a review owns this turn");
    await user.click(button);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("keeps one invocation in flight and re-enables after it settles", async () => {
    const user = userEvent.setup();
    let settle: ((value: boolean) => void) | undefined;
    const onRun = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    renderComposer({
      contributionMode: mode(),
      contributionModeAction: modeAction(),
      onRunContributionMode: onRun,
    });
    const button = screen.getByTestId("composer-mode-button");
    await user.click(button);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("composer-mode-button")).toBeDisabled();
    await user.click(screen.getByTestId("composer-mode-button"));
    expect(onRun).toHaveBeenCalledTimes(1);
    settle?.(true);
    await waitFor(() => expect(screen.getByTestId("composer-mode-button")).not.toBeDisabled());
  });

  it("keeps a legacy mode label informative without inventing an action", () => {
    renderComposer({ contributionMode: mode({ text: "Plan" }) });
    expect(screen.queryByTestId("composer-mode-button")).toBeNull();
    const root = screen.getByTestId("composer-contribution-badge");
    expect(root).toHaveAttribute("data-actionable", "false");
    expect(root).toHaveTextContent("Plan");
    // The mode is still announced, politely, once.
    expect(within(root).getByRole("status")).toHaveTextContent("Plan");
    // The publisher's detail stays reachable.
    expect(within(root).getByTitle("fixture detail")).toBeInTheDocument();
  });

  it("survives focus without a ring that hides the tone colour", () => {
    renderComposer({
      contributionMode: mode({ tone: "accent", text: "Build" }),
      contributionModeAction: modeAction(),
    });
    const box = promptBox();
    expect(box).toHaveClass("outline-none");
    expect(box.className).toMatch(/focus-visible:ring-2/);
    expect(box.className).toMatch(/ring-line-strong/);
    expect(box.className).not.toMatch(/focus:border-/);
    expect(box).toHaveClass("border-accent");
  });

  it("lets the shell-command warning tone win over the mode tone", () => {
    renderComposer({
      draft: "!npm test",
      contributionMode: mode({ tone: "accent", text: "Plan" }),
      contributionModeAction: modeAction(),
    });
    expect(promptBox()).toHaveClass("border-warn");
    expect(screen.getByTestId("composer-mode-button")).toHaveClass("text-warn");
  });

  it("stays neutral when no mode is published", () => {
    for (const value of [undefined, null]) {
      const view = renderComposer({ contributionMode: value });
      expect(promptBox()).toHaveClass("border-line");
      expect(screen.queryByTestId("composer-contribution-badge")).toBeNull();
      view.unmount();
    }
  });

  describe("mode menu", () => {
    type ModeChoices = NonNullable<Parameters<typeof Composer>[0]["contributionModeChoices"]>;
    type ModeChoiceEntry = ModeChoices[number];

    /**
     * One `mode-choice` view plus its resolved same-owner action. `action:
     * null` is the dangling/cross-owner case (the model never resolves it).
     */
    function choiceEntry(
      text: string,
      over: {
        checked?: boolean;
        choice?: Partial<ModeChoiceEntry["choice"]>;
        action?: Partial<NonNullable<ModeChoiceEntry["action"]>> | null;
      } = {},
    ): ModeChoiceEntry {
      const id = `choice-${text.toLowerCase()}`;
      return {
        choice: {
          ownerId: "fixture.ext",
          id,
          kind: "mode-choice",
          slot: "mode-choice",
          tone: "neutral",
          order: 10,
          text,
          enabled: true,
          ...(over.checked === undefined ? {} : { checked: over.checked }),
          ...over.choice,
        },
        action:
          over.action === null
            ? null
            : {
                ownerId: "fixture.ext",
                id: `run-${id}`,
                text: `Switch to ${text}`,
                enabled: true,
                ...over.action,
              },
      };
    }

    function fourChoices(): ModeChoices {
      return [
        choiceEntry("Default"),
        choiceEntry("Plan", { checked: true }),
        choiceEntry("Orchestrator"),
        choiceEntry("Build"),
      ];
    }

    /** Radix menus are reliable from the keyboard (see working-bar tests). */
    async function openMenu(): Promise<HTMLElement> {
      const trigger = screen.getByTestId("composer-mode-menu");
      act(() => trigger.focus());
      await userEvent.keyboard("{Enter}");
      return screen.findByRole("menu");
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("shows no chevron for a publisher without mode choices", () => {
      renderComposer({ contributionMode: mode(), contributionModeAction: modeAction() });
      expect(screen.queryByTestId("composer-mode-menu")).toBeNull();
      expect(screen.getByTestId("composer-mode-button")).toHaveTextContent("Analyze");
    });

    it("opens an upward, end-aligned menu with every choice under one group label", async () => {
      renderComposer({
        contributionMode: mode({ text: "Plan" }),
        contributionModeAction: modeAction(),
        contributionModeChoices: fourChoices(),
      });

      const menu = await openMenu();
      expect(menu).toHaveAttribute("data-side", "top");
      expect(menu).toHaveAttribute("data-align", "end");
      expect(within(menu).getByText("Modes")).toBeInTheDocument();
      expect(within(menu).getAllByRole("group")).toHaveLength(1);
      expect(
        within(menu)
          .getAllByRole("menuitemradio")
          .map((item) => item.textContent),
      ).toEqual(["Default", "Plan", "Orchestrator", "Build"]);
    });

    it("checks and disables the current choice, leaving the others selectable", async () => {
      renderComposer({
        contributionMode: mode({ text: "Plan" }),
        contributionModeAction: modeAction(),
        contributionModeChoices: fourChoices(),
      });

      const menu = await openMenu();
      const current = within(menu).getByTestId("composer-mode-choice-choice-plan");
      expect(current).toHaveAttribute("aria-checked", "true");
      expect(current).toHaveAttribute("data-checked", "true");
      expect(current).toHaveAttribute("aria-disabled", "true");
      expect(current).toHaveAttribute("title", "Switch to Plan");
      expect(current.querySelector("svg")).not.toBeNull();

      const other = within(menu).getByTestId("composer-mode-choice-choice-build");
      expect(other).toHaveAttribute("aria-checked", "false");
      expect(other).not.toHaveAttribute("data-checked");
      expect(other).not.toHaveAttribute("aria-disabled");
      expect(other.querySelector("svg")).toBeNull();
    });

    it("forwards the referenced owner/action for a selected choice, not the cycle action", async () => {
      const onRun = vi.fn(async () => true);
      renderComposer({
        contributionMode: mode({ text: "Plan" }),
        contributionModeAction: modeAction(),
        contributionModeChoices: fourChoices(),
        onRunContributionMode: onRun,
      });

      const menu = await openMenu();
      await userEvent.click(within(menu).getByTestId("composer-mode-choice-choice-build"));
      expect(onRun).toHaveBeenCalledWith("fixture.ext", "run-choice-build");
      // Never optimistic: the published label is untouched until a snapshot.
      expect(screen.getByTestId("composer-mode-button")).toHaveTextContent("Plan");
    });

    it("disables a dangling choice and a disabled action with their reasons", async () => {
      const onRun = vi.fn(async () => true);
      renderComposer({
        contributionMode: mode({ text: "Plan" }),
        contributionModeAction: modeAction(),
        contributionModeChoices: [
          choiceEntry("Default", {
            action: null,
            choice: { detail: "no live action for this choice" },
          }),
          choiceEntry("Build", {
            action: { enabled: false, disabledReason: "a review owns this turn" },
          }),
        ],
        onRunContributionMode: onRun,
      });

      const menu = await openMenu();
      const dangling = within(menu).getByTestId("composer-mode-choice-choice-default");
      expect(dangling).toHaveAttribute("aria-disabled", "true");
      expect(dangling).toHaveAttribute("data-disabled");
      expect(dangling).toHaveAttribute("title", "no live action for this choice");

      const disabled = within(menu).getByTestId("composer-mode-choice-choice-build");
      expect(disabled).toHaveAttribute("aria-disabled", "true");
      expect(disabled).toHaveAttribute("title", "a review owns this turn");

      await userEvent.click(dangling);
      await userEvent.click(disabled);
      expect(onRun).not.toHaveBeenCalled();
    });

    it("stays usable when the cycle action itself is disabled", async () => {
      renderComposer({
        contributionMode: mode({ text: "Review" }),
        contributionModeAction: modeAction({
          enabled: false,
          disabledReason: "a review owns this turn",
        }),
        contributionModeChoices: [choiceEntry("Default"), choiceEntry("Review", { checked: true })],
      });

      expect(screen.getByTestId("composer-mode-button")).toBeDisabled();
      // The chevron is a separate control, so the reasons stay readable.
      expect(screen.getByTestId("composer-mode-menu")).toBeEnabled();
      const menu = await openMenu();
      expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(2);
      expect(within(menu).getByTestId("composer-mode-choice-choice-default")).toHaveAttribute(
        "title",
        "Switch to Default",
      );
    });

    it("navigates the menu with the keyboard and selects with Enter", async () => {
      const onRun = vi.fn(async () => true);
      renderComposer({
        contributionMode: mode({ text: "Plan" }),
        contributionModeAction: modeAction(),
        contributionModeChoices: fourChoices(),
        onRunContributionMode: onRun,
      });

      const menu = await openMenu();
      // Opening focuses the first enabled item; the checked/disabled Plan is
      // skipped, so ArrowDown lands on Orchestrator.
      await waitFor(() =>
        expect(within(menu).getByTestId("composer-mode-choice-choice-default")).toHaveFocus(),
      );
      await userEvent.keyboard("{ArrowDown}");
      expect(within(menu).getByTestId("composer-mode-choice-choice-orchestrator")).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(onRun).toHaveBeenCalledWith("fixture.ext", "run-choice-orchestrator");
    });

    it("follows the next published label instead of changing optimistically", async () => {
      const { props, rerender } = renderComposer({
        contributionMode: mode({ text: "Plan" }),
        contributionModeAction: modeAction(),
        contributionModeChoices: fourChoices(),
        onRunContributionMode: vi.fn(async () => true),
      });
      expect(screen.getByTestId("composer-mode-button")).toHaveTextContent("Plan");

      rerender(
        <Composer
          {...props}
          contributionMode={mode({ text: "Build" })}
          contributionModeChoices={[choiceEntry("Build", { checked: true }), choiceEntry("Plan")]}
        />,
      );
      expect(screen.getByTestId("composer-mode-button")).toHaveTextContent("Build");
    });

    it("keeps the label's one-click cycle while the chevron opens the menu", async () => {
      const user = userEvent.setup();
      const onRun = vi.fn(async () => true);
      renderComposer({
        contributionMode: mode({ text: "Plan" }),
        contributionModeAction: modeAction(),
        contributionModeChoices: fourChoices(),
        onRunContributionMode: onRun,
      });

      await user.click(screen.getByTestId("composer-mode-button"));
      expect(onRun).toHaveBeenCalledWith("fixture.ext", "mode-cycle");
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("keeps the prompt's draft, caret and selection on a label click", async () => {
      const user = userEvent.setup();
      const onRun = vi.fn(async () => true);
      const { onDraftChange } = renderComposer({
        draft: "hello world",
        contributionMode: mode({ text: "Plan" }),
        contributionModeAction: modeAction(),
        contributionModeChoices: fourChoices(),
        onRunContributionMode: onRun,
      });

      const prompt = promptBox() as HTMLTextAreaElement;
      await user.click(prompt);
      prompt.setSelectionRange(6, 11);

      await user.click(screen.getByTestId("composer-mode-button"));
      expect(onRun).toHaveBeenCalledWith("fixture.ext", "mode-cycle");
      // The pointer path never steals focus from the prompt.
      expect(prompt).toHaveFocus();
      expect(prompt.selectionStart).toBe(6);
      expect(prompt.selectionEnd).toBe(11);
      expect(onDraftChange).not.toHaveBeenCalled();
    });

    it("reserves the whole control's measured width, chevron included", () => {
      interface Observed {
        node: Element | null;
        trigger: () => void;
      }
      const observed: Observed[] = [];
      class FakeResizeObserver {
        private readonly callback: ResizeObserverCallback;
        private readonly entry: Observed = { node: null, trigger: () => undefined };

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
          const entry = this.entry;
          entry.trigger = () => this.callback([], this as unknown as ResizeObserver);
          observed.push(entry);
        }

        observe(node: Element): void {
          this.entry.node = node;
        }

        unobserve(): void {}
        disconnect(): void {}
      }
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);

      renderComposer({
        contributionMode: mode({ text: "Orchestrator Plan" }),
        contributionModeAction: modeAction(),
        contributionModeChoices: fourChoices(),
      });

      const root = screen.getByTestId("composer-contribution-badge");
      // The control measures the ROOT (label + chevron); the label alone is much
      // narrower, so a label-only measurement would reserve 48px, not 158px.
      Object.defineProperty(root, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ width: 150 }) as DOMRect,
      });
      Object.defineProperty(screen.getByTestId("composer-mode-button"), "getBoundingClientRect", {
        configurable: true,
        value: () => ({ width: 40 }) as DOMRect,
      });

      const latest = observed.at(-1);
      expect(latest?.node).toBe(root);
      act(() => latest?.trigger());
      expect(promptBox()).toHaveStyle({ paddingRight: "158px" });

      // A very long label is capped for the visible control...
      Object.defineProperty(root, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ width: 400 }) as DOMRect,
      });
      act(() => latest?.trigger());
      expect(promptBox()).toHaveStyle({ paddingRight: "240px" });
      // ...while the accessible text stays complete.
      expect(screen.getByTestId("composer-mode-button")).toHaveAttribute(
        "aria-label",
        "Orchestrator Plan — Cycle mode",
      );
    });
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

  it("keeps prompt history working while a `tab` shortcut is registered (row 28)", () => {
    // W's CustomEditor only changes Tab precedence in terminal Pi; the desktop
    // native composer must leave ArrowUp/Down history untouched.
    const onHistoryStep = vi.fn(() => ({ kind: "none" as const }));
    const onInvokeShortcut = vi.fn();
    renderComposer({
      extensionShortcuts: [{ key: "tab" }],
      onInvokeShortcut,
      onHistoryStep,
    });
    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(onHistoryStep).toHaveBeenCalledWith(-1, box.value.length);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(onHistoryStep).toHaveBeenCalledWith(1, box.value.length);
    expect(onInvokeShortcut).not.toHaveBeenCalled();
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
          onSend={async () => "sent"}
          onStop={() => undefined}
          onClearQueue={() => undefined}
          onRestoreQueue={() => undefined}
          onHistoryStep={() => ({ kind: "none" })}
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
        onSend={async () => "sent"}
        onStop={() => undefined}
        onClearQueue={() => undefined}
        onRestoreQueue={() => undefined}
        onHistoryStep={() => ({ kind: "none" })}
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
        onSend={async () => "sent"}
        onStop={() => undefined}
        onClearQueue={() => undefined}
        onRestoreQueue={() => undefined}
        onHistoryStep={() => ({ kind: "none" })}
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
