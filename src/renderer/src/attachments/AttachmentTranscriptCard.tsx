import { useId, useMemo, useState } from "react";
import { FileText, Image as ImageIcon } from "lucide-react";
import {
  attachmentTextPreview,
  type AttachmentTextEnvelopeSection,
} from "../../../shared/attachment-text-envelope";
import type { AttachmentTranscriptFile } from "../../../shared/attachments";
import { copyText } from "../ui/clipboard";
import type { AttachmentCardFileView, AttachmentCardView } from "./card";

/** A bounded, inert preview. "Copy text" always copies the full section. */
export const ATTACHMENT_SUBMITTED_PREVIEW_BYTES = 8 * 1024;

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function unavailableLabel(
  reason: Extract<AttachmentCardFileView["submitted"], { kind: "unavailable" }>["reason"],
): string {
  switch (reason) {
    case "missing_text_section":
      return "Submitted text unavailable: the persisted message no longer matches this card.";
    case "missing_image":
      return "Submitted image unavailable: this card and the persisted image count disagree.";
    case "unverified_image":
      return "Submitted image unavailable: the persisted image cannot be attributed safely.";
  }
}

function provenanceLine(file: AttachmentTranscriptFile): string | null {
  const display = file.display;
  if (!display) return null;
  const submitted =
    file.modality === "image" && display.image
      ? `${display.image.mime} ${display.image.width}×${display.image.height} · ${bytesLabel(display.representationBytes)}`
      : `${bytesLabel(display.representationBytes)} of text`;
  const origin = display.origin === "direct" ? "direct" : "converted";
  return `Original ${display.originalKind} · ${bytesLabel(display.originalBytes)} → submitted ${submitted} · ${origin} · ${display.preparationVersion}`;
}

function TextSubmittedPreview({ section }: { section: AttachmentTextEnvelopeSection }) {
  const preview = useMemo(
    () => attachmentTextPreview(section.text, ATTACHMENT_SUBMITTED_PREVIEW_BYTES),
    [section.text],
  );
  return (
    <div className="mt-2">
      <pre
        className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xs bg-sunken p-2 font-mono text-[11px] text-ink"
        data-testid="attachment-submitted-text"
      >
        {preview.text}
      </pre>
      <p className="mt-1 text-[10px] text-ink-faint">
        Inert submitted text
        {preview.truncated
          ? ` · showing the first ${bytesLabel(ATTACHMENT_SUBMITTED_PREVIEW_BYTES)} of ${bytesLabel(preview.totalBytes)}`
          : ` · ${bytesLabel(preview.totalBytes)}`}
        ; active markup is not rendered.
      </p>
    </div>
  );
}

function SubmittedImagePreview({
  mimeType,
  data,
  name,
}: {
  mimeType: string;
  data: string;
  name: string;
}) {
  const url = useMemo(() => `data:${mimeType};base64,${data}`, [mimeType, data]);
  return (
    <div className="mt-2">
      <img
        src={url}
        alt={`Submitted image for ${name}`}
        loading="lazy"
        decoding="async"
        className="max-h-48 max-w-full rounded-xs border border-line object-contain"
        data-testid="attachment-submitted-image"
      />
      <p className="mt-1 text-[10px] text-ink-faint">
        Submitted image as Pi persisted it; the original file is never re-read here.
      </p>
    </div>
  );
}

function CopyButton({ label, text, testId }: { label: string; text: string; testId?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className="shrink-0 text-ink-muted hover:text-ink"
      data-testid={testId}
      onClick={() => {
        void copyText(text).then((ok) => {
          setStatus(ok ? "copied" : "failed");
          setTimeout(() => setStatus("idle"), 1_500);
        });
      }}
    >
      {status === "copied" ? "copied" : status === "failed" ? "copy failed" : label}
    </button>
  );
}

function FileRow({ entry }: { entry: AttachmentCardFileView }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const { file, submitted, provenanceRecorded } = entry;
  const name = file.display?.name ?? "Attachment";
  const submittedText = submitted.kind === "text" ? submitted.section.text : null;
  const toggleLabel =
    submitted.kind === "text"
      ? expanded
        ? "Hide submitted text"
        : "Show submitted text"
      : expanded
        ? "Hide submitted image"
        : "Show submitted image";
  const canToggle = submitted.kind === "text" || submitted.kind === "image";

  return (
    <li
      className="rounded-xs border border-line bg-surface px-2 py-1.5"
      data-testid="attachment-card-file"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-ink-faint" aria-hidden>
          {file.modality === "image" ? (
            <ImageIcon className="size-3.5" />
          ) : (
            <FileText className="size-3.5" />
          )}
        </span>
        <span
          className="min-w-0 truncate text-xs text-ink"
          title={name}
          data-testid="attachment-card-name"
        >
          {name}
        </span>
        <span className="shrink-0 rounded-full border border-line px-1.5 text-[10px] uppercase tracking-wide text-ink-faint">
          {file.modality}
        </span>
        {canToggle ? (
          <button
            type="button"
            className="ml-auto shrink-0 text-[11px] text-ink-muted hover:text-ink"
            aria-expanded={expanded}
            aria-controls={panelId}
            data-testid="attachment-submitted-toggle"
            onClick={() => setExpanded((value) => !value)}
          >
            {toggleLabel}
          </button>
        ) : null}
      </div>
      {provenanceRecorded ? (
        <p className="mt-1 text-[10px] text-ink-faint" data-testid="attachment-card-provenance">
          {provenanceLine(file)}
          {file.display ? ` · coverage ${file.display.coverage.kind}` : ""}
        </p>
      ) : (
        <p className="mt-1 text-[10px] text-ink-faint" data-testid="attachment-card-provenance">
          Source details unavailable: recorded by an older submission card.
        </p>
      )}
      {file.display && file.display.warnings.length > 0 ? (
        <ul
          className="mt-1 space-y-0.5 text-[10px] text-warn"
          data-testid="attachment-card-warnings"
        >
          {file.display.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <div id={panelId}>
        {expanded && submitted.kind === "text" ? (
          <TextSubmittedPreview section={submitted.section} />
        ) : null}
        {expanded && submitted.kind === "image" ? (
          <SubmittedImagePreview mimeType={submitted.mimeType} data={submitted.data} name={name} />
        ) : null}
      </div>
      {submitted.kind === "unavailable" ? (
        <p className="mt-1 text-[10px] text-warn" data-testid="attachment-submitted-unavailable">
          {unavailableLabel(submitted.reason)}
        </p>
      ) : null}
      {submittedText !== null ? (
        <div className="mt-1 text-[10px] text-ink-faint">
          <CopyButton
            label="Copy text"
            text={submittedText}
            testId="attachment-copy-submitted-text"
          />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The submitted-attachment card mounted by the transcript.
 *
 * It distinguishes the approved original/prepared provenance from the content
 * Pi actually persisted. Delivered text/images are shown lazily and bounded;
 * the card never re-reads the project or source path and never claims that a
 * provider or model retained every byte.
 */
export function AttachmentTranscriptCardView({ view }: { view: AttachmentCardView }) {
  const textFiles = view.files.filter((entry) => entry.submitted.kind === "text");
  return (
    <section
      className="mt-2 rounded-sm border border-line bg-sunken/60 px-2 py-1.5"
      aria-label="Submitted attachments"
      data-testid="attachment-transcript-card"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-[11px] font-medium text-ink">
          Attachments · {view.card.files.length} {view.card.files.length === 1 ? "file" : "files"}
        </span>
        <span className="rounded-full border border-line px-1.5 text-[10px] uppercase tracking-wide text-ink-faint">
          {view.card.status}
        </span>
        {view.grouped ? (
          <span className="ml-auto shrink-0 text-[10px] text-ink-faint">
            <CopyButton
              label="Copy submitted content"
              text={view.fullText}
              testId="attachment-copy-full"
            />
          </span>
        ) : null}
      </div>
      {!view.grouped ? (
        <p className="mt-1 text-[10px] text-warn" data-testid="attachment-card-ungrouped">
          The persisted message does not match this card, so it stays as ordinary text.
        </p>
      ) : null}
      <ul className="mt-1 space-y-1">
        {view.files.map((entry) => (
          <FileRow key={entry.file.representationId} entry={entry} />
        ))}
      </ul>
      {textFiles.length > 0 ? (
        <p className="mt-1 text-[10px] text-ink-faint">
          Text is what Pi persisted in this session; a trusted extension may rewrite content before
          the model sees it.
        </p>
      ) : null}
    </section>
  );
}
