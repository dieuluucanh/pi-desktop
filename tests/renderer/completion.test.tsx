import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/renderer/src/session/Composer";
import { createCompletionProvider } from "../../src/renderer/src/completion/stack";
import { createCommandProvider } from "../../src/renderer/src/completion/command-source";
import { createFileProvider } from "../../src/renderer/src/completion/file-source";
import type { CompletionProvider } from "../../src/renderer/src/completion/types";

/**
 * The completion overlay inside the composer (plan step 7): `/` opens a list,
 * the menu owns Enter/Tab/arrows while it is open, and Escape closes the menu
 * *before* it means "stop the run".
 */

function fakeProvider(overrides: Partial<CompletionProvider> = {}): CompletionProvider {
  return {
    id: "fake",
    async getSuggestions(lines, cursorLine, cursorCol) {
      const line = lines[cursorLine] ?? "";
      if (cursorLine !== 0 || !line.slice(0, cursorCol).startsWith("/")) return null;
      return {
        items: [
          { value: "/deploy", label: "/deploy", description: "Deploy it", source: "extension" },
          {
            value: "/skill:review",
            label: "/skill:review",
            description: "Review",
            source: "skill",
          },
        ],
        prefix: line.slice(0, cursorCol),
      };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
      const next = [...lines];
      const line = next[cursorLine] ?? "";
      const start = Math.max(0, cursorCol - prefix.length);
      const insertion = `${item.value} `;
      next[cursorLine] = `${line.slice(0, start)}${insertion}${line.slice(cursorCol)}`;
      return { lines: next, cursorLine, cursorCol: start + insertion.length };
    },
    ...overrides,
  };
}

function renderComposer(
  options: {
    provider?: CompletionProvider;
    draft?: string;
    running?: boolean;
    onSend?: (text: string, sendOptions?: { preferredSource?: string }) => Promise<boolean>;
  } = {},
) {
  const onSend = vi.fn(
    async (text: string, _images: unknown[], sendOptions?: { preferredSource?: string }) =>
      options.onSend ? options.onSend(text, sendOptions) : true,
  );
  const onStop = vi.fn();
  const onDraftChange = vi.fn();

  // The composer is controlled, so the harness must own the draft exactly as the
  // store does — otherwise React resets the textarea and nothing can be typed.
  function Harness() {
    const [draft, setDraft] = useState(options.draft ?? "");
    return (
      <Composer
        tabId="tab-1"
        running={options.running ?? false}
        draft={draft}
        queue={{ steering: [], followUp: [] }}
        sendMode="steer"
        onDraftChange={(text) => {
          setDraft(text);
          onDraftChange(text);
        }}
        onSend={onSend}
        onStop={onStop}
        onClearQueue={() => undefined}
        onSendModeChange={() => undefined}
        onHistoryStep={() => null}
        completion={{ provider: options.provider ?? fakeProvider() }}
      />
    );
  }

  render(<Harness />);
  return { onSend, onStop, onDraftChange };
}

describe("the completion overlay", () => {
  it("opens on a slash and shows each suggestion's source", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("/");

    const overlay = await screen.findByTestId("completion-overlay");
    expect(overlay.textContent).toContain("/deploy");
    expect(overlay.textContent).toContain("extension");
    expect(overlay.textContent).toContain("/skill:review");
    expect(overlay.textContent).toContain("skill");
  });

  it("accepts the highlighted suggestion with Enter instead of sending", async () => {
    const user = userEvent.setup();
    const { onSend, onDraftChange } = renderComposer();
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("/");
    await screen.findByTestId("completion-overlay");

    await user.keyboard("{Enter}");
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith("/deploy "));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("moves the selection with the arrow keys and accepts with Tab", async () => {
    const user = userEvent.setup();
    const { onDraftChange } = renderComposer();
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("/");
    await screen.findByTestId("completion-overlay");

    await user.keyboard("{ArrowDown}{Tab}");
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith("/skill:review "));
  });

  it("closes on Escape without stopping the run", async () => {
    const user = userEvent.setup();
    const { onStop } = renderComposer({ running: true });
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("/");
    await screen.findByTestId("completion-overlay");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("completion-overlay")).toBeNull());
    expect(onStop).not.toHaveBeenCalled();

    // A second Escape, with the menu gone, does stop the run.
    await user.keyboard("{Escape}");
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("passes the picked source with the send, so a collision can be resolved", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("/");
    await screen.findByTestId("completion-overlay");

    // Accept the extension's entry, then send what it produced.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("completion-overlay")).toBeNull());
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toBe("/deploy ");
    // The picked source travels with the send, which is how a name the app also
    // reserves reaches the extension instead of the app's own action.
    expect(onSend.mock.calls[0]?.[2]).toEqual({ preferredSource: "extension" });
  });
});

describe("the real engine behind the composer", () => {
  it("drives commands and files through the same composer", async () => {
    const user = userEvent.setup();
    const provider = createCompletionProvider({
      command: createCommandProvider({
        loadCommands: async () => [{ name: "deploy", description: "Deploy", source: "extension" }],
      }),
      file: createFileProvider({ loadFiles: async () => ({ files: ["src/app.ts"] }) }),
    });
    renderComposer({ provider });

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("/dep");
    expect((await screen.findByTestId("completion-overlay")).textContent).toContain("/deploy");

    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("completion-overlay")).toBeNull());
  });
});
