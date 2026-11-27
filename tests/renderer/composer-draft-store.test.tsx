import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "../../src/renderer/src/session/Composer";
import {
  composerDraftFor,
  useAppStore,
  type AppStateShape,
} from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { ImageAttachment } from "../../src/renderer/src/session/image-attachment";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * The revisioned composer draft in the store (2026-11-22 prompt-refinement plan
 * step 18).
 *
 * The composer's text and image attachments used to be component state, so a
 * remount lost the images and no caller could tell whether the draft had
 * changed. These tests pin the store contract the later CAS apply depends on:
 * monotonic revisions (edit-then-revert included), attachment identity, separate
 * selection, the canonical paste-expanded snapshot, and cleanup on tab close.
 */

function tab(status: TabRecord["status"] = "idle"): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: "/work/app",
    title: "app",
    sessionFile: "/profile/s1.jsonl",
    status,
    createdAt: 0,
    lastActiveAt: 0,
    model: "test-model",
  };
}

function image(id: string, data = "AAAA"): ImageAttachment {
  return { id, name: "shot.png", mimeType: "image/png", data };
}

function snapshot(tabId = "tab-1") {
  return useAppStore.getState().draftSnapshot(tabId);
}

function stubRequest(impl: (input: { method: string; params?: unknown }) => Promise<unknown>) {
  const request = vi.fn(async (input: { method: string; params?: unknown }) => impl(input));
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

function resetStore(): void {
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    tabs: [tab()],
    activeTabId: "tab-1",
    transcripts: {},
    sessionStates: {},
    draftHistory: {},
    historyBrowse: {},
    composerDrafts: {},
    pasteBodies: {},
    pasteCounter: 1,
    hint: null,
  });
}

beforeEach(() => {
  installBridge();
  resetStore();
});

describe("content revisions", () => {
  it("bumps for a real edit and not for a repeated identical write", () => {
    useAppStore.getState().setDraft("tab-1", "first");
    const first = snapshot();

    useAppStore.getState().setDraft("tab-1", "first");
    expect(snapshot().revision).toBe(first.revision);

    useAppStore.getState().setDraft("tab-1", "second");
    expect(snapshot().revision).toBeGreaterThan(first.revision);
  });

  it("stays monotonic through an edit-then-revert", () => {
    useAppStore.getState().setDraft("tab-1", "a");
    const before = snapshot();
    useAppStore.getState().setDraft("tab-1", "b");
    const edited = snapshot();
    useAppStore.getState().setDraft("tab-1", "a");
    const reverted = snapshot();

    expect(reverted.text).toBe("a");
    expect(edited.revision).toBeGreaterThan(before.revision);
    expect(reverted.revision).toBeGreaterThan(edited.revision);
  });

  it("tracks a mention insertion as a content edit", () => {
    useAppStore.getState().setDraft("tab-1", "review ");
    const before = snapshot();
    useAppStore.getState().setDraft("tab-1", "review @src/a.ts ");
    const after = snapshot();

    expect(after.text).toBe("review @src/a.ts ");
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it("adopts a draft map that arrived out of band (host restore)", () => {
    useAppStore.getState().setDraft("tab-1", "typed here");
    const before = snapshot();
    useAppStore.getState().setPrefs({ drafts: { "tab-1": "restored from disk" } });

    const after = snapshot();
    expect(after.text).toBe("restored from disk");
    expect(after.revision).toBeGreaterThan(before.revision);
  });
});

describe("attachments", () => {
  it("keeps two copies of the same image and removes only the chosen one", () => {
    useAppStore.getState().addDraftImages("tab-1", [image("image-1"), image("image-2")]);
    const both = composerDraftFor(useAppStore.getState(), "tab-1");
    expect(both.attachments.map((attachment) => attachment.id)).toEqual(["image-1", "image-2"]);

    useAppStore.getState().removeDraftImage("tab-1", "image-1");
    const remaining = composerDraftFor(useAppStore.getState(), "tab-1");
    expect(remaining.attachments.map((attachment) => attachment.id)).toEqual(["image-2"]);
  });

  it("bumps the content and attachment revisions, and preserves object identity", () => {
    const first = image("image-1");
    useAppStore.getState().addDraftImages("tab-1", [first]);
    const added = snapshot();

    const record = composerDraftFor(useAppStore.getState(), "tab-1");
    expect(record.attachments[0]).toBe(first);

    useAppStore.getState().setDraft("tab-1", "text only");
    const typed = snapshot();
    expect(typed.revision).toBeGreaterThan(added.revision);
    expect(typed.attachmentRevision).toBe(added.attachmentRevision);

    useAppStore.getState().clearDraftImages("tab-1");
    const cleared = snapshot();
    expect(cleared.attachments).toHaveLength(0);
    expect(cleared.attachmentRevision).toBeGreaterThan(typed.attachmentRevision);
  });

  it("keeps image bytes out of preferences and out of the snapshot", () => {
    useAppStore.getState().addDraftImages("tab-1", [image("image-1", "QUJD")]);

    expect(JSON.stringify(useAppStore.getState().prefs)).not.toContain("QUJD");
    const captured = snapshot();
    expect(captured.attachments).toEqual([
      { id: "image-1", name: "shot.png", mimeType: "image/png", bytes: 4 },
    ]);
    expect(JSON.stringify(captured)).not.toContain("QUJD");
  });

  it("captures an images-only draft", () => {
    useAppStore.getState().addDraftImages("tab-1", [image("image-1")]);
    const captured = snapshot();

    expect(captured.text).toBe("");
    expect(captured.expandedText).toBe("");
    expect(captured.attachments).toHaveLength(1);
  });

  it("drops a closed tab's draft and its attachments", () => {
    useAppStore.getState().setDraft("tab-1", "unfinished");
    useAppStore.getState().addDraftImages("tab-1", [image("image-1")]);
    expect(useAppStore.getState().composerDrafts["tab-1"]).toBeDefined();

    useAppStore.getState().applyTabs({ tabs: [], activeTabId: null, revision: 1_000 });

    expect(useAppStore.getState().composerDrafts["tab-1"]).toBeUndefined();
    expect(useAppStore.getState().pasteBodies["tab-1"]).toBeUndefined();
  });
});

describe("selection", () => {
  it("records the caret without invalidating the content revision", () => {
    useAppStore.getState().setDraft("tab-1", "hello world");
    const before = snapshot();

    useAppStore.getState().setDraftSelection("tab-1", { start: 6, end: 11 });
    const after = snapshot();

    expect(after.revision).toBe(before.revision);
    expect(after.attachmentRevision).toBe(before.attachmentRevision);
    expect(after.selection).toEqual({ start: 6, end: 11 });
  });
});

describe("paste markers", () => {
  it("snapshots the canonical expanded text, not the marker", () => {
    const body = "line\n".repeat(12);
    const marker = useAppStore.getState().registerPaste("tab-1", body);
    useAppStore.getState().setDraft("tab-1", `see ${marker}`);

    const captured = snapshot();
    expect(captured.text).toBe(`see ${marker}`);
    expect(captured.expandedText).toBe(`see ${body}`);
  });

  it("bumps the revision when a body is registered under an unchanged draft", () => {
    useAppStore.getState().setDraft("tab-1", "no marker yet");
    const before = snapshot();

    useAppStore.getState().registerPaste("tab-1", "x".repeat(1_200));
    const after = snapshot();

    expect(after.text).toBe(before.text);
    expect(after.revision).toBeGreaterThan(before.revision);
  });
});

describe("host failure", () => {
  it("restores the text after a refused send with a newer revision", async () => {
    let reject!: (error: Error) => void;
    stubRequest(async (input) => {
      if (input.method === "prompt") {
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      }
      return {};
    });
    useAppStore.getState().setDraft("tab-1", "keep me");
    const before = snapshot();

    const pending = useAppStore.getState().sendPrompt("tab-1", "keep me");
    await vi.waitFor(() => expect(typeof reject).toBe("function"));
    reject(new Error("host is down"));
    await expect(pending).resolves.toBe("refused");

    const after = snapshot();
    expect(after.text).toBe("keep me");
    expect(after.revision).toBeGreaterThan(before.revision);
  });
});

/**
 * A parent that behaves like `SessionView`: the store owns the text and the
 * composer only reports edits. Unmounting it replaces the composer exactly like
 * a docked dialog or a pane move does.
 */
function ComposerHarness() {
  const draft = useAppStore((state) => state.prefs.drafts["tab-1"] ?? "");
  const setDraft = useAppStore((state: AppStateShape) => state.setDraft);
  return (
    <Composer
      tabId="tab-1"
      running={false}
      draft={draft}
      queue={{ steering: [], followUp: [] }}
      onDraftChange={(text) => setDraft("tab-1", text)}
      onSend={async () => "refused"}
      onStop={() => undefined}
      onClearQueue={() => undefined}
      onRestoreQueue={() => undefined}
      onHistoryStep={() => ({ kind: "none" })}
    />
  );
}

describe("composer remount", () => {
  it("keeps an image attachment when the composer is replaced", async () => {
    const first = render(<ComposerHarness />);
    fireEvent.paste(screen.getByLabelText("Prompt"), {
      clipboardData: { files: [new File([new Uint8Array([1, 2, 3])], "shot.png")] },
    });
    await screen.findByTestId("attachments");
    first.unmount();

    render(<ComposerHarness />);
    const chips = await screen.findByTestId("attachments");
    expect(chips.textContent).toContain("shot.png");
  });

  it("shows the same image twice and removes one chip at a time", async () => {
    render(<ComposerHarness />);
    const prompt = screen.getByLabelText("Prompt");
    const file = new File([new Uint8Array([9, 9])], "shot.png");

    fireEvent.paste(prompt, { clipboardData: { files: [file] } });
    await screen.findByTestId("attachments");
    fireEvent.paste(prompt, { clipboardData: { files: [file] } });

    // The second read is async, so wait for both chips instead of the container
    // (which already exists and would resolve immediately).
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /remove shot\.png/i })).toHaveLength(2),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /remove shot\.png/i })[0]!);
    expect(screen.getAllByRole("button", { name: /remove shot\.png/i })).toHaveLength(1);
  });
});
