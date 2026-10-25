import { useEffect, useState } from "react";
import type { ProjectRecord } from "../../../shared/projects";
import { useAppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

/**
 * Advanced editor for one project's `.pi/settings.json`.
 *
 * The normal Settings view is global-only; this dialog is the escape hatch for
 * keys that only make sense per project. It is reachable only when the project
 * settings toggle is on (and the project is trusted), so the file it edits is
 * the file the project actually uses.
 */
export function ProjectSettingsDialog({
  open,
  project,
  onClose,
}: {
  open: boolean;
  project: ProjectRecord;
  onClose: () => void;
}) {
  const settings = useAppStore((state) => state.settings);
  const settingsBusy = useAppStore((state) => state.settingsBusy);
  const settingsError = useAppStore((state) => state.settingsError);
  const loadSettings = useAppStore((state) => state.loadSettings);
  const writeRawSettings = useAppStore((state) => state.writeRawSettings);
  const resetScope = useAppStore((state) => state.resetScope);
  const inspectProject = useAppStore((state) => state.inspectProject);
  const loadResources = useAppStore((state) => state.loadResources);
  const applyModelScopeToTabs = useAppStore((state) => state.applyModelScopeToTabs);

  const [draft, setDraft] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  // Re-seed the draft when the dialog opens or the project document changes
  // underneath us. Adjusting state during render is React's documented pattern
  // and avoids the cascading render an effect would cause.
  const serialized = JSON.stringify(settings?.project ?? {}, null, 2);
  const seed = `${open}:${serialized}`;
  const [seeded, setSeeded] = useState(seed);
  if (seeded !== seed) {
    setSeeded(seed);
    setDraft(serialized);
    setError(null);
  }

  useEffect(() => {
    if (!open) return;
    void loadSettings({ refresh: true });
  }, [open, loadSettings]);

  const save = async (): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "invalid JSON");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("a settings scope must be a JSON object");
      return;
    }
    const ok = await writeRawSettings("project", parsed as Record<string, unknown>);
    if (!ok) {
      setError("Could not save; see the banner above.");
      return;
    }
    await Promise.all([
      inspectProject(project.path),
      loadResources({ refresh: true }),
      applyModelScopeToTabs(),
    ]);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent aria-label="Project settings JSON">
        <DialogTitle>Project settings JSON</DialogTitle>
        <DialogDescription>
          The whole <code className="font-mono">.pi/settings.json</code> document for this project.
          Keys Pi does not document are preserved; a malformed file is never overwritten.
        </DialogDescription>
        <div className="flex flex-col gap-3 px-4 pb-4">
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
          {settingsError ? (
            <p role="alert" className="text-xs text-danger">
              {settingsError}
            </p>
          ) : null}
          <textarea
            aria-label="Project settings JSON"
            data-testid="project-settings-textarea"
            className="min-h-64 w-full resize-y rounded-sm border border-line bg-sunken p-2 font-mono text-xs text-ink outline-none focus:border-accent"
            value={draft}
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={settingsBusy}
              onClick={() => {
                void resetScope("project").then(() => {
                  setDraft("{}");
                  setError(null);
                });
              }}
            >
              Reset
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={settingsBusy} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
