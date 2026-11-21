import { useEffect, useRef, useState } from "react";
import { Eye, File, FileText, Image, LoaderCircle, RefreshCw, X } from "lucide-react";
import type {
  AttachmentDescriptor,
  AttachmentPreview,
  AttachmentSnapshot,
} from "../../../shared/attachments";
import type { AttachmentDraftState } from "./controller";
import { Button } from "../ui/button";

interface AttachmentTrayProps {
  state: AttachmentDraftState;
  onPick: () => void;
  onRemove: (id: string) => void;
  onPreview: (id: string) => Promise<AttachmentPreview | null>;
  onDismissIssue: (index: number) => void;
  onDismissImport: (operationId: number) => void;
  onRetryDelivery?: () => void;
  /** Explicit user decision to abandon an unresolved attempt. */
  onResetDraft?: () => void;
  sendReady?: boolean;
}

interface PreviewState {
  readonly id: string;
  readonly loading: boolean;
  readonly kind: "text" | "image";
  readonly text: string | null;
  readonly imageUrl: string | null;
  readonly truncated: boolean;
  readonly error: string | null;
}

const TEXT_PREVIEW_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/x-ndjson",
  "application/yaml",
  "application/toml",
]);

function canPreviewText(snapshot: AttachmentSnapshot): boolean {
  return snapshot.mimeType.startsWith("text/") || TEXT_PREVIEW_MIMES.has(snapshot.mimeType);
}

function canPreviewImage(snapshot: AttachmentSnapshot): boolean {
  return snapshot.mimeType.startsWith("image/");
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function itemIcon(snapshot: AttachmentSnapshot) {
  if (snapshot.mimeType.startsWith("image/")) return <Image className="size-4" aria-hidden />;
  if (canPreviewText(snapshot)) return <FileText className="size-4" aria-hidden />;
  return <File className="size-4" aria-hidden />;
}

function pickerIssue(reason: string): string {
  switch (reason) {
    case "unsupported_format":
      return "This format is not supported for direct attachment. Try a text file or supported image.";
    case "too_many_files":
      return "The draft already has the maximum number of files. Remove one before adding more.";
    case "not_regular":
      return "That selection is not a regular file. Choose a file stored on this device.";
    case "uncertain":
      return "The import may have completed. Check the attachment list before choosing it again.";
    default:
      return "The file could not be imported. Try choosing it again.";
  }
}

function deliveryReason(reason: string): string {
  switch (reason) {
    case "conversion_required":
      return "This document needs local conversion, which is not available yet.";
    case "format_unsupported":
      return "This file format cannot be sent directly.";
    case "model_unknown":
      return "The active model's attachment capability is unknown.";
    case "model_modality_unsupported":
      return "The active model does not support this attachment type.";
    case "model_limits_unknown":
      return "The active model's request limits are unknown; delivery was blocked.";
    case "busy":
      return "The session is busy; files are not queued.";
    case "command_unsupported":
      return "Commands and templates cannot consume file attachments.";
    case "context_limit_exceeded":
      return "The files exceed the available context budget.";
    case "text_limit_exceeded":
      return "The selected text exceeds the attachment text limit.";
    case "image_limit_exceeded":
      return "The selected images exceed the active model's image limits.";
    case "image_pipeline_unsafe":
      return "The image could not be safely prepared for this model.";
    case "sdk_hook_unsafe":
    case "sdk_pipeline_unsafe":
      return "The SDK could not guarantee safe attachment delivery.";
    case "original_too_large":
      return "The original file exceeds the supported size limit.";
    case "host_unsupported":
      return "This session's host does not support file sending. Restart the app or that session tab to update it.";
    case "release_unavailable":
      return "File sending is not enabled in this build yet.";
    default:
      return "The attachment plan is unavailable or stale. Review the selection and try again.";
  }
}

function importIssue(reason: string | null): string {
  switch (reason) {
    case "unsupported":
      return "This format is not supported for direct attachment. Try a text file or supported image.";
    case "timeout":
      return "Import timed out. Choose the file again to retry.";
    case "cancelled":
      return "Import was cancelled.";
    case "uncertain":
      return "The import may have completed. Check the attachment list before retrying.";
    default:
      return "Import failed. Choose the file again to retry.";
  }
}

/** Proactive per-file explanation from the authoritative descriptor. */
function descriptorNote(snapshot: AttachmentDescriptor): string | null {
  if (snapshot.status === "blocked") {
    return snapshot.reason ? deliveryReason(snapshot.reason) : "This file is blocked.";
  }
  if (snapshot.status === "needs_conversion") {
    return "Needs local text conversion, which is not available yet.";
  }
  if (snapshot.status === "failed") return "This file could not be classified.";
  if (snapshot.reason) return deliveryReason(snapshot.reason);
  return null;
}

function decodePreview(preview: AttachmentPreview): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(preview.bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Blob URLs are created only for an already validated host thumbnail. */
function previewImageUrl(preview: AttachmentPreview): string | null {
  if (typeof URL.createObjectURL !== "function") return null;
  return URL.createObjectURL(new Blob([new Uint8Array(preview.bytes)], { type: preview.mimeType }));
}

function AttachmentCard({
  snapshot,
  preview,
  onRemove,
  onPreview,
}: {
  snapshot: AttachmentSnapshot;
  preview: PreviewState | null;
  onRemove: (id: string) => void;
  onPreview: (id: string) => void;
}) {
  const isText = canPreviewText(snapshot);
  const isImage = canPreviewImage(snapshot);
  const note = "reason" in snapshot ? descriptorNote(snapshot as AttachmentDescriptor) : null;
  return (
    <li className="min-w-0 rounded-sm border border-line bg-raised/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-ink-muted">{itemIcon(snapshot)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs" title={snapshot.name}>
            {snapshot.name}
          </span>
          <span className="block text-[10px] text-ink-faint">
            {snapshot.mimeType} · {sizeLabel(snapshot.size)} · selected for this draft
          </span>
          {note ? (
            <span className="block text-[10px] text-warn" role="status">
              {note}
            </span>
          ) : null}
        </span>
        {isText || isImage ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`${preview?.id === snapshot.id ? "Hide" : "Preview"} ${snapshot.name}`}
            title={isImage ? "Preview the prepared image" : "Preview as inert plain text"}
            onClick={() => onPreview(snapshot.id)}
          >
            <Eye className="size-3.5" aria-hidden />
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${snapshot.name}`}
          title="Remove attachment from this draft"
          onClick={() => onRemove(snapshot.id)}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      {isImage ? (
        <p className="mt-1 text-[10px] text-ink-faint">
          Previews use a bounded copy prepared from the validated image; the original is unchanged.
        </p>
      ) : null}
      {preview?.id === snapshot.id ? (
        preview.loading ? (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-ink-muted" role="status">
            <LoaderCircle className="size-3 animate-spin" aria-hidden /> Loading preview…
          </p>
        ) : preview.error ? (
          <p className="mt-1 text-[11px] text-warn" role="status">
            {preview.error}
          </p>
        ) : preview.kind === "image" && preview.imageUrl ? (
          <div className="mt-2">
            <img
              src={preview.imageUrl}
              alt={`Prepared preview of ${snapshot.name}`}
              className="max-h-36 max-w-full rounded-xs border border-line object-contain"
            />
            <p className="mt-1 text-[10px] text-ink-faint">
              Host-validated prepared preview; the original file remains unchanged.
            </p>
          </div>
        ) : preview.text !== null ? (
          <div className="mt-2">
            <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-xs bg-sunken p-2 font-mono text-[11px] text-ink">
              {preview.text}
            </pre>
            <p className="mt-1 text-[10px] text-ink-faint">
              Inert text preview{preview.truncated ? " · showing the first 64 KiB" : ""}; active
              markup is not rendered.
            </p>
          </div>
        ) : null
      ) : null}
    </li>
  );
}

export function AttachmentTray({
  state,
  onPick,
  onRemove,
  onPreview,
  onDismissIssue,
  onDismissImport,
  onRetryDelivery,
  onResetDraft,
  sendReady = true,
}: AttachmentTrayProps) {
  const scopeKey = `${state.tabId}:${state.generation}`;
  const [previewEntry, setPreviewEntry] = useState<{
    scope: string;
    value: PreviewState | null;
  } | null>(null);
  const preview = previewEntry?.scope === scopeKey ? previewEntry.value : null;
  const requestId = useRef(0);
  const busyRemovals = useRef(new Set<string>());
  // Revoke every object URL when the shown image changes, is hidden, or the tray
  // unmounts: a preview URL is a local capability for exactly one shown image.
  const imageUrl = preview?.imageUrl ?? null;
  useEffect(() => {
    if (!imageUrl) return;
    return () => URL.revokeObjectURL(imageUrl);
  }, [imageUrl]);

  const togglePreview = async (id: string): Promise<void> => {
    if (preview?.id === id) {
      requestId.current += 1;
      setPreviewEntry({ scope: scopeKey, value: null });
      return;
    }
    const request = ++requestId.current;
    setPreviewEntry({
      scope: scopeKey,
      value: {
        id,
        loading: true,
        kind: "text",
        text: null,
        imageUrl: null,
        truncated: false,
        error: null,
      },
    });
    const snapshot = state.descriptors.find((item) => item.id === id);
    if (!snapshot || !(canPreviewText(snapshot) || canPreviewImage(snapshot))) return;
    const result = await onPreview(id);
    if (requestId.current !== request) return;
    if (!result) {
      setPreviewEntry({
        scope: scopeKey,
        value: {
          id,
          loading: false,
          kind: "text",
          text: null,
          imageUrl: null,
          truncated: false,
          error: "Preview is unavailable. The original file remains unchanged.",
        },
      });
      return;
    }
    if (result.kind === "image") {
      const url = previewImageUrl(result);
      setPreviewEntry({
        scope: scopeKey,
        value: {
          id,
          loading: false,
          kind: "image",
          text: null,
          imageUrl: url,
          truncated: false,
          error: url ? null : "This environment cannot display the prepared preview.",
        },
      });
      return;
    }
    try {
      setPreviewEntry({
        scope: scopeKey,
        value: {
          id,
          loading: false,
          kind: "text",
          text: decodePreview(result),
          imageUrl: null,
          truncated: result.truncated,
          error: null,
        },
      });
    } catch {
      setPreviewEntry({
        scope: scopeKey,
        value: {
          id,
          loading: false,
          kind: "text",
          text: null,
          imageUrl: null,
          truncated: false,
          error: "This file is not valid UTF-8 text, so no text preview is shown.",
        },
      });
    }
  };

  const remove = (id: string): void => {
    if (busyRemovals.current.has(id)) return;
    busyRemovals.current.add(id);
    void Promise.resolve(onRemove(id)).finally(() => busyRemovals.current.delete(id));
    if (preview?.id === id) {
      requestId.current += 1;
      setPreviewEntry({ scope: scopeKey, value: null });
    }
  };

  const hasContent =
    state.descriptors.length > 0 || state.imports.length > 0 || state.issues.length > 0;
  if (!hasContent && state.phase === "ready") return null;

  return (
    <section
      className="mb-2 flex flex-col gap-2 rounded-sm border border-line bg-surface p-2"
      data-testid="attachment-tray"
      aria-label="File attachments"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-xs font-medium">Attachments</h2>
          <p className="text-[10px] text-ink-faint">
            Selected files are sent with a normal prompt only after host, model, and format checks.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={onPick}
          disabled={
            state.phase !== "ready" ||
            state.submission.phase === "submitting" ||
            state.submission.phase === "uncertain" ||
            state.submission.phase === "review_required"
          }
        >
          Add files
        </Button>
      </div>

      {state.readiness?.outcome === "blocked" && state.readiness.reasons.length > 0 ? (
        <p className="text-[11px] text-warn" role="status" aria-live="polite">
          Not ready to send: {state.readiness.reasons.map(deliveryReason).join(" ")}
        </p>
      ) : null}
      {!sendReady && state.descriptors.length > 0 && state.submission.phase !== "uncertain" ? (
        <p className="text-[11px] text-warn" role="status" aria-live="polite">
          Files can only be sent while the host is idle. They will not be queued.
        </p>
      ) : null}
      {state.submission.phase === "submitting" ? (
        <p className="text-[11px] text-ink-muted" role="status" aria-live="polite">
          Checking the active model and sending the selected files…
        </p>
      ) : state.submission.phase === "blocked" ? (
        <p className="text-[11px] text-warn" role="alert">
          Files were not sent: {state.submission.reasons.map(deliveryReason).join(" ")}
        </p>
      ) : state.submission.phase === "handled" ? (
        <p className="text-[11px] text-warn" role="alert">
          The request was consumed without sending the files. The prompt and selection were kept.
        </p>
      ) : state.submission.phase === "review_required" ? (
        <div
          className="flex items-center gap-2 rounded-sm border border-warn/50 bg-raised/60 px-2 py-1.5"
          role="alert"
        >
          <p className="min-w-0 flex-1 text-[11px] text-warn">
            An earlier send may have been accepted, but the prompt or file set now differs.
            Replaying it could duplicate the turn, so it will not be resent automatically.
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onResetDraft?.()}
            disabled={!onResetDraft}
            data-testid="attachment-reset-draft"
          >
            Start a new draft
          </Button>
        </div>
      ) : state.submission.phase === "uncertain" ? (
        <div
          className="flex items-center gap-2 rounded-sm border border-warn/50 bg-raised/60 px-2 py-1.5"
          role="alert"
        >
          <p className="min-w-0 flex-1 text-[11px] text-warn">
            Delivery is uncertain. Do not resend automatically.
            {state.submission.reasons?.length
              ? ` ${state.submission.reasons.map(deliveryReason).join(" ")}`
              : " Review the session, then explicitly retry this same prompt and file set."}
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onRetryDelivery?.()}
            disabled={!sendReady || !onRetryDelivery}
          >
            Retry previous send
          </Button>
        </div>
      ) : null}

      {state.phase === "loading" || state.phase === "unavailable" ? (
        <p className="text-[11px] text-warn" role="status" aria-live="polite">
          {state.phase === "loading"
            ? "Opening this draft’s attachment list…"
            : "Attachment storage is unavailable. Restart the app or try again before adding files."}
        </p>
      ) : null}

      {state.imports.map((item) => (
        <div
          key={item.operationId}
          className="flex min-w-0 items-center gap-2 rounded-sm border border-line px-2 py-1.5"
          data-testid="attachment-import"
        >
          {item.phase === "importing" ? (
            <LoaderCircle className="size-4 shrink-0 animate-spin text-accent" aria-hidden />
          ) : (
            <File className="size-4 shrink-0 text-warn" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs" title={item.name}>
              {item.name}
            </p>
            {item.phase === "importing" ? (
              <div className="flex items-center gap-2">
                <progress
                  className="h-1.5 min-w-12 flex-1 accent-accent"
                  aria-label={`Importing ${item.name}`}
                  max={item.totalBytes || 1}
                  value={item.bytesRead}
                />
                <span className="text-[10px] text-ink-faint" role="status" aria-live="polite">
                  {item.totalBytes > 0
                    ? `${Math.round((item.bytesRead / item.totalBytes) * 100)}%`
                    : "Starting"}
                </span>
              </div>
            ) : (
              <p className="text-[10px] text-warn" role="alert">
                {importIssue(item.reason)}
              </p>
            )}
          </div>
          {item.phase !== "importing" ? (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Choose file again for ${item.name}`}
                title="Choose a file again to retry"
                onClick={onPick}
              >
                <RefreshCw className="size-3.5" aria-hidden />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Dismiss failed import ${item.name}`}
                onClick={() => onDismissImport(item.operationId)}
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            </>
          ) : null}
        </div>
      ))}

      {state.descriptors.length > 0 ? (
        <ul className="flex max-h-64 flex-col gap-1.5 overflow-auto" aria-label="Attached files">
          {state.descriptors.map((snapshot) => (
            <AttachmentCard
              key={snapshot.id}
              snapshot={snapshot}
              preview={preview?.id === snapshot.id ? preview : null}
              onRemove={remove}
              onPreview={(id) => void togglePreview(id)}
            />
          ))}
        </ul>
      ) : null}

      {state.issues.map((issue, index) => (
        <div
          key={`${index}-${issue.name}`}
          className="flex min-w-0 items-start gap-2 rounded-sm border border-warn/50 bg-raised/60 px-2 py-1.5"
          role="alert"
          data-testid="attachment-issue"
        >
          <File className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <p className="min-w-0 flex-1 text-[11px]">
            <span className="font-medium" title={issue.name}>
              {issue.name}:{" "}
            </span>
            {pickerIssue(issue.reason)}
          </p>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Dismiss file issue for ${issue.name}`}
            onClick={() => onDismissIssue(index)}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        </div>
      ))}
    </section>
  );
}
