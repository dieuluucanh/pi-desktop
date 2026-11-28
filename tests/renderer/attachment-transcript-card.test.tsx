import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  frameAttachmentTextSections,
  type AttachmentTextEnvelopeInput,
} from "../../src/shared/attachment-text-envelope";
import type {
  AttachmentSubmissionDisplay,
  AttachmentTranscriptCard,
} from "../../src/shared/attachments";
import { AttachmentTranscriptCardView } from "../../src/renderer/src/attachments/AttachmentTranscriptCard";
import { attachmentCardView } from "../../src/renderer/src/attachments/card";
import { Transcript } from "../../src/renderer/src/session/Transcript";
import {
  createTranscriptState,
  hydrateMessages,
  messageFromSdk,
} from "../../src/renderer/src/session/session-events";

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

function imageDisplay(name: string): AttachmentSubmissionDisplay {
  return {
    name,
    originalKind: "image",
    originalBytes: 4_096,
    representationBytes: 1_024,
    origin: "direct",
    preparationVersion: "direct-v1",
    warnings: [],
    coverage: { kind: "entire-file" },
    image: { mime: "image/png", width: 640, height: 480 },
  };
}

function section(n: number, name: string, text: string): AttachmentTextEnvelopeInput {
  return { id: opaque(n), name, representationSha256: sha("a"), text };
}

function framed(sections: readonly AttachmentTextEnvelopeInput[]): string {
  const result = frameAttachmentTextSections(sections);
  if (!result.ok) throw new Error(result.reason);
  return result.framed;
}

function cardFixture(options?: {
  readonly noDisplay?: boolean;
  readonly warnings?: readonly string[];
  readonly withImage?: boolean;
}): { card: AttachmentTranscriptCard; text: string } {
  const sections = [section(1, "notes.txt", "alpha"), section(2, "data.csv", "x,y\n1,2")];
  const files: Array<AttachmentTranscriptCard["files"][number]> = sections.map((item, index) => ({
    representationId: opaque(300 + index),
    originalId: item.id,
    modality: "text",
    ...(options?.noDisplay
      ? {}
      : {
          display: {
            ...textDisplay(item.name, new TextEncoder().encode(item.text).byteLength),
            ...(options?.warnings ? { warnings: [...options.warnings] } : {}),
          },
        }),
  }));
  if (options?.withImage) {
    files.push({
      representationId: opaque(400),
      originalId: opaque(40),
      modality: "image",
      display: imageDisplay("scan.png"),
    });
  }
  return {
    card: {
      version: 1,
      status: "submitted",
      associationEntryId: "assoc-1",
      userEntryId: "user-entry-1",
      turnId: opaque(99),
      files,
    },
    text: `Explain these files\n\n${framed(sections)}`,
  };
}

function viewOf(card: AttachmentTranscriptCard, text: string, images: unknown[] = []) {
  const message = messageFromSdk(
    {
      role: "user",
      content: [{ type: "text", text }, ...images],
      desktopAttachmentCard: card as unknown,
    },
    "message-1",
  );
  const view = attachmentCardView(message);
  if (!view) throw new Error("expected an attachment card view");
  return view;
}

const originalClipboard = navigator.clipboard;

function stubClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
});

describe("AttachmentTranscriptCardView", () => {
  it("renders provenance, coverage and warnings without the raw envelope", () => {
    const fixture = cardFixture({ warnings: ["Resized to fit"] });
    render(<AttachmentTranscriptCardView view={viewOf(fixture.card, fixture.text)} />);

    expect(screen.getByTestId("attachment-transcript-card")).toBeInTheDocument();
    expect(screen.getAllByTestId("attachment-card-name").map((node) => node.textContent)).toEqual([
      "notes.txt",
      "data.csv",
    ]);
    expect(screen.getAllByTestId("attachment-card-provenance")[0]).toHaveTextContent(
      "Original text · 15 B → submitted 5 B of text · direct · direct-v1",
    );
    expect(screen.getAllByTestId("attachment-card-provenance")[0]).toHaveTextContent(
      "coverage entire-file",
    );
    expect(screen.getAllByTestId("attachment-card-warnings")[0]).toHaveTextContent(
      "Resized to fit",
    );
    expect(screen.queryByText(/Untrusted attachment data/)).not.toBeInTheDocument();
  });

  it("shows a bounded inert text preview only when expanded and copies the full section", async () => {
    const long = "a".repeat(9 * 1024);
    const sections = [section(3, "long.txt", long)];
    const text = framed(sections);
    const value: AttachmentTranscriptCard = {
      version: 1,
      status: "submitted",
      associationEntryId: "assoc-2",
      userEntryId: "user-entry-2",
      turnId: opaque(98),
      files: [
        {
          representationId: opaque(303),
          originalId: sections[0]!.id,
          modality: "text",
          display: textDisplay("long.txt", 9 * 1024),
        },
      ],
    };
    render(<AttachmentTranscriptCardView view={viewOf(value, text)} />);

    expect(screen.queryByTestId("attachment-submitted-text")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("attachment-submitted-toggle"));
    const preview = screen.getByTestId("attachment-submitted-text");
    expect(preview.textContent).toHaveLength(8 * 1024);
    expect(screen.getByText(/showing the first 8\.0 KB of 9\.0 KB/)).toBeInTheDocument();

    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    fireEvent.click(screen.getByTestId("attachment-copy-submitted-text"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(long);
  });

  it("renders a submitted image from the persisted block", () => {
    const fixture = cardFixture({ withImage: true });
    const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
    render(<AttachmentTranscriptCardView view={viewOf(fixture.card, fixture.text, [image])} />);

    fireEvent.click(screen.getAllByTestId("attachment-submitted-toggle")[2]!);
    const img = screen.getByTestId("attachment-submitted-image") as HTMLImageElement;
    expect(img.src).toBe("data:image/png;base64,aW1hZ2U=");
    expect(img.alt).toBe("Submitted image for scan.png");
    expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("explains unavailable submitted content instead of pretending", () => {
    const fixture = cardFixture({ withImage: true });
    render(<AttachmentTranscriptCardView view={viewOf(fixture.card, fixture.text)} />);

    const unavailable = screen.getAllByTestId("attachment-submitted-unavailable");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toHaveTextContent("Submitted image unavailable");
    expect(screen.getAllByTestId("attachment-submitted-toggle")).toHaveLength(2);
  });

  it("marks provenance unavailable for an older card", () => {
    const fixture = cardFixture({ noDisplay: true });
    render(<AttachmentTranscriptCardView view={viewOf(fixture.card, fixture.text)} />);
    expect(screen.getAllByTestId("attachment-card-provenance")[0]).toHaveTextContent(
      "Source details unavailable",
    );
    expect(screen.getAllByTestId("attachment-card-name")[0]).toHaveTextContent("Attachment");
  });

  it("keeps hostile filenames inert", () => {
    const sections = [section(4, "<img src=x onerror=alert(1)>.txt", "body")];
    const text = framed(sections);
    const value: AttachmentTranscriptCard = {
      version: 1,
      status: "submitted",
      associationEntryId: "assoc-3",
      userEntryId: "user-entry-3",
      turnId: opaque(97),
      files: [
        {
          representationId: opaque(304),
          originalId: sections[0]!.id,
          modality: "text",
          display: textDisplay(sections[0]!.name, 4),
        },
      ],
    };
    const { container } = render(<AttachmentTranscriptCardView view={viewOf(value, text)} />);
    expect(screen.getByTestId("attachment-card-name")).toHaveTextContent(
      "<img src=x onerror=alert(1)>.txt",
    );
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("transcript mounting", () => {
  it("hydrates a persisted managed turn and groups it into the card", () => {
    const fixture = cardFixture();
    const state = hydrateMessages(createTranscriptState(), [
      {
        id: "user-entry-1",
        role: "user",
        content: [{ type: "text", text: fixture.text }],
        desktopAttachmentCard: fixture.card,
      },
      { role: "assistant", content: [{ type: "text", text: "Here is the summary." }] },
    ]);

    render(<Transcript items={state.items} />);
    expect(screen.getByText("Explain these files")).toBeInTheDocument();
    const card = screen.getByTestId("attachment-transcript-card");
    expect(within(card).getByText("Attachments · 2 files")).toBeInTheDocument();
    expect(within(card).getAllByTestId("attachment-card-name")).toHaveLength(2);
    expect(screen.queryByText(/Untrusted attachment data/)).not.toBeInTheDocument();
  });

  it("leaves an unmatched managed message as ordinary Pi text", () => {
    const fixture = cardFixture();
    const state = hydrateMessages(createTranscriptState(), [
      {
        id: "user-entry-1",
        role: "user",
        content: [{ type: "text", text: "prose only, no envelope" }],
        desktopAttachmentCard: fixture.card,
      },
    ]);

    render(<Transcript items={state.items} />);
    expect(screen.getByText("prose only, no envelope")).toBeInTheDocument();
    expect(screen.getByTestId("attachment-card-ungrouped")).toHaveTextContent(
      "does not match this card",
    );
    expect(screen.getAllByTestId("attachment-submitted-unavailable")).toHaveLength(2);
  });
});
