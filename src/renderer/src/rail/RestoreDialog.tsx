/**
 * The restore dialog (git-checkpoint plan step 22, D10).
 *
 * Restoring a checkpoint overwrites the working tree, which is exactly the
 * operation Zed's issue #28676 made famous for being destructive: there was no
 * undo of the undo. This dialog is the answer, and it shows the four things a
 * person needs before pressing the button:
 *
 *  1. **What will change** — grouped, and counted per group.
 *  2. **What will be removed** — behind an explicit checkbox, off by default.
 *  3. **What is open in Office right now** — a locked `.docx` cannot be written,
 *     so the user is told to close it *before* the restore, not after a failure.
 *  4. **What the safety net is** — main always snapshots `pre-restore` first, and
 *     the toast offers Undo.
 */

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import type { Checkpoint, CheckpointPreviewState } from "../../../shared/checkpoints";

/** How many paths a group lists before it collapses into "+N more". */
export const PREVIEW_VISIBLE_PATHS = 8;

export interface RestoreDialogProps {
  open: boolean;
  checkpoint: Checkpoint | null;
  preview: CheckpointPreviewState | null;
  /** True while the preview is being read. */
  loading: boolean;
  /** True while the restore itself is running. */
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (options: { removeAdded: boolean }) => void;
}

function PathGroup({
  title,
  paths,
  testId,
  tone,
}: {
  title: string;
  paths: readonly string[];
  testId: string;
  tone: "change" | "remove" | "warn";
}) {
  if (paths.length === 0) return null;
  const shown = paths.slice(0, PREVIEW_VISIBLE_PATHS);
  const hidden = paths.length - shown.length;
  const titleClass =
    tone === "warn" ? "text-warn" : tone === "remove" ? "text-danger" : "text-ink-muted";
  return (
    <section className="flex flex-col gap-1" data-testid={testId}>
      <h4 className={`m-0 text-[11px] font-semibold ${titleClass}`}>
        {title} ({paths.length})
      </h4>
      <ul className="m-0 flex flex-col gap-0.5 pl-0 text-[11px]">
        {shown.map((path) => (
          <li key={path} className="truncate font-mono" title={path}>
            {path}
          </li>
        ))}
        {hidden > 0 ? (
          <li className="text-ink-faint" data-testid={`${testId}-more`}>
            +{hidden} more
          </li>
        ) : null}
      </ul>
    </section>
  );
}

export function RestoreDialog({
  open,
  checkpoint,
  preview,
  loading,
  busy,
  error,
  onCancel,
  onConfirm,
}: RestoreDialogProps) {
  // Off by default and re-armed per checkpoint: removing files the user created
  // after the checkpoint must never be an accident. The state is *keyed by ref*
  // rather than reset in an effect — a different checkpoint simply reads as
  // unchecked, with no cascading render.
  const ref = checkpoint?.ref ?? null;
  const [armed, setArmed] = useState<{ ref: string | null; value: boolean }>({
    ref: null,
    value: false,
  });
  const removeAdded = armed.ref === ref ? armed.value : false;
  const setRemoveAdded = (value: boolean): void => setArmed({ ref, value });

  const changes = preview?.restore.length ?? 0;
  const removes = preview?.remove.length ?? 0;
  const conflicted = preview?.openInOffice ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent aria-describedby={undefined} data-testid="restore-dialog">
        <DialogTitle>Restore checkpoint</DialogTitle>
        <DialogDescription>
          {checkpoint
            ? `This folder will be put back to its state at ${new Date(
                checkpoint.createdAt,
              ).toLocaleString()}. A safety snapshot is taken first, so the restore can be undone.`
            : "This folder will be put back to an earlier checkpoint."}
        </DialogDescription>

        <div className="flex max-h-[45vh] flex-col gap-3 overflow-y-auto px-4 py-3">
          {loading ? (
            <p className="text-[11px] text-ink-faint" data-testid="restore-loading">
              Reading what would change…
            </p>
          ) : null}

          {!loading && preview === null ? (
            <p className="text-[11px] text-danger" data-testid="restore-preview-error">
              The preview could not be read, so nothing will be restored.
            </p>
          ) : null}

          {!loading && preview !== null ? (
            <>
              <PathGroup
                title="Will change"
                paths={preview.restore}
                testId="restore-group-change"
                tone="change"
              />
              <PathGroup
                title="Will be removed"
                paths={preview.remove}
                testId="restore-group-remove"
                tone="remove"
              />
              {changes === 0 && removes === 0 ? (
                <p className="text-[11px] text-ink-faint" data-testid="restore-no-changes">
                  This folder already matches the checkpoint.
                </p>
              ) : null}

              {removes > 0 ? (
                <label className="flex items-start gap-2 text-[11px]">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={removeAdded}
                    data-testid="restore-remove-added"
                    onChange={(event) => setRemoveAdded(event.target.checked)}
                  />
                  <span>
                    Also remove the {removes === 1 ? "file" : `${removes} files`} created after this
                    checkpoint
                    <span className="block text-ink-faint">
                      They are moved to the OS trash, not deleted.
                    </span>
                  </span>
                </label>
              ) : null}

              {conflicted.length > 0 ? (
                <p className="text-[11px] text-warn" data-testid="restore-office-warning">
                  Close {conflicted.join(", ")} in Word/Excel first — an open document cannot be
                  written, and would be reported as failed.
                </p>
              ) : null}
            </>
          ) : null}

          {error ? (
            <p className="text-[11px] text-danger" data-testid="restore-error">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="danger"
            data-testid="restore-confirm"
            disabled={busy || loading || preview === null}
            onClick={() => onConfirm({ removeAdded })}
          >
            {busy ? "Restoring…" : "Restore"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
