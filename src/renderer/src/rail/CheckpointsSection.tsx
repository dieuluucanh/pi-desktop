/**
 * The Checkpoints section (git-checkpoint plan step 22).
 *
 * A newest-first timeline of folder snapshots, whatever the folder holds — an
 * Office document, a pile of images, a code checkout. Three actions live on rows
 * and one in the footer:
 *
 *  - **Snapshot now** takes a `manual` checkpoint immediately.
 *  - **Preview & restore…** opens {@link RestoreDialog} (never a blind restore).
 *  - **Copy ref** puts the commit sha on the clipboard, so a checkpoint can be
 *    named in a bug report or restored from a terminal.
 *  - The footer shows usage and offers **Prune now…**, behind the shared
 *    confirmation because it deletes history.
 *
 * After a successful restore the store records the pre-restore ref; the section
 * turns that into a **Undo** affordance, which is the answer to the "restore is
 * irreversible" failure mode (D10, and Zed's #28676).
 */

import { useEffect, useState } from "react";
import { Camera, Copy, History, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { useAppStore } from "../state/app-store";
import type { Checkpoint } from "../../../shared/checkpoints";
import { RestoreDialog } from "./RestoreDialog";
import {
  KIND_LABELS,
  KIND_TONES,
  canRewindConversation,
  canSnapshot,
  checkpointAge,
  checkpointDetail,
  checkpointLinkage,
  checkpointTitle,
  linkageLabel,
  runSnapshotsUnavailable,
  unavailableCopy,
  usageSummary,
} from "./checkpoints-view";

export interface CheckpointsSectionProps {
  projectPath: string;
  /**
   * The entry ids the open transcript knows (plan step 25). A checkpoint whose
   * `entryId` is in here came from a turn of *this* session; one that is missing
   * may still belong to an ancestor (a forked session inherits them), and a
   * checkpoint with no entry id at all is a manual/safety snapshot.
   */
  entryIds?: Readonly<Record<string, true>>;
}

/** Copy a string, falling back to the legacy path in an older webview. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // A denied clipboard permission is not worth a banner: the ref is visible in
    // the row's title, so the user can still read it.
  }
}

export function CheckpointsSection({ projectPath, entryIds }: CheckpointsSectionProps) {
  const state = useAppStore((store) => store.checkpoints[projectPath]);
  const error = useAppStore((store) => store.checkpointsError);
  const undoRef = useAppStore((store) => store.checkpointsUndoRef[projectPath]);
  const loadCheckpoints = useAppStore((store) => store.loadCheckpoints);
  const refreshCheckpoints = useAppStore((store) => store.refreshCheckpoints);
  const createCheckpoint = useAppStore((store) => store.createCheckpoint);
  const previewCheckpoint = useAppStore((store) => store.previewCheckpoint);
  const restoreCheckpoint = useAppStore((store) => store.restoreCheckpoint);
  const undoRestoreCheckpoint = useAppStore((store) => store.undoRestoreCheckpoint);
  const pruneCheckpoints = useAppStore((store) => store.pruneCheckpoints);
  const clearError = useAppStore((store) => store.clearCheckpointsError);

  // One frozen clock per mount: relative ages should not jitter on every
  // unrelated re-render, and reading `Date.now()` during render is impure.
  const [now] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [pruneOpen, setPruneOpen] = useState(false);
  const [restoreFor, setRestoreFor] = useState<Checkpoint | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewCheckpoint>>>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // The section only mounts while it is expanded, so mounting is the signal to
  // hydrate. `state` guards against a refetch on every render.
  useEffect(() => {
    if (!state) void loadCheckpoints(projectPath);
  }, [state, projectPath, loadCheckpoints]);

  const unavailable = state ? unavailableCopy(state) : null;

  const openRestore = async (checkpoint: Checkpoint): Promise<void> => {
    setRestoreFor(checkpoint);
    setPreview(null);
    setRestoreError(null);
    setPreviewLoading(true);
    const next = await previewCheckpoint(projectPath, checkpoint.ref);
    setPreview(next);
    setPreviewLoading(false);
  };

  const confirmRestore = async (options: { removeAdded: boolean }): Promise<void> => {
    if (!restoreFor) return;
    setBusy(true);
    const result = await restoreCheckpoint(projectPath, restoreFor.ref, options);
    setBusy(false);
    if (result.ok) {
      setRestoreFor(null);
      setPreview(null);
    } else {
      // Keep the dialog open: the user needs to see why it failed (a locked
      // document, a full disk) and decide whether to retry.
      setRestoreError(result.error ?? "The restore failed.");
    }
  };

  const undo = async (): Promise<void> => {
    setBusy(true);
    await undoRestoreCheckpoint(projectPath);
    setBusy(false);
  };

  const snapshotNow = async (): Promise<void> => {
    setBusy(true);
    await createCheckpoint(projectPath);
    setBusy(false);
  };

  const confirmPrune = async (): Promise<void> => {
    setPruneOpen(false);
    setBusy(true);
    await pruneCheckpoints(projectPath);
    setBusy(false);
  };

  if (!state) {
    return (
      <p className="px-3 py-2 text-[11px] text-ink-faint" data-testid="checkpoints-loading">
        Loading checkpoints…
      </p>
    );
  }

  if (unavailable) {
    return (
      <div className="flex flex-col gap-1 px-3 py-2" data-testid="checkpoints-unavailable">
        <p className="text-[11px] text-warn">{unavailable}</p>
        {state.reason === "git_missing" ? (
          <p className="text-[11px] text-ink-faint">
            Git is not bundled with Pi Desktop; it is resolved from your PATH.
          </p>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="mt-1 self-start"
          onClick={() => void refreshCheckpoints(projectPath)}
        >
          Check again
        </Button>
      </div>
    );
  }

  const usage = usageSummary(state);
  const runOff = runSnapshotsUnavailable(state);

  /**
   * The row's provenance chip (plan step 25). A run checkpoint from this very
   * session reads "This session"; one from an ancestor reads "Before the fork";
   * a manual or safety snapshot needs no chip at all, because its kind badge
   * already says what it is.
   */
  function renderLinkage(checkpoint: Checkpoint) {
    // An unhydrated transcript knows no entry ids. Saying "Before the fork" then
    // would be a claim the rail cannot back, so it stays quiet until hydration.
    if (!entryIds) return null;
    const linkage = checkpointLinkage(checkpoint, entryIds);
    const label = linkageLabel(linkage);
    if (!label) return null;
    return (
      <span
        className="shrink-0 rounded border border-line px-1 text-[10px] text-ink-faint"
        data-testid={`checkpoint-linkage-${linkage}`}
        title={
          canRewindConversation(checkpoint, entryIds)
            ? "This checkpoint belongs to a turn of this conversation"
            : "This checkpoint belongs to a conversation before this fork"
        }
      >
        {label}
      </span>
    );
  }

  return (
    <div className="flex flex-col pb-2" data-testid="checkpoints-section">
      <div className="flex items-center gap-1 px-3 py-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-[11px]"
          data-testid="checkpoint-create"
          disabled={busy || !canSnapshot(state)}
          onClick={() => void snapshotNow()}
        >
          <Camera className="size-3" aria-hidden />
          Snapshot now
        </Button>
        {undoRef ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px] text-accent"
            data-testid="checkpoint-undo"
            disabled={busy}
            onClick={() => void undo()}
          >
            <RotateCcw className="size-3" aria-hidden />
            Undo restore
          </Button>
        ) : null}
      </div>

      {!state.enabled ? (
        <p className="px-3 py-1 text-[11px] text-ink-faint" data-testid="checkpoints-disabled">
          Checkpoints are turned off in Settings.
        </p>
      ) : null}

      {runOff ? (
        <p className="px-3 py-1 text-[11px] text-ink-faint" data-testid="checkpoints-run-off">
          Automatic snapshots are unavailable — safe mode is on, or the session host is older than
          this build. Manual snapshots still work.
        </p>
      ) : null}

      {error ? (
        <div className="flex items-start gap-1 px-3 py-1" data-testid="checkpoints-error">
          <p className="min-w-0 flex-1 text-[11px] text-danger">{error}</p>
          <button
            type="button"
            className="shrink-0 text-[11px] text-ink-faint hover:text-ink"
            onClick={clearError}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {state.checkpoints.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-ink-faint" data-testid="checkpoints-empty">
          No checkpoints yet. One is taken automatically before each prompt, and you can take one at
          any time.
        </p>
      ) : (
        <ul className="flex flex-col">
          {state.checkpoints.map((checkpoint) => (
            <li key={checkpoint.id} data-testid={`checkpoint-${checkpoint.ref.slice(0, 8)}`}>
              <div className="group flex flex-col gap-0.5 px-3 py-1 hover:bg-raised/50">
                <div className="flex items-center gap-1">
                  <Badge tone={KIND_TONES[checkpoint.kind]}>{KIND_LABELS[checkpoint.kind]}</Badge>
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink"
                    title={checkpointTitle(checkpoint)}
                  >
                    {checkpointTitle(checkpoint)}
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-faint">
                    {checkpointAge(checkpoint.createdAt, now)}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] text-ink-faint"
                    data-testid="checkpoint-detail"
                  >
                    {checkpointDetail(checkpoint)}
                  </span>
                  {renderLinkage(checkpoint)}
                  {/* Visible on hover and on keyboard focus, per the row pattern. */}
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 hover:text-ink focus:opacity-100 group-hover:opacity-100"
                    aria-label={`Preview and restore ${checkpoint.ref.slice(0, 8)}`}
                    data-testid={`checkpoint-restore-${checkpoint.ref.slice(0, 8)}`}
                    disabled={busy}
                    onClick={() => void openRestore(checkpoint)}
                  >
                    <History className="size-3" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 hover:text-ink focus:opacity-100 group-hover:opacity-100"
                    aria-label={`Copy ref ${checkpoint.ref.slice(0, 8)}`}
                    data-testid={`checkpoint-copy-${checkpoint.ref.slice(0, 8)}`}
                    onClick={() => void copyText(checkpoint.ref)}
                  >
                    <Copy className="size-3" aria-hidden />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-1 flex items-center gap-1 border-t border-line px-3 pt-1">
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-ink-faint"
          data-testid="checkpoint-usage"
        >
          {usage.text}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-[11px]"
          data-testid="checkpoint-prune"
          disabled={busy || state.checkpoints.length === 0}
          onClick={() => setPruneOpen(true)}
        >
          <Trash2 className="size-3" aria-hidden />
          Prune now
        </Button>
      </div>

      <RestoreDialog
        open={restoreFor !== null}
        checkpoint={restoreFor}
        preview={preview}
        loading={previewLoading}
        busy={busy}
        error={restoreError}
        onCancel={() => {
          setRestoreFor(null);
          setPreview(null);
          setRestoreError(null);
        }}
        onConfirm={(options) => void confirmRestore(options)}
      />

      <ConfirmDialog
        open={pruneOpen}
        title="Prune checkpoints?"
        description={`Checkpoints older than the retention window, above the count limit, or past the size budget will be dropped. The newest checkpoint is always kept. This folder currently holds ${state.checkpoints.length}.`}
        confirmLabel="Prune"
        onConfirm={() => void confirmPrune()}
        onCancel={() => setPruneOpen(false)}
      />
    </div>
  );
}
