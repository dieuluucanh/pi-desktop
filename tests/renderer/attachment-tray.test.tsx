import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AttachmentTray } from "../../src/renderer/src/attachments/AttachmentTray";
import type { AttachmentDraftState } from "../../src/renderer/src/attachments/controller";
import type { AttachmentDescriptor } from "../../src/shared/attachments";

const textFile: AttachmentDescriptor = {
  id: "123e4567-e89b-42d3-a456-000000000001",
  name: "report.txt",
  mimeType: "text/plain",
  size: 20,
  originalKind: "text",
  detectedMime: "text/plain",
  status: "ready",
  reason: null,
  representationId: null,
  previewAvailable: true,
  warnings: [],
};

function state(overrides: Partial<AttachmentDraftState> = {}): AttachmentDraftState {
  return {
    tabId: "tab-1",
    generation: 0,
    draftId: "123e4567-e89b-42d3-a456-000000000002",
    phase: "ready",
    descriptors: [],
    readiness: null,
    imports: [],
    issues: [],
    submission: { phase: "idle" },
    error: null,
    ...overrides,
  };
}

describe("AttachmentTray", () => {
  it("shows attachment metadata and renders text previews as inert text", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn(async () => ({
      bytes: new TextEncoder().encode("<script>alert('no')</script>").slice(),
      size: 29,
      truncated: false,
      kind: "text" as const,
      mimeType: "text/plain",
    }));
    render(
      <AttachmentTray
        state={state({ descriptors: [textFile] })}
        onPick={vi.fn()}
        onRemove={vi.fn()}
        onPreview={onPreview}
        onDismissIssue={vi.fn()}
        onDismissImport={vi.fn()}
      />,
    );

    expect(screen.getByText("report.txt")).toBeInTheDocument();
    expect(screen.getByText(/text\/plain · 20 B · selected for this draft/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Preview report.txt" }));
    expect(await screen.findByText("<script>alert('no')</script>")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    expect(onPreview).toHaveBeenCalledWith(textFile.id);
  });

  it("requires an explicit retry after uncertain delivery and preserves the selected files", async () => {
    const user = userEvent.setup();
    const onRetryDelivery = vi.fn();
    render(
      <AttachmentTray
        state={state({
          descriptors: [textFile],
          submission: {
            phase: "uncertain",
            text: "Inspect this file",
            turnId: "123e4567-e89b-42d3-a456-000000000002",
          },
        })}
        onPick={vi.fn()}
        onRemove={vi.fn()}
        onPreview={vi.fn(async () => null)}
        onDismissIssue={vi.fn()}
        onDismissImport={vi.fn()}
        onRetryDelivery={onRetryDelivery}
      />,
    );
    expect(screen.getByText(/Delivery is uncertain/)).toBeInTheDocument();
    expect(screen.getByText("report.txt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry previous send" }));
    expect(onRetryDelivery).toHaveBeenCalledOnce();
  });

  it("requires an explicit new draft when a journaled attempt no longer matches", async () => {
    const user = userEvent.setup();
    const onResetDraft = vi.fn();
    render(
      <AttachmentTray
        state={state({
          descriptors: [textFile],
          submission: {
            phase: "review_required",
            turnId: "123e4567-e89b-42d3-a456-000000000002",
            reason: "text_changed",
          },
        })}
        onPick={vi.fn()}
        onRemove={vi.fn()}
        onPreview={vi.fn(async () => null)}
        onDismissIssue={vi.fn()}
        onDismissImport={vi.fn()}
        onResetDraft={onResetDraft}
      />,
    );
    expect(
      screen.getByText(/may have been accepted, but the prompt or file set now differs/),
    ).toBeInTheDocument();
    // Editing is frozen so a mismatched attempt cannot be silently replayed.
    expect(screen.getByRole("button", { name: "Add files" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Start a new draft" }));
    expect(onResetDraft).toHaveBeenCalledOnce();
  });

  it("offers an image preview only through the host-prepared thumbnail", async () => {
    const user = userEvent.setup();
    const image: AttachmentDescriptor = {
      ...textFile,
      name: "pixel.png",
      mimeType: "image/png",
    };
    const onPreview = vi.fn(async () => null);
    render(
      <AttachmentTray
        state={state({ descriptors: [image] })}
        onPick={vi.fn()}
        onRemove={vi.fn()}
        onPreview={onPreview}
        onDismissIssue={vi.fn()}
        onDismissImport={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Previews use a bounded copy prepared from the validated image/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Preview pixel.png" }));
    expect(onPreview).toHaveBeenCalledWith(image.id);
    expect(
      await screen.findByText(/Preview is unavailable. The original file remains unchanged./),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders a prepared image preview and revokes its object URL", async () => {
    const user = userEvent.setup();
    const image: AttachmentDescriptor = {
      ...textFile,
      name: "pixel.png",
      mimeType: "image/png",
    };
    const create = vi.fn(() => "blob:prepared-preview");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const onPreview = vi.fn(async () => ({
      bytes: new Uint8Array([137, 80, 78, 71]),
      size: 4,
      truncated: false,
      kind: "image" as const,
      mimeType: "image/png",
    }));
    const { unmount } = render(
      <AttachmentTray
        state={state({ descriptors: [image] })}
        onPick={vi.fn()}
        onRemove={vi.fn()}
        onPreview={onPreview}
        onDismissIssue={vi.fn()}
        onDismissImport={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Preview pixel.png" }));
    expect(await screen.findByRole("img")).toHaveAttribute("src", "blob:prepared-preview");
    expect(create).toHaveBeenCalledTimes(1);
    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:prepared-preview");
    vi.unstubAllGlobals();
  });

  it("shows unsupported audio, video, and archive attempts with dismiss actions", async () => {
    const user = userEvent.setup();
    const onDismissIssue = vi.fn();
    render(
      <AttachmentTray
        state={state({
          issues: [
            { name: "audio.mp3", reason: "unsupported_format" },
            { name: "clip.mp4", reason: "unsupported_format" },
            { name: "bundle.zip", reason: "unsupported_format" },
          ],
        })}
        onPick={vi.fn()}
        onRemove={vi.fn()}
        onPreview={vi.fn(async () => null)}
        onDismissIssue={onDismissIssue}
        onDismissImport={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("alert")).toHaveLength(3);
    expect(screen.getAllByText(/not supported for direct attachment/)).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Dismiss file issue for audio.mp3" }));
    expect(onDismissIssue).toHaveBeenCalledWith(0);
  });

  it("keeps hostile filenames as text and exposes keyboard-reachable actions", async () => {
    const user = userEvent.setup();
    const hostile = { ...textFile, name: '<img src=x onerror="alert(1)">.txt' };
    const onRemove = vi.fn();
    render(
      <AttachmentTray
        state={state({ descriptors: [hostile] })}
        onPick={vi.fn()}
        onRemove={onRemove}
        onPreview={vi.fn(async () => null)}
        onDismissIssue={vi.fn()}
        onDismissImport={vi.fn()}
      />,
    );

    expect(screen.getByText(hostile.name)).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    const remove = screen.getByRole("button", { name: `Remove ${hostile.name}` });
    remove.focus();
    expect(remove).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onRemove).toHaveBeenCalledWith(hostile.id);
  });

  it("announces bounded import progress and offers a reselect action after failure", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <AttachmentTray
        state={state({
          imports: [
            {
              operationId: 1,
              name: "large.csv",
              phase: "importing",
              bytesRead: 50,
              totalBytes: 100,
              attachmentId: null,
              reason: null,
            },
            {
              operationId: 2,
              name: "notes.pdf",
              phase: "failed",
              bytesRead: 0,
              totalBytes: 100,
              attachmentId: null,
              reason: "unsupported",
            },
          ],
        })}
        onPick={onPick}
        onRemove={vi.fn()}
        onPreview={vi.fn(async () => null)}
        onDismissIssue={vi.fn()}
        onDismissImport={vi.fn()}
      />,
    );

    expect(screen.getByRole("progressbar", { name: "Importing large.csv" })).toHaveAttribute(
      "value",
      "50",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("not supported for direct attachment");
    await user.click(screen.getByRole("button", { name: "Choose file again for notes.pdf" }));
    expect(onPick).toHaveBeenCalledOnce();
  });

  it("does not render an empty tray after the draft is ready", () => {
    const { container } = render(
      <AttachmentTray
        state={state()}
        onPick={vi.fn()}
        onRemove={vi.fn()}
        onPreview={vi.fn(async () => null)}
        onDismissIssue={vi.fn()}
        onDismissImport={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
