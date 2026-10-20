import { useEffect, useState } from "react";
import {
  Clock,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Home,
  MessageSquarePlus,
  Plug,
} from "lucide-react";
import markUrl from "../../../../assets/pi-desktop-icon.svg";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { openProjectAction, newSessionAction } from "../menu-actions";
import { useAppStore } from "../state/app-store";
import { CloneProjectDialog, CreateProjectDialog } from "../projects/ProjectDialogs";

/**
 * Welcome view (plan step 1, projects in step 10): what the app is, the ways to
 * get a project, the recent projects, and the first-run sign-in prompt.
 */

export function WelcomeView() {
  const info = useAppStore((state) => state.info);
  const providers = useAppStore((state) => state.providers);
  const providersLoaded = useAppStore((state) => state.providersLoaded);
  const loadProviders = useAppStore((state) => state.loadProviders);
  const projects = useAppStore((state) => state.projects);
  const openProject = useAppStore((state) => state.openProject);
  const quickSessionInHome = useAppStore((state) => state.quickSessionInHome);
  const setView = useAppStore((state) => state.setView);
  const [createOpen, setCreateOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const needsSignIn =
    providersLoaded && providers.length > 0 && !providers.some((provider) => provider.configured);

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col justify-center gap-6 overflow-y-auto px-8 py-8">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <img src={markUrl} alt="" aria-hidden className="size-10" />
          <h1 className="text-xl font-semibold">Pi Desktop</h1>
        </div>
        <p className="text-sm text-ink-muted">
          The desktop UI for the Pi coding agent. Open a project folder and a session runs there
          with the same profile, models, extensions and settings as the{" "}
          <code className="font-mono text-xs">pi</code> command in your terminal.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => void openProjectAction()}>
          <FolderOpen className="size-4" aria-hidden />
          Open project folder…
        </Button>
        <Button variant="secondary" onClick={() => setCreateOpen(true)}>
          <FolderPlus className="size-4" aria-hidden />
          Create blank project…
        </Button>
        <Button variant="secondary" onClick={() => setCloneOpen(true)}>
          <GitBranch className="size-4" aria-hidden />
          Clone repository…
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={newSessionAction}>
          <MessageSquarePlus className="size-4" aria-hidden />
          New session
        </Button>
        <Button variant="ghost" onClick={() => void quickSessionInHome()} title={info?.homeDir}>
          <Home className="size-4" aria-hidden />
          Quick session in home
        </Button>
      </div>

      {projects.length > 0 ? (
        <section className="flex flex-col gap-1" data-testid="recent-projects">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Recent projects
          </h2>
          <ul className="flex flex-col gap-1">
            {projects.slice(0, 6).map((project) => (
              <li key={project.path}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm border border-line bg-raised/60 px-2 py-1.5 text-left text-sm hover:border-line-strong"
                  onClick={() => void openProject(project.path)}
                  title={project.path}
                >
                  <Clock className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="max-w-64 truncate font-mono text-[11px] text-ink-faint">
                    {project.path}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {needsSignIn ? (
        <section
          className="card flex items-center justify-between gap-4"
          data-testid="welcome-signin"
        >
          <div>
            <h2 className="text-sm font-semibold">Connect a provider</h2>
            <p className="text-xs text-ink-muted">
              No provider is signed in yet. Add a subscription or an API key — it is stored in the
              shared Pi profile, so terminal Pi sees it too.
            </p>
          </div>
          <Button variant="primary" onClick={() => setView("connections")}>
            <Plug className="size-4" aria-hidden />
            Open Connections
          </Button>
        </section>
      ) : null}

      <ul className="flex flex-col gap-2 text-sm text-ink-muted">
        <li>
          Sessions are stored as JSONL in the shared Pi profile — interchangeable with terminal Pi.
        </li>
        <li>Extensions, skills, themes and keybindings load exactly as they do in the terminal.</li>
        <li>
          Pi for Office is an optional integration; nothing Office-related runs unless you set it
          up.
        </li>
      </ul>

      <div className="flex flex-wrap items-center gap-4 border-t border-line pt-4 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd> command palette
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>Ctrl</Kbd>
          <Kbd>N</Kbd> new session
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>Ctrl</Kbd>
          <Kbd>/</Kbd> shortcuts
        </span>
      </div>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
      <CloneProjectDialog open={cloneOpen} onOpenChange={setCloneOpen} />
    </div>
  );
}
