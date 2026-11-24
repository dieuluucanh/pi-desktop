import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Composer } from "../../src/renderer/src/session/Composer";
import {
  composerDraftFor,
  useAppStore,
  type DraftApplyStoreResult,
} from "../../src/renderer/src/state/app-store";
import {
  addDraftAttachments,
  createComposerDraft,
} from "../../src/renderer/src/session/composer-draft";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { ImageAttachment } from "../../src/renderer/src/session/image-attachment";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * The atomic live-snapshot capture and CAS application (2026-11-22
 * prompt-refinement plan step 19).
 *
 * These tests drive the store, not the pure model: a candidate may replace the
 * draft only when the exact capture it started from is still current. The
 * interesting refusals are the races a real operation sees — newer typing, a
 * host restore, an attachment change, an edit-then-revert, a closed tab — plus
 * the idempotent apply a replayed completion performs.
 */

function tab(id = "tab-1", title = "app"): TabRecord {
  return {
    id,
    kind: "session",
    cwd: "/work/app",
    title,
    sessionFile: `/profile/${id}.jsonl`,
    status: "idle",
    createdAt: 0,
    lastActiveAt: 0,
    model: "test-model",
  };
}

function image(id: string, data = "AAAA"): ImageAttachment {
  return { id, name: `${id}.png`, mimeType: "image/png", data };
}

function snapshot(tabId = "tab-1") {
  return useAppStore.getState().draftSnapshot(tabId);
}

function candidate(
  overrides: Partial<{ operationId: string; candidateRevision: number; text: string }> = {},
) {
  return { operationId: "op-1", candidateRevision: 1, text: "Refined prompt", ...overrides };
}

function resetStore(tabs: TabRecord[] = [tab()]): void {
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    transcripts: {},
    sessionStates: {},
    draftHistory: {},
    historyBrowse: {},
    composerDrafts: {},
    composerApplyReceipts: {},
    composerCaretRequests: {},
    pasteBodies: {},
    pasteCounter: 1,
    hint: null,
  });
}

function refusedReason(result: DraftApplyStoreResult): string | null {
  return result.status === "refused" ? result.reason : null;
}

let handles: ReturnType<typeof installBridge>;

beforeEach(() => {
  handles = installBridge();
  resetStore();
});

describe("atomic apply", () => {
  it("replaces the text on the exact capture and keeps the live attachments", () => {
    const first = image("image-1");
    const second = image("image-2");
    useAppStore.getState().setDraft("tab-1", "please improve this");
    useAppStore.getState().addDraftImages("tab-1", [first, second]);
    const base = snapshot();

    const result = useAppStore.getState().applyDraftCandidate("tab-1", {
      base,
      candidate: candidate(),
    });

    expect(result.status).toBe("applied");
    const draft = composerDraftFor(useAppStore.getState(), "tab-1");
    expect(draft.text).toBe("Refined prompt");
    expect(draft.revision).toBeGreaterThan(base.revision);
    expect(draft.attachmentRevision).toBe(base.attachmentRevision);
    expect(draft.attachments).toEqual([first, second]);
    expect(draft.attachments[0]).toBe(first);
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("Refined prompt");
    expect(useAppStore.getState().composerCaretRequests["tab-1"]).toEqual({
      token: 1,
      text: "Refined prompt",
      caret: "Refined prompt".length,
    });
  });

  it("flushes the new text through the preferences path immediately", async () => {
    useAppStore.getState().setDraft("tab-1", "draft");
    const setSpy = vi.spyOn(handles.bridge.prefs, "set");
    const base = snapshot();

    useAppStore.getState().applyDraftCandidate("tab-1", { base, candidate: candidate() });

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]?.[0]).toMatchObject({ drafts: { "tab-1": "Refined prompt" } });
    await waitFor(() => expect(handles.prefs.drafts["tab-1"]).toBe("Refined prompt"));
  });

  it("records the applied receipt and makes a duplicate completion idempotent", () => {
    useAppStore.getState().setDraft("tab-1", "draft");
    const base = snapshot();
    const request = { base, candidate: candidate() };

    const first = useAppStore.getState().applyDraftCandidate("tab-1", request);
    const applied = composerDraftFor(useAppStore.getState(), "tab-1");
    expect(first.status).toBe("applied");
    expect(useAppStore.getState().composerApplyReceipts["tab-1"]).toEqual([
      {
        operationId: "op-1",
        appliedRevision: 1,
        disposition: "replaced",
        appliedAt: expect.any(Number) as number,
      },
    ]);

    const setSpy = vi.spyOn(handles.bridge.prefs, "set");
    const duplicate = useAppStore.getState().applyDraftCandidate("tab-1", request);

    expect(refusedReason(duplicate)).toBe("duplicate");
    expect(composerDraftFor(useAppStore.getState(), "tab-1")).toBe(applied);
    expect(useAppStore.getState().composerApplyReceipts["tab-1"]).toHaveLength(1);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("rejects a later revision of an operation that already applied", () => {
    useAppStore.getState().setDraft("tab-1", "draft");
    const base = snapshot();
    useAppStore.getState().applyDraftCandidate("tab-1", { base, candidate: candidate() });

    const again = useAppStore.getState().applyDraftCandidate("tab-1", {
      base,
      candidate: candidate({ candidateRevision: 2 }),
    });
    expect(refusedReason(again)).toBe("already-applied");
  });
});

describe("stale base snapshots", () => {
  it("refuses newer typing and leaves the draft untouched", () => {
    useAppStore.getState().setDraft("tab-1", "draft");
    const base = snapshot();
    useAppStore.getState().setDraft("tab-1", "draft plus newer typing");
    const typed = composerDraftFor(useAppStore.getState(), "tab-1");

    const result = useAppStore.getState().applyDraftCandidate("tab-1", {
      base,
      candidate: candidate(),
    });

    expect(refusedReason(result)).toBe("stale-base");
    expect(composerDraftFor(useAppStore.getState(), "tab-1")).toBe(typed);
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("draft plus newer typing");
    expect(useAppStore.getState().composerApplyReceipts["tab-1"]).toBeUndefined();
  });

  it("refuses a draft replaced from outside (a host write through preferences)", () => {
    useAppStore.getState().setDraft("tab-1", "draft");
    const base = snapshot();
    useAppStore.getState().setPrefs({ drafts: { "tab-1": "restored from disk" } });

    const result = useAppStore.getState().applyDraftCandidate("tab-1", {
      base,
      candidate: candidate(),
    });
    expect(refusedReason(result)).toBe("stale-base");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("restored from disk");
  });

  it("refuses an edit-then-revert even though the text matches the capture (ABA)", () => {
    useAppStore.getState().setDraft("tab-1", "a");
    const base = snapshot();
    useAppStore.getState().setDraft("tab-1", "b");
    useAppStore.getState().setDraft("tab-1", "a");

    const result = useAppStore.getState().applyDraftCandidate("tab-1", {
      base,
      candidate: candidate(),
    });
    expect(refusedReason(result)).toBe("stale-base");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("a");
  });

  it("refuses after an attachment is added, removed or reordered", () => {
    useAppStore.getState().setDraft("tab-1", "look");
    useAppStore.getState().addDraftImages("tab-1", [image("image-1"), image("image-2")]);
    const base = snapshot();
    const request = { base, candidate: candidate({ text: "refined" }) };

    useAppStore.getState().addDraftImages("tab-1", [image("image-3")]);
    expect(refusedReason(useAppStore.getState().applyDraftCandidate("tab-1", request))).toBe(
      "stale-base",
    );

    resetStore();
    useAppStore.getState().setDraft("tab-1", "look");
    useAppStore.getState().addDraftImages("tab-1", [image("image-1"), image("image-2")]);
    const withBoth = snapshot();
    useAppStore.getState().removeDraftImage("tab-1", "image-1");
    expect(
      refusedReason(
        useAppStore
          .getState()
          .applyDraftCandidate("tab-1", { base: withBoth, candidate: candidate({ text: "x" }) }),
      ),
    ).toBe("stale-base");

    resetStore();
    useAppStore.getState().setDraft("tab-1", "look");
    useAppStore.getState().addDraftImages("tab-1", [image("image-1"), image("image-2")]);
    const ordered = snapshot();
    // Reordering the same two attachments still changes the ordered identity set.
    const record = composerDraftFor(useAppStore.getState(), "tab-1");
    useAppStore.setState({
      composerDrafts: {
        ...useAppStore.getState().composerDrafts,
        "tab-1": addDraftAttachments(addDraftAttachments(createComposerDraft(record.text), []), [
          record.attachments[1]!,
          record.attachments[0]!,
        ]),
      },
    });
    expect(
      refusedReason(
        useAppStore
          .getState()
          .applyDraftCandidate("tab-1", { base: ordered, candidate: candidate({ text: "x" }) }),
      ),
    ).toBe("stale-base");
  });
});

describe("explicit replace", () => {
  it("applies when the confirmed revision is still current, keeping current attachments", () => {
    useAppStore.getState().setDraft("tab-1", "original");
    const base = snapshot();
    useAppStore.getState().setDraft("tab-1", "original plus my edit");
    useAppStore.getState().addDraftImages("tab-1", [image("image-1")]);
    const confirmed = snapshot();

    const automatic = useAppStore.getState().applyDraftCandidate("tab-1", {
      base,
      candidate: candidate(),
    });
    expect(refusedReason(automatic)).toBe("stale-base");

    const result = useAppStore.getState().replaceDraftWithCandidate("tab-1", {
      confirmed,
      candidate: candidate(),
    });
    expect(result.status).toBe("applied");
    const draft = composerDraftFor(useAppStore.getState(), "tab-1");
    expect(draft.text).toBe("Refined prompt");
    expect(draft.attachments.map((attachment) => attachment.id)).toEqual(["image-1"]);
  });

  it("refuses when a newer edit landed after the confirmation was shown", () => {
    useAppStore.getState().setDraft("tab-1", "original");
    useAppStore.getState().setDraft("tab-1", "shown in the confirm dialog");
    const confirmed = snapshot();
    useAppStore.getState().setDraft("tab-1", "typed after confirming");

    const result = useAppStore.getState().replaceDraftWithCandidate("tab-1", {
      confirmed,
      candidate: candidate(),
    });
    expect(refusedReason(result)).toBe("stale-base");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("typed after confirming");
  });
});

describe("tab boundaries", () => {
  it("applies to a background tab without touching the active draft", () => {
    resetStore([tab("tab-1"), tab("tab-2", "second")]);
    useAppStore.getState().setDraft("tab-1", "active draft");
    useAppStore.getState().setDraft("tab-2", "background draft");
    const background = useAppStore.getState().draftSnapshot("tab-2");

    const result = useAppStore.getState().applyDraftCandidate("tab-2", {
      base: background,
      candidate: candidate({ text: "refined background" }),
    });

    expect(result.status).toBe("applied");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("active draft");
    expect(useAppStore.getState().prefs.drafts["tab-2"]).toBe("refined background");
    expect(useAppStore.getState().composerCaretRequests["tab-2"]).toBeDefined();
    expect(useAppStore.getState().composerCaretRequests["tab-1"]).toBeUndefined();
  });

  it("refuses a closed tab and prunes its receipts/caret request with the draft", () => {
    useAppStore.getState().setDraft("tab-1", "draft");
    const base = snapshot();
    useAppStore.getState().applyDraftCandidate("tab-1", { base, candidate: candidate() });
    expect(useAppStore.getState().composerApplyReceipts["tab-1"]).toBeDefined();
    expect(useAppStore.getState().composerCaretRequests["tab-1"]).toBeDefined();

    useAppStore.getState().applyTabs({ tabs: [], activeTabId: null, revision: 1_000 });

    expect(useAppStore.getState().composerDrafts["tab-1"]).toBeUndefined();
    expect(useAppStore.getState().composerApplyReceipts["tab-1"]).toBeUndefined();
    expect(useAppStore.getState().composerCaretRequests["tab-1"]).toBeUndefined();

    const result = useAppStore.getState().applyDraftCandidate("tab-1", {
      base,
      candidate: candidate({ operationId: "op-2", candidateRevision: 2 }),
    });
    expect(refusedReason(result)).toBe("closed-tab");
  });
});

/** A parent that behaves like `SessionView`: the store owns text and caret request. */
function ComposerHarness() {
  const draft = useAppStore((state) => state.prefs.drafts["tab-1"] ?? "");
  const caretRequest = useAppStore((state) => state.composerCaretRequests["tab-1"] ?? null);
  const setDraft = useAppStore((state) => state.setDraft);
  return (
    <Composer
      tabId="tab-1"
      running={false}
      draft={draft}
      caretRequest={caretRequest}
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

describe("caret restoration", () => {
  it("focuses the composer and places the caret at the end of the applied text", async () => {
    render(<ComposerHarness />);
    useAppStore.getState().setDraft("tab-1", "draft text");
    const base = snapshot();

    useAppStore.getState().applyDraftCandidate("tab-1", {
      base,
      candidate: candidate({ text: "A refined and longer prompt" }),
    });

    const textarea = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).toHaveFocus());
    expect(textarea.value).toBe("A refined and longer prompt");
    expect(textarea.selectionStart).toBe("A refined and longer prompt".length);
    expect(textarea.selectionEnd).toBe(textarea.selectionStart);
    expect(snapshot().selection).toEqual({
      start: "A refined and longer prompt".length,
      end: "A refined and longer prompt".length,
    });
  });

  it("does not steal the caret when a newer edit replaced the applied text", async () => {
    render(<ComposerHarness />);
    useAppStore.getState().setDraft("tab-1", "draft text");
    const base = snapshot();
    useAppStore.getState().applyDraftCandidate("tab-1", {
      base,
      candidate: candidate({ text: "refined" }),
    });
    // The user types immediately after the apply (a later store update).
    useAppStore.getState().setDraft("tab-1", "refined plus more typing");

    const textarea = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("refined plus more typing"));
    expect(textarea.selectionStart).toBe("refined plus more typing".length);
  });
});
