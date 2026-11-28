import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";

import { Composer } from "../../src/renderer/src/session/Composer";
import type { ComposerSendDisposition } from "../../src/renderer/src/session/composer-send";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import type { ImageAttachment } from "../../src/renderer/src/session/image-attachment";
import type { CompletionItem, CompletionProvider } from "../../src/renderer/src/completion/types";
import { DEFAULT_PREFS } from "../../src/shared/prefs";

/**
 * Composer Send dispositions (2026-11-22 prompt-refinement plan step 20).
 *
 * Every path that can submit — the Send button, Enter, Alt+Enter/Ctrl+Q, a
 * completion-accept-and-send and an images-only draft — funnels through the
 * same disposition. Only `sent`/`handled-command` may follow the existing clear
 * rules; a transformation or a refusal must leave the attachment chips (and the
 * text the parent owns) untouched.
 */

function image(id: string, data = "AAAA"): ImageAttachment {
  return { id, name: "shot.png", mimeType: "image/png", data };
}

function completionProvider(item: CompletionItem): CompletionProvider {
  return {
    id: "fake",
    async getSuggestions(lines, cursorLine, cursorCol) {
      const line = lines[cursorLine] ?? "";
      if (cursorLine !== 0 || !line.slice(0, cursorCol).startsWith("/")) return null;
      return { items: [item], prefix: line.slice(0, cursorCol) };
    },
    applyCompletion: (lines, cursorLine, cursorCol, applied, prefix) => {
      const next = [...lines];
      const line = next[cursorLine] ?? "";
      const start = Math.max(0, cursorCol - prefix.length);
      const insertion = `${applied.value} `;
      next[cursorLine] = `${line.slice(0, start)}${insertion}${line.slice(cursorCol)}`;
      return { lines: next, cursorLine, cursorCol: start + insertion.length };
    },
  };
}

function renderComposer(
  options: {
    disposition?: ComposerSendDisposition | (() => Promise<ComposerSendDisposition>);
    draft?: string;
    running?: boolean;
    withImage?: boolean;
    completion?: CompletionProvider;
  } = {},
) {
  const disposition = options.disposition ?? "sent";
  const onSend = vi.fn(
    async (
      _text: string,
      _images: readonly ImageAttachment[],
      _options?: { preferredSource?: unknown; followUp?: boolean },
    ): Promise<ComposerSendDisposition> =>
      typeof disposition === "function" ? disposition() : disposition,
  );
  const onDraftChange = vi.fn();
  const draft = options.draft ?? "hello";

  if (options.withImage) useAppStore.getState().addDraftImages("tab-1", [image("image-1")]);

  render(
    <Composer
      tabId="tab-1"
      running={options.running ?? false}
      draft={draft}
      queue={{ steering: [], followUp: [] }}
      onDraftChange={onDraftChange}
      onSend={onSend}
      onStop={() => undefined}
      onClearQueue={() => undefined}
      onRestoreQueue={() => undefined}
      onHistoryStep={() => ({ kind: "none" })}
      {...(options.completion ? { completion: { provider: options.completion } } : {})}
    />,
  );
  return { onSend, onDraftChange };
}

function attachmentIds(): string[] {
  return useAppStore.getState().composerDrafts["tab-1"]?.attachments.map((entry) => entry.id) ?? [];
}

beforeEach(() => {
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    composerDrafts: {},
    hint: null,
  });
});

describe("Send dispositions", () => {
  it("keeps attachments for a transformation started from the Send button", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ disposition: "refining", withImage: true });

    await user.click(screen.getByRole("button", { name: /^send$/i }));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe("hello");
    expect(attachmentIds()).toEqual(["image-1"]);
  });

  it("keeps attachments for a transformation started with Enter", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ disposition: "refining", withImage: true });
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(attachmentIds()).toEqual(["image-1"]);
  });

  it("clears attachments only after a real send", async () => {
    const user = userEvent.setup();
    renderComposer({ disposition: "sent", withImage: true });
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(attachmentIds()).toEqual([]));
  });

  it("clears attachments for a consumed command", async () => {
    const user = userEvent.setup();
    renderComposer({ disposition: "handled-command", withImage: true });
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(attachmentIds()).toEqual([]));
  });

  it("keeps attachments after a refusal", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ disposition: "refused", withImage: true });
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(attachmentIds()).toEqual(["image-1"]);
  });

  it("keeps attachments when a candidate was already applied (refined)", async () => {
    const user = userEvent.setup();
    renderComposer({ disposition: "refined", withImage: true });
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    expect(attachmentIds()).toEqual(["image-1"]);
  });

  it("keeps attachments for a refused follow-up chord while running", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({
      disposition: "refused",
      running: true,
      withImage: true,
      draft: "then commit",
    });
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Alt>}{Enter}{/Alt}");

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[2]).toMatchObject({ followUp: true });
    expect(attachmentIds()).toEqual(["image-1"]);
  });

  it("keeps attachments for the Ctrl+Q follow-up chord", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({
      disposition: "refining",
      running: true,
      withImage: true,
      draft: "then commit",
    });
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Control>}q{/Control}");

    // While running, the armed toggle must refuse instead of queueing; the
    // composer reports the same input either way and only the store decides.
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(attachmentIds()).toEqual(["image-1"]);
  });

  it("submits an images-only draft without dropping the image", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ disposition: "refined", draft: "", withImage: true });
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe("");
    expect(onSend.mock.calls[0]?.[1].map((entry) => entry.id)).toEqual(["image-1"]);
    expect(attachmentIds()).toEqual(["image-1"]);
  });

  it("keeps attachments through a completion-accept-and-send", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(
      async (
        _text: string,
        _images: readonly ImageAttachment[],
        _options?: { followUp?: boolean },
      ): Promise<ComposerSendDisposition> => "refining",
    );
    useAppStore.getState().addDraftImages("tab-1", [image("image-1")]);
    function Harness() {
      const [draft, setDraft] = useState("");
      return (
        <Composer
          tabId="tab-1"
          running={false}
          draft={draft}
          queue={{ steering: [], followUp: [] }}
          onDraftChange={setDraft}
          onSend={onSend}
          onStop={() => undefined}
          onClearQueue={() => undefined}
          onRestoreQueue={() => undefined}
          onHistoryStep={() => ({ kind: "none" })}
          completion={{
            provider: completionProvider({
              value: "/deploy",
              label: "/deploy",
              description: "Deploy it",
              source: "extension",
            }),
          }}
        />
      );
    }
    render(<Harness />);
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("/");
    await screen.findByTestId("completion-overlay");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0]).toBe("/deploy ");
    expect(attachmentIds()).toEqual(["image-1"]);
  });
});
