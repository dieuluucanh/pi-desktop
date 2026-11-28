import { useState } from "react";
import { useAppStore } from "../state/app-store";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";

/**
 * `/share` and `/bug` (2026-10-26 session-parity plan step 18).
 *
 * `/share` uploads a **secret** gist (unlisted, not private — the sentence is
 * shown before the user reads the URL) and offers the viewer link. `/bug` builds
 * a local zip; nothing is uploaded from this build.
 *
 * Every action here is real: when `gh` is missing the dialog says what to install
 * and offers the HTML export instead, rather than presenting a dead button.
 */
export function ShareDialog() {
  const open = useAppStore((state) => state.shareOpen);
  const mode = useAppStore((state) => state.shareMode);
  const status = useAppStore((state) => state.shareStatus);
  const result = useAppStore((state) => state.shareResult);
  const error = useAppStore((state) => state.shareError);
  const errorCode = useAppStore((state) => state.shareErrorCode);
  const includeTranscript = useAppStore((state) => state.shareIncludeTranscript);
  const setIncludeTranscript = useAppStore((state) => state.setShareIncludeTranscript);
  const runBugReport = useAppStore((state) => state.runBugReport);
  const close = useAppStore((state) => state.closeShare);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const requestExport = useAppStore((state) => state.requestExport);
  const tabs = useAppStore((state) => state.tabs);
  const [includeOriginals, setIncludeOriginals] = useState(false);
  const [extraStatus, setExtraStatus] = useState<string | null>(null);
  const [extraBusy, setExtraBusy] = useState(false);
  const sessionFile = tabs.find((tab) => tab.id === activeTabId)?.sessionFile ?? null;
  const openExternal = (url: string) => void window.pi?.openExternal(url);

  const runExtra = async (operation: () => Promise<string | null>) => {
    setExtraBusy(true);
    setExtraStatus(null);
    try {
      setExtraStatus(await operation());
    } catch (error) {
      setExtraStatus(error instanceof Error ? error.message : "The action failed.");
    } finally {
      setExtraBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent aria-describedby={undefined} data-testid="share-dialog">
        <DialogTitle>{mode === "share" ? "Share this session" : "Report a bug"}</DialogTitle>
        <DialogDescription>
          {mode === "share"
            ? "A secret gist: unlisted, not private — anyone with the link can read it. Attached files, images, names and keys are removed first."
            : "A zip with versions, diagnostics and (optionally) the transcript. It never leaves this machine from here. Attachment copies, images and managed file text are excluded; answers or prose may still quote them."}
        </DialogDescription>

        <div className="space-y-2 px-4 pb-4 text-xs">
          {mode === "bug" && status !== "done" ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={includeTranscript}
                onChange={(event) => setIncludeTranscript(event.target.checked)}
              />
              Include the session transcript (attachments and images removed)
            </label>
          ) : null}

          {status === "running" ? (
            <p className="flex items-center gap-2 text-ink-muted" data-testid="share-running">
              <span className="animate-pulse text-accent">●</span>
              {mode === "share"
                ? "Sanitizing and creating the secret gist…"
                : "Sanitizing and building the zip…"}
            </p>
          ) : null}

          {status === "done" && result?.viewerUrl ? (
            <div className="space-y-1" data-testid="share-done">
              <p className="text-ink">Shared.</p>
              <code className="block break-all rounded-sm border border-line bg-sunken px-2 py-1">
                {result.viewerUrl}
              </code>
              {result.gistUrl ? (
                <button
                  type="button"
                  className="text-ink-muted underline hover:text-ink"
                  onClick={() => result.gistUrl && openExternal(result.gistUrl)}
                >
                  Open the gist
                </button>
              ) : null}
            </div>
          ) : null}

          {status === "done" && result?.path ? (
            <div className="space-y-1" data-testid="share-done">
              <p className="text-ink">Bug report written.</p>
              <code className="block break-all rounded-sm border border-line bg-sunken px-2 py-1">
                {result.path}
              </code>
            </div>
          ) : null}

          {status === "error" ? (
            <div className="space-y-1" role="alert" data-testid="share-error">
              <p className="text-danger">{error}</p>
              {errorCode === "gh_missing" ? (
                <p className="text-ink-muted">
                  Install GitHub's CLI (<span className="font-mono">gh</span>) and run{" "}
                  <span className="font-mono">gh auth login</span> with the gist scope, then try
                  again.
                </p>
              ) : null}
              {errorCode === "gh_not_authenticated" ? (
                <p className="text-ink-muted">
                  Run <span className="font-mono">gh auth refresh -s gist</span> to grant the gist
                  scope.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-3 space-y-2 rounded-sm border border-line bg-sunken/40 p-2">
            <p className="text-[11px] text-ink-faint">
              Sanitized transcript: user prose only, with attachment files, images, names and
              descriptors removed. It is not a Pi session file and cannot be reimported.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={extraBusy || !sessionFile}
                data-testid="share-export-sanitized"
                onClick={() =>
                  void runExtra(async () => {
                    if (!sessionFile) return "No session file is available.";
                    const result = await window.pi?.share?.exportSanitized(sessionFile);
                    return result?.ok && result.path
                      ? `Sanitized transcript written to ${result.path}`
                      : (result?.detail ?? "The sanitized transcript could not be written.");
                  })
                }
              >
                Export sanitized transcript…
              </Button>
              <label className="flex items-center gap-1 text-[11px] text-ink-muted">
                <input
                  type="checkbox"
                  checked={includeOriginals}
                  onChange={(event) => setIncludeOriginals(event.target.checked)}
                />
                Include original file contents in a bundle
              </label>
              <Button
                size="sm"
                variant="secondary"
                disabled={extraBusy || !activeTabId}
                data-testid="share-export-bundle"
                onClick={() =>
                  void runExtra(async () => {
                    if (!activeTabId) return "No session is active.";
                    const result = await window.pi?.attachments?.exportBundle({
                      tabId: activeTabId,
                      includeObjects: includeOriginals,
                    });
                    return result?.ok && result.path
                      ? `Bundle written to ${result.path} (${result.assets ?? 0} assets)`
                      : (result?.error ?? "The bundle could not be exported.");
                  })
                }
              >
                Export attachment bundle…
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={extraBusy || !activeTabId}
                data-testid="share-import-bundle"
                onClick={() =>
                  void runExtra(async () => {
                    if (!activeTabId) return "No session is active.";
                    const result = await window.pi?.attachments?.importBundle({
                      tabId: activeTabId,
                    });
                    return result?.ok
                      ? `Imported ${result.originals ?? 0} originals and ${result.representations ?? 0} prepared files into this session.`
                      : (result?.error ?? "The bundle could not be imported.");
                  })
                }
              >
                Import attachment bundle…
              </Button>
            </div>
            {extraStatus ? (
              <p
                className="text-[11px] text-ink-muted"
                role="status"
                data-testid="share-extra-status"
              >
                {extraStatus}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" onClick={close}>
              {status === "done" ? "Close" : "Cancel"}
            </Button>
            {result?.viewerUrl ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => result.viewerUrl && openExternal(result.viewerUrl)}
              >
                Open in browser
              </Button>
            ) : null}
            {result?.viewerUrl ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void navigator.clipboard?.writeText(result.viewerUrl ?? "")}
              >
                Copy URL
              </Button>
            ) : null}
            {mode === "share" && status === "error" ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  close();
                  if (activeTabId) requestExport(activeTabId, "html");
                }}
              >
                Export HTML instead
              </Button>
            ) : null}
            {mode === "bug" && status !== "running" && status !== "done" ? (
              <Button size="sm" variant="primary" onClick={() => void runBugReport()}>
                Create zip
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
