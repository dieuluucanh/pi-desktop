import { useAppStore } from "../state/app-store";
import { ConfirmDialog } from "../ui/confirm-dialog";

/**
 * The truthful-content confirmation for native exports (plan step 15).
 *
 * Pi's JSONL/HTML export is the live conversation including every user or
 * assistant text/image block — managed attachment text and inline images
 * included. The dialog says so before writing; the sanitized export is the
 * separate, clearly labeled alternative.
 */
export function ExportConfirmDialog() {
  const pending = useAppStore((state) => state.pendingExport);
  const confirm = useAppStore((state) => state.confirmExport);
  const cancel = useAppStore((state) => state.cancelExport);
  const format = pending?.format ?? "html";
  const label = format === "jsonl" ? "JSONL" : "HTML";
  return (
    <ConfirmDialog
      open={pending !== null}
      title={`Export native ${label}?`}
      description={
        <>
          This is Pi's own {label} export. It contains the text and images that were sent in the
          conversation, including managed attachment text and inline images. Original files are not
          included, and the live session file is not modified. Use the sanitized transcript export
          if the file will be shared.
        </>
      }
      confirmLabel={`Export ${label}`}
      tone="accent"
      onConfirm={() => void confirm()}
      onCancel={cancel}
    />
  );
}
