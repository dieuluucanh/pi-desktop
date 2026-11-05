import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/renderer/src/session/Composer";
import { createCompletionProvider } from "../../src/renderer/src/completion/stack";
import { createCommandProvider } from "../../src/renderer/src/completion/command-source";
import { createFileProvider } from "../../src/renderer/src/completion/file-source";
import type {
  CompletionItem,
  CompletionProvider,
  CompletionProviderFactory,
  CompletionResult,
  CompletionSuggestions,
} from "../../src/renderer/src/completion/types";

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
    apply?: (
      item: CompletionItem,
      suggestions: CompletionSuggestions,
      buffer: { lines: string[]; line: number; col: number },
    ) => Promise<CompletionResult | null>;
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
        onDraftChange={(text) => {
          setDraft(text);
          onDraftChange(text);
        }}
        onSend={onSend}
        onStop={onStop}
        onClearQueue={() => undefined}
        onRestoreQueue={() => undefined}
        onHistoryStep={() => null}
        completion={{
          provider: options.provider ?? fakeProvider(),
          ...(options.apply ? { apply: options.apply } : {}),
        }}
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

  it("accepts a command name with Enter and submits in the same keystroke", async () => {
    const user = userEvent.setup();
    const { onSend, onDraftChange } = renderComposer();
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("/");
    await screen.findByTestId("completion-overlay");

    await user.keyboard("{Enter}");
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith("/deploy "));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toBe("/deploy ");
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

  it("passes the picked source with the same-keystroke send", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("/");
    await screen.findByTestId("completion-overlay");

    await user.keyboard("{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toBe("/deploy ");
    // The picked source travels with the send, which is how a name the app also
    // reserves reaches the extension instead of the app's own action.
    expect(onSend.mock.calls[0]?.[2]).toEqual({ preferredSource: "extension" });
  });
});

describe("the real engine behind the composer", () => {
  it("submits the text the remote apply produced, not a stale draft", async () => {
    const user = userEvent.setup();
    const apply = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { lines: ["/remote-applied "], cursorLine: 0, cursorCol: 16 };
    });
    const { onSend } = renderComposer({ apply });

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("/");
    await screen.findByTestId("completion-overlay");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toBe("/remote-applied ");
  });

  it("applies an argument suggestion without sending", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({
      provider: createCompletionProvider({
        command: createCommandProvider({
          loadCommands: async () => [
            { name: "profile", description: "Profiles", source: "extension" },
          ],
          completeCommand: async () => [
            { value: "use ", label: "use", description: "activate a profile" },
          ],
        }),
      }),
    });

    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(box);
    await user.type(box, "/profile ");
    await screen.findByTestId("completion-overlay");

    await user.keyboard("{Enter}");
    await waitFor(() => expect(box.value).toBe("/profile use "));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows and applies sub-command suggestions after the first space", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({
      provider: createCompletionProvider({
        command: createCommandProvider({
          loadCommands: async () => [
            { name: "profile", description: "Profiles", source: "extension" },
          ],
          completeCommand: async () => [
            { value: "use ", label: "use", description: "activate a profile" },
          ],
        }),
      }),
    });

    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(box);
    await user.type(box, "/profile ");

    const overlay = await screen.findByTestId("completion-overlay");
    expect(overlay.textContent).toContain("use");
    expect(overlay.textContent).toContain("activate a profile");

    await user.keyboard("{Tab}");
    await waitFor(() => expect(box.value).toBe("/profile use "));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps ! and !! shell lines free of built-in completion", async () => {
    const user = userEvent.setup();
    const loadFiles = vi.fn(async () => ({ files: ["src/app.ts"] }));
    const provider = createCompletionProvider({ file: createFileProvider({ loadFiles }) });
    renderComposer({ provider });

    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(box);
    await user.type(box, "!git add src");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByTestId("completion-overlay")).toBeNull();

    // Tab must still reach extension shortcuts, but it must not revive a
    // built-in file list on a shell line.
    await user.keyboard("{Tab}");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByTestId("completion-overlay")).toBeNull();

    await user.clear(box);
    await user.type(box, "!!git status");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByTestId("completion-overlay")).toBeNull();
    expect(loadFiles).not.toHaveBeenCalled();
  });

  it("still opens an extension-provided ! menu", async () => {
    const user = userEvent.setup();
    const shellExtension: CompletionProviderFactory = (current) => ({
      ...current,
      async getSuggestions(lines, line, col, options) {
        if ((lines[line] ?? "").slice(0, col).startsWith("!")) {
          return {
            items: [{ value: "!ping", label: "!ping", source: "extension" }],
            prefix: "!",
          };
        }
        return current.getSuggestions(lines, line, col, options);
      },
    });
    const provider = createCompletionProvider({ extensionFactories: [shellExtension] });
    renderComposer({ provider });

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("!");

    const overlay = await screen.findByTestId("completion-overlay");
    expect(overlay.textContent).toContain("!ping");
  });

  it("still opens file completion on @ in an ordinary prompt", async () => {
    const user = userEvent.setup();
    const loadFiles = vi.fn(async () => ({ files: ["src/app.ts"] }));
    const provider = createCompletionProvider({ file: createFileProvider({ loadFiles }) });
    renderComposer({ provider });

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("@src");

    const overlay = await screen.findByTestId("completion-overlay");
    expect(overlay.textContent).toContain("src/app.ts");
    expect(loadFiles).toHaveBeenCalled();
  });

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
