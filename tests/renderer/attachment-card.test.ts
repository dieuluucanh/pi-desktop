import { describe, expect, it } from "vitest";
import {
  frameAttachmentTextSections,
  type AttachmentTextEnvelopeInput,
} from "../../src/shared/attachment-text-envelope";
import type {
  AttachmentSubmissionDisplay,
  AttachmentTranscriptCard,
} from "../../src/shared/attachments";
import { attachmentCardView, groupedUserProse } from "../../src/renderer/src/attachments/card";
import {
  applyAttachmentTranscriptCard,
  createTranscriptState,
  hydrateMessages,
  messageFromSdk,
} from "../../src/renderer/src/session/session-events";
import { promptHistoryFromTranscript } from "../../src/renderer/src/session/prompt-history";
import { findInTranscript } from "../../src/renderer/src/session/transcript-search";

const opaque = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
const sha = (character: string): string => character.repeat(64);

function textDisplay(name: string, bytes: number): AttachmentSubmissionDisplay {
  return {
    name,
    originalKind: "text",
    originalBytes: bytes + 10,
    representationBytes: bytes,
    origin: "direct",
    preparationVersion: "direct-v1",
    warnings: [],
    coverage: { kind: "entire-file" },
    image: null,
  };
}

function imageDisplay(
  name: string,
  overrides: Partial<NonNullable<AttachmentSubmissionDisplay["image"]>> = {},
): AttachmentSubmissionDisplay {
  return {
    name,
    originalKind: "image",
    originalBytes: 4_096,
    representationBytes: 1_024,
    origin: "direct",
    preparationVersion: "direct-v1",
    warnings: [],
    coverage: { kind: "entire-file" },
    image: { mime: "image/png", width: 640, height: 480, ...overrides },
  };
}

function textSection(
  n: number,
  name: string,
  text: string,
  displayBytes = new TextEncoder().encode(text).byteLength,
): AttachmentTextEnvelopeInput & { display: AttachmentSubmissionDisplay } {
  return {
    id: opaque(n),
    name,
    representationSha256: sha("a"),
    text,
    display: textDisplay(name, displayBytes),
  };
}

function card(files: AttachmentTranscriptCard["files"]): AttachmentTranscriptCard {
  return {
    version: 1,
    status: "submitted",
    associationEntryId: "assoc-1",
    userEntryId: "user-entry-1",
    turnId: opaque(99),
    files,
  };
}

function messageOf(content: unknown, value: AttachmentTranscriptCard) {
  return messageFromSdk(
    { role: "user", content, desktopAttachmentCard: value as unknown },
    "message-1",
  );
}

function framed(sections: readonly AttachmentTextEnvelopeInput[]): string {
  const result = frameAttachmentTextSections(sections);
  if (!result.ok) throw new Error(result.reason);
  return result.framed;
}

function managedText(prose: string, sections: readonly AttachmentTextEnvelopeInput[]): string {
  const envelope = framed(sections);
  return prose ? `${prose}\n\n${envelope}` : envelope;
}

function textAndImageCard(sections: AttachmentTextEnvelopeInput[]) {
  return card([
    ...sections.map((section) => ({
      representationId: opaque(300 + sections.indexOf(section)),
      originalId: section.id,
      modality: "text" as const,
      display: textDisplay(section.name, new TextEncoder().encode(section.text).byteLength),
    })),
    {
      representationId: opaque(400),
      originalId: opaque(40),
      modality: "image",
      display: imageDisplay("scan.png"),
    },
  ]);
}

const IMAGE_BLOCK = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };

describe("attachment card view", () => {
  it("groups validated text sections, keeps prose, and maps submitted images", () => {
    const sections = [textSection(1, "a.txt", "alpha"), textSection(2, "b.csv", "x,y\n1,2")];
    const value = textAndImageCard(sections);
    const message = messageOf(
      [{ type: "text", text: managedText("Explain these files", sections) }, IMAGE_BLOCK],
      value,
    );

    const view = attachmentCardView(message);
    expect(view).not.toBeNull();
    expect(view?.grouped).toBe(true);
    expect(view?.prose).toBe("Explain these files");
    expect(view?.imagesSubmitted).toBe(true);
    expect(view?.files.map((entry) => entry.submitted.kind)).toEqual(["text", "text", "image"]);
    expect(view?.files[0]?.submitted).toMatchObject({ section: { name: "a.txt", text: "alpha" } });
    expect(view?.files[2]?.submitted).toMatchObject({ mimeType: "image/png", data: "aW1hZ2U=" });
    expect(view?.files.every((entry) => entry.provenanceRecorded)).toBe(true);
    expect(view?.fullText).toContain("Untrusted attachment data");
  });

  it("handles file-only prompts and duplicate names by id", () => {
    const sections = [textSection(3, "same.txt", "first"), textSection(4, "same.txt", "second")];
    const message = messageOf(
      [{ type: "text", text: managedText("", sections) }],
      textAndImageCard(sections),
    );
    const view = attachmentCardView(message);
    expect(view?.prose).toBe("");
    expect(view?.files[0]?.submitted).toMatchObject({ section: { text: "first" } });
    expect(view?.files[1]?.submitted).toMatchObject({ section: { text: "second" } });
  });

  it("degrades to raw text when the envelope no longer matches the card", () => {
    const sections = [textSection(5, "a.txt", "alpha")];
    const value = textAndImageCard(sections);
    const tampered = managedText("prose", sections).replace('"alpha"', '"changed"');
    const view = attachmentCardView(messageOf([{ type: "text", text: tampered }], value));
    expect(view?.grouped).toBe(false);
    expect(view?.prose).toBe(tampered);
    expect(view?.files[0]?.submitted).toEqual({
      kind: "unavailable",
      reason: "missing_text_section",
    });
    // Unrelated prose keeps rendering, and even a marker-only message is never
    // treated as a managed section.
    expect(
      attachmentCardView(messageOf([{ type: "text", text: "just prose" }], value))?.grouped,
    ).toBe(false);
    expect(
      attachmentCardView(messageOf([{ type: "text", text: "just prose" }], value))?.prose,
    ).toBe("just prose");
  });

  it("keeps text attribution when provenance display is missing (old v1 card)", () => {
    const sections = [textSection(6, "old.txt", "legacy")];
    const value = card([
      { representationId: opaque(401), originalId: sections[0]!.id, modality: "text" },
    ]);
    const view = attachmentCardView(
      messageOf([{ type: "text", text: managedText("hello", sections) }], value),
    );
    expect(view?.grouped).toBe(true);
    expect(view?.prose).toBe("hello");
    expect(view?.files[0]?.provenanceRecorded).toBe(false);
    expect(view?.files[0]?.submitted).toMatchObject({ section: { text: "legacy" } });
  });

  it("does not attribute images when the persisted blocks disagree", () => {
    const sections = [textSection(7, "a.txt", "alpha")];
    const value = textAndImageCard(sections);
    const content = (images: unknown[]) => [
      { type: "text", text: managedText("hi", sections) },
      ...images,
    ];

    // Count mismatch (two card images expected, one persisted).
    const twoImages = card([
      ...value.files,
      {
        representationId: opaque(402),
        originalId: opaque(41),
        modality: "image",
        display: imageDisplay("second.png"),
      },
    ]);
    expect(attachmentCardView(messageOf(content([IMAGE_BLOCK]), twoImages))?.imagesSubmitted).toBe(
      false,
    );

    // Mime mismatch versus the recorded prepared image.
    const jpeg = { type: "image", mimeType: "image/jpeg", data: "aW1hZ2U=" };
    const mismatch = attachmentCardView(messageOf(content([jpeg]), value));
    expect(mismatch?.imagesSubmitted).toBe(false);
    expect(mismatch?.files[1]?.submitted).toEqual({ kind: "unavailable", reason: "missing_image" });

    // Unknown MIME is never rendered as a submitted card image.
    const svg = { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" };
    expect(attachmentCardView(messageOf(content([svg]), value))?.imagesSubmitted).toBe(false);

    // Empty payload cannot be attributed.
    const empty = { type: "image", mimeType: "image/png", data: "" };
    expect(attachmentCardView(messageOf(content([empty]), value))?.imagesSubmitted).toBe(false);
  });

  it("returns null for messages without a card and for assistants", () => {
    expect(attachmentCardView(messageFromSdk({ role: "user", content: "plain" }))).toBeNull();
    const value = card([
      { representationId: opaque(403), originalId: opaque(42), modality: "text" },
    ]);
    expect(
      attachmentCardView(
        messageFromSdk({ role: "assistant", content: "answer", desktopAttachmentCard: value }),
      ),
    ).toBeNull();
  });

  it("recalls only prose in prompt history, never the managed envelope", () => {
    const sections = [textSection(8, "a.txt", "alpha")];
    const value = textAndImageCard(sections);
    const message = messageOf(
      [{ type: "text", text: managedText("Summarize this", sections) }],
      value,
    );
    expect(groupedUserProse(message)).toBe("Summarize this");
    expect(promptHistoryFromTranscript([message])).toEqual(["Summarize this"]);
    // A tampered envelope has no grouped prose; the raw text is preserved.
    expect(groupedUserProse(messageOf([{ type: "text", text: "just prose" }], value))).toBeNull();
    expect(
      promptHistoryFromTranscript([messageOf([{ type: "text", text: "just prose" }], value)]),
    ).toEqual(["just prose"]);
  });
});

describe("accepted transcript reconciliation", () => {
  function liveState() {
    const base = hydrateMessages(createTranscriptState(), [
      { id: "live-1", role: "user", content: [{ type: "text", text: "with files" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    const items = base.items.map((item) => {
      if (item.kind !== "message") return item;
      return {
        ...item,
        message:
          item.message.role === "user"
            ? { ...item.message, attachmentTurnId: opaque(99) }
            : item.message,
      };
    });
    return { ...base, items };
  }

  const liveCard: AttachmentTranscriptCard = {
    version: 1,
    status: "submitted",
    associationEntryId: "assoc-live",
    userEntryId: "user-entry-live",
    turnId: opaque(99),
    files: [
      {
        representationId: opaque(500),
        originalId: opaque(50),
        modality: "image",
        display: imageDisplay("shot.png"),
      },
    ],
  };

  it("reconciles an accepted turn onto the live message by turn id", () => {
    const state = liveState();
    const reconciled = applyAttachmentTranscriptCard(state, liveCard);
    const user = reconciled.items.find(
      (item) => item.kind === "message" && item.message.role === "user",
    );
    expect(user?.kind).toBe("message");
    if (user?.kind !== "message") throw new Error("expected a user message");
    expect(user.message.attachmentCard).toEqual(liveCard);
    expect(user.message.id).toBe("user-entry-live");
    expect(user.id).toBe("user-entry-live");
    expect(reconciled.messageIndex["user-entry-live"]).toBe(0);
    expect(reconciled.messageIndex["live-1"]).toBeUndefined();
    expect(reconciled.entryIds["user-entry-live"]).toBe(true);
  });

  it("ignores a card whose turn is no longer in the transcript", () => {
    const state = liveState();
    expect(applyAttachmentTranscriptCard(state, { ...liveCard, turnId: opaque(98) })).toBe(state);
    const assistantOnly = {
      ...state,
      items: state.items.filter((item) => item.kind === "message" && item.message.role !== "user"),
    };
    expect(applyAttachmentTranscriptCard(assistantOnly, liveCard)).toBe(assistantOnly);
  });
});

describe("transcript search over grouped content", () => {
  it("still finds managed text the card shows only on demand", () => {
    const sections = [textSection(9, "log.txt", "unique-needle inside")];
    const value = textAndImageCard(sections);
    const message = messageOf(
      [{ type: "text", text: managedText("Search this", sections) }],
      value,
    );
    const items = [{ kind: "message" as const, id: message.id, message }];
    const result = findInTranscript(items, "unique-needle");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.itemId).toBe(message.id);
    // The rendered prose no longer contains the envelope, but the card is what
    // makes the match reachable.
    expect(attachmentCardView(message)?.prose).toBe("Search this");
  });
});
