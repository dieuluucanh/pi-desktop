import { useCallback, useEffect, useState } from "react";
import type {
  AttachmentRetentionClearReport,
  AttachmentStorageReport,
} from "../../../shared/attachment-storage";
import { formatBytes } from "../../../shared/performance";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";

/**
 * Settings → Attachments (plan step 13).
 *
 * Read-only reporting plus one explicit reclamation action. The wording is the
 * contract: this deletes app-owned copies only, never Pi's conversation
 * history, provider-retained data or project files. Owned/referenced copies and
 * the 30-day recovery window are never evicted by the sweep or by this button.
 */
export function AttachmentStorageSettingsCard() {
  const [report, setReport] = useState<AttachmentStorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastClear, setLastClear] = useState<AttachmentRetentionClearReport | null>(null);

  const load = useCallback(async () => {
    try {
      const next = (await window.pi?.attachments?.storage()) ?? null;
      setReport(next);
      setError(next === null ? "Attachment storage is unavailable or unreadable." : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Attachment storage is unavailable.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = (await window.pi?.attachments?.storage()) ?? null;
        if (cancelled) return;
        setReport(next);
        setError(next === null ? "Attachment storage is unavailable or unreadable." : null);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Attachment storage is unavailable.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const clear = useCallback(async () => {
    setBusy(true);
    try {
      const result = await window.pi?.attachments?.clearStorage();
      setLastClear(result ?? null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Attachment storage could not be cleared.");
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  }, [load]);

  const quota = report?.quotaBytes ?? 0;
  const usedPercent =
    report && quota > 0 ? Math.min(100, Math.round((report.usedBytes / quota) * 100)) : 0;

  return (
    <section
      className="rounded-md border border-line bg-surface p-4"
      aria-labelledby="storage-title"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="storage-title" className="text-sm font-semibold">
          Attachments
        </h2>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        App-owned copies of files you attached. Deleting a session keeps its copies recoverable for
        30 days; unreferenced copies are reclaimed after 7 days.
      </p>

      {error ? (
        <p className="mt-2 text-xs text-warn" role="status" data-testid="attachment-storage-error">
          {error}
        </p>
      ) : null}

      {report ? (
        <>
          <dl
            className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs"
            data-testid="attachment-storage-report"
          >
            <div className="flex justify-between gap-2">
              <dt className="text-ink-faint">Used</dt>
              <dd className="text-ink">
                {formatBytes(report.usedBytes)} of {formatBytes(quota)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-faint">Free disk</dt>
              <dd className="text-ink">
                {report.freeBytes === null ? "unknown" : formatBytes(report.freeBytes)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-faint">Files</dt>
              <dd className="text-ink">
                {report.originals} originals · {report.representations} prepared
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-faint">Recoverable</dt>
              <dd className="text-ink">
                {report.tombstonedAssets} · {formatBytes(report.tombstonedBytes)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-faint">Unreferenced</dt>
              <dd className="text-ink">
                {report.unowned} · {formatBytes(report.unownedBytes)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-faint">Incomplete imports</dt>
              <dd className="text-ink">
                {report.staging} · {formatBytes(report.stagingBytes)}
              </dd>
            </div>
          </dl>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-sunken"
            role="progressbar"
            aria-label="Attachment storage used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usedPercent}
          >
            <div className="h-full bg-accent" style={{ width: `${usedPercent}%` }} />
          </div>
          <p className="mt-2 text-[11px] text-ink-faint" data-testid="attachment-storage-removable">
            {report.removable} cop{report.removable === 1 ? "y" : "ies"} can be reclaimed now ·{" "}
            {formatBytes(report.removableBytes)} · {report.referenced} still referenced by a session
            or draft.
          </p>
          {lastClear ? (
            <p
              className="mt-2 text-xs text-ink-muted"
              role="status"
              data-testid="attachment-storage-cleared"
            >
              {lastClear.paused
                ? `Nothing was deleted: the ${lastClear.paused} could not be read.`
                : `Removed ${lastClear.assetsRemoved} cop${lastClear.assetsRemoved === 1 ? "y" : "ies"} (${formatBytes(lastClear.bytesFreed)}).`}
              {lastClear.errors > 0
                ? ` ${lastClear.errors} item(s) were left for a later sweep.`
                : ""}
            </p>
          ) : null}
        </>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="danger"
          disabled={busy}
          onClick={() => setConfirmOpen(true)}
          data-testid="attachment-storage-clear"
        >
          Reclaim space…
        </Button>
        <span className="text-[11px] text-ink-faint">
          Local copies only. Sent Pi history and provider-retained data are not removed.
        </span>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Reclaim attachment storage?"
        description="Removes app-owned attachment copies that no session or draft references and that are outside the 30-day recovery window. Pi conversation history, provider-retained data and files in your project are not affected. This cannot restore a removed local copy."
        confirmLabel="Remove unreferenced copies"
        onConfirm={() => void clear()}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}
