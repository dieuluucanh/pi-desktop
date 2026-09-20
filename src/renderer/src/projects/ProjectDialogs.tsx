import { useState } from "react";
import { FolderOpen, GitBranch, Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { useAppStore } from "../state/app-store";

/**
 * Create-blank and clone dialogs (plan step 10).
 *
 * Both start a session in the new project when they succeed, which is what the
 * welcome flow promises: "create a project" and "start working in it" are one
 * gesture, not two. A failure stays in the dialog with the reason instead of
 * closing and leaving a toast behind.
 */

export function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const home = useAppStore((state) => state.info?.homeDir ?? "");
  const createBlankProject = useAppStore((state) => state.createBlankProject);
  const createSessionTab = useAppStore((state) => state.createSessionTab);
  const [parentDir, setParentDir] = useState(home);
  const [name, setName] = useState("");
  const [gitInit, setGitInit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseParent = async (): Promise<void> => {
    const picked = await window.pi?.pickDirectory();
    if (picked) setParentDir(picked);
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const ok = await createBlankProject({ parentDir, name, gitInit });
    setBusy(false);
    if (!ok) {
      setError(useAppStore.getState().hint ?? "the project could not be created");
      return;
    }
    onOpenChange(false);
    setName("");
    await createSessionTab();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="Create blank project" className="max-w-lg">
        <DialogTitle>Create a blank project</DialogTitle>
        <DialogDescription>
          A new folder is created for the project. Pi runs there exactly as it does in a folder you
          already have — nothing is sandboxed, and it can read or write outside the folder.
        </DialogDescription>

        <div className="flex flex-col gap-3 px-4 py-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Folder</span>
            <span className="flex items-center gap-2">
              <input
                value={parentDir}
                onChange={(event) => setParentDir(event.target.value)}
                aria-label="Parent folder"
                className="min-w-0 flex-1 rounded-sm border border-line bg-raised px-2 py-1 font-mono text-xs text-ink outline-none"
              />
              <Button size="sm" variant="secondary" onClick={() => void chooseParent()}>
                <FolderOpen className="size-3.5" aria-hidden />
                Choose…
              </Button>
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Project name</span>
            <input
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && name.trim().length > 0) void submit();
              }}
              placeholder="my-project"
              aria-label="Project name"
              className="rounded-sm border border-line bg-raised px-2 py-1 text-sm text-ink outline-none"
            />
          </label>

          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={gitInit}
              onChange={(event) => setGitInit(event.target.checked)}
              aria-label="Initialise a git repository"
            />
            <GitBranch className="size-3.5" aria-hidden />
            Initialise a git repository
          </label>

          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || name.trim().length === 0 || parentDir.trim().length === 0}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Create &amp; start a session
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CloneProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const home = useAppStore((state) => state.info?.homeDir ?? "");
  const cloneProject = useAppStore((state) => state.cloneProject);
  const createSessionTab = useAppStore((state) => state.createSessionTab);
  const [parentDir, setParentDir] = useState(home);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseParent = async (): Promise<void> => {
    const picked = await window.pi?.pickDirectory();
    if (picked) setParentDir(picked);
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const ok = await cloneProject({ parentDir, url });
    setBusy(false);
    if (!ok) {
      setError(useAppStore.getState().hint ?? "the repository could not be cloned");
      return;
    }
    onOpenChange(false);
    setUrl("");
    await createSessionTab();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="Clone repository" className="max-w-lg">
        <DialogTitle>Clone a repository</DialogTitle>
        <DialogDescription>
          Cloned with the <code className="font-mono text-xs">git</code> on your PATH. The folder
          name defaults to the repository name.
        </DialogDescription>

        <div className="flex flex-col gap-3 px-4 py-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Repository URL</span>
            <input
              value={url}
              autoFocus
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && url.trim().length > 0) void submit();
              }}
              placeholder="https://github.com/user/repo.git"
              aria-label="Repository URL"
              className="rounded-sm border border-line bg-raised px-2 py-1 font-mono text-xs text-ink outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Destination folder</span>
            <span className="flex items-center gap-2">
              <input
                value={parentDir}
                onChange={(event) => setParentDir(event.target.value)}
                aria-label="Destination folder"
                className="min-w-0 flex-1 rounded-sm border border-line bg-raised px-2 py-1 font-mono text-xs text-ink outline-none"
              />
              <Button size="sm" variant="secondary" onClick={() => void chooseParent()}>
                <FolderOpen className="size-3.5" aria-hidden />
                Choose…
              </Button>
            </span>
          </label>

          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || url.trim().length === 0 || parentDir.trim().length === 0}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Clone &amp; start a session
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
