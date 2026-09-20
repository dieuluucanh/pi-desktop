import { useEffect } from "react";
import { FolderOpen, MessageSquarePlus, Plug } from "lucide-react";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { openProjectAction, newSessionAction } from "../menu-actions";
import { useAppStore } from "../state/app-store";

/**
 * Welcome view (plan step 1): what the app is, and the two things a user can do
 * from an empty state. Shown whenever no project is open.
 */

export function WelcomeView() {
  const info = useAppStore((state) => state.info);
  const providers = useAppStore((state) => state.providers);
  const providersLoaded = useAppStore((state) => state.providersLoaded);
  const loadProviders = useAppStore((state) => state.loadProviders);
  const setView = useAppStore((state) => state.setView);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const needsSignIn =
    providersLoaded && providers.length > 0 && !providers.some((provider) => provider.configured);

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col justify-center gap-6 px-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Pi Desktop</h1>
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
        <Button variant="secondary" onClick={newSessionAction}>
          <MessageSquarePlus className="size-4" aria-hidden />
          New session
        </Button>
      </div>

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

      {info ? (
        <p className="text-[11px] text-ink-faint">
          profile {info.profileDir} · runtime {info.runtimeSource ?? "unavailable"}
          {info.runtimeNodeVersion ? ` (node ${info.runtimeNodeVersion})` : ""}
        </p>
      ) : null}
    </div>
  );
}
