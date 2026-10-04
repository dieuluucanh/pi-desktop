import { useEffect, useState, type ReactNode } from "react";
import { Check, FolderOpen, FolderPlus, Home, Mail } from "lucide-react";
import markUrl from "../../../../assets/pi-desktop-icon.svg";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import {
  onboardingProgress,
  onboardingStepTitle,
  type OnboardingStep,
} from "../../../shared/onboarding";
import { isRecommendedInstalled, RECOMMENDED_PACKAGES } from "../../../shared/recommended-packages";
import type { ProfileMode } from "../../../shared/profile";
import { canAddKey, canSignIn, statusLabel, statusTone } from "../connections/provider-groups";
import type { ProviderSummary } from "../../../shared/providers";
import { openProjectAction } from "../menu-actions";
import { CreateProjectDialog } from "../projects/ProjectDialogs";
import { useAppStore } from "../state/app-store";

/**
 * First-run onboarding (plan step 26).
 *
 * A guided path from "what is this" to a working session: profile choice, a
 * provider, a project, the optional recommended extensions and the optional
 * Office integration. Every step reuses the app's existing flows rather than
 * duplicating them (the folder picker, Connections' sign-in, the package consent
 * dialog, the Integrations card), so the wizard is a guide, not a second
 * implementation.
 *
 * Dismissing it without finishing leaves `onboardingCompletedAt` unset, so it is
 * offered again next launch; "Skip setup" marks it done for good.
 */
export function OnboardingWizard() {
  const step = useAppStore((state) => state.onboardingStep);
  const nextOnboarding = useAppStore((state) => state.nextOnboarding);
  const previousOnboarding = useAppStore((state) => state.previousOnboarding);
  const completeOnboarding = useAppStore((state) => state.completeOnboarding);

  if (!step) return null;
  const { index, total } = onboardingProgress(step);
  const progress = ONBOARDING_PROGRESS(step);

  const finish = async (): Promise<void> => {
    await completeOnboarding();
    const { project, createSessionTab, setView } = useAppStore.getState();
    if (project) {
      void createSessionTab();
    } else {
      setView("welcome");
    }
  };

  return (
    <Dialog open>
      <DialogContent
        aria-label="Set up Pi Desktop"
        className="max-w-2xl"
        data-testid="onboarding-wizard"
      >
        <DialogTitle className="px-4 pt-4">{onboardingStepTitle(step)}</DialogTitle>
        <DialogDescription className="px-4">
          Step {index} of {total}
        </DialogDescription>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-4" data-testid="onboarding-body">
          {step === "welcome" ? <WelcomeStep /> : null}
          {step === "profile" ? <ProfileStep /> : null}
          {step === "provider" ? <ProviderStep /> : null}
          {step === "project" ? <ProjectStep /> : null}
          {step === "extensions" ? <ExtensionsStep /> : null}
          {step === "office" ? <OfficeStep /> : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
          <Button variant="ghost" size="sm" onClick={() => void completeOnboarding()}>
            Skip setup
          </Button>
          <div className="flex items-center gap-2">
            {progress.previous ? (
              <Button variant="ghost" size="sm" onClick={previousOnboarding}>
                Back
              </Button>
            ) : null}
            {progress.next ? (
              <Button variant="primary" size="sm" onClick={nextOnboarding}>
                Next
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void finish()}
                data-testid="onboarding-finish"
              >
                Finish
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Navigation facts derived once, so the footer stays declarative. */
function ONBOARDING_PROGRESS(step: OnboardingStep): { previous: boolean; next: boolean } {
  const { index, total } = onboardingProgress(step);
  return { previous: index > 1, next: index < total };
}

function WelcomeStep() {
  return (
    <div className="flex flex-col gap-3 text-sm text-ink-muted">
      {/* Below the dialog's own title, which names the step (plan step 28). */}
      <img src={markUrl} alt="" aria-hidden className="size-8" />
      <p>
        Pi Desktop is the graphical client for the Pi coding agent. It uses the same Pi profile as
        terminal Pi, so projects, sessions, credentials, extensions and settings are shared.
      </p>
      <ul className="flex flex-col gap-1.5">
        <li>• Open a project folder and chat with the model in a session.</li>
        <li>• Attach files with @, images by pasting, documents with #.</li>
        <li>• Install extensions and packages exactly as you would with the pi CLI.</li>
        <li>• Pi for Office is optional; nothing Office-related runs unless you set it up.</li>
      </ul>
    </div>
  );
}

function ProfileStep() {
  const profileMode = useAppStore((state) => state.prefs.profileMode);
  const profileDir = useAppStore((state) => state.info?.profileDir ?? null);
  const chooseProfileMode = useAppStore((state) => state.chooseProfileMode);
  const relaunchApp = useAppStore((state) => state.relaunchApp);
  const [restartNeeded, setRestartNeeded] = useState(false);

  const select = async (mode: ProfileMode): Promise<void> => {
    const needed = await chooseProfileMode(mode);
    setRestartNeeded(needed);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        Choose where Pi Desktop keeps sessions and configuration. You can change this later in
        Settings.
      </p>
      <ProfileChoice
        mode="shared"
        active={profileMode === "shared"}
        title="Share the profile with terminal Pi"
        description="Recommended: ~/.pi/agent — terminal Pi and the app see the same sessions, credentials and extensions."
        onSelect={() => void select("shared")}
      />
      <ProfileChoice
        mode="app"
        active={profileMode === "app"}
        title="Use a separate profile for Pi Desktop"
        description="Keeps the app's sessions and settings apart from terminal Pi. The app creates the folder under its own data directory."
        onSelect={() => void select("app")}
      />
      {profileDir ? (
        <p className="font-mono text-[11px] text-ink-faint">
          Active profile: {profileDir}
          {restartNeeded ? " (after a restart)" : ""}
        </p>
      ) : null}
      {restartNeeded ? (
        <div
          className="flex items-center justify-between gap-3 rounded-sm border border-warn/50 bg-raised px-3 py-2"
          role="status"
          data-testid="onboarding-restart"
        >
          <span className="text-xs text-ink-muted">
            The running app still uses the old profile. Restart to apply the change.
          </span>
          <Button size="sm" variant="primary" onClick={() => void relaunchApp()}>
            Restart now
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ProfileChoice({
  mode,
  active,
  title,
  description,
  onSelect,
}: {
  mode: ProfileMode;
  active: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={`flex items-start gap-3 rounded-sm border px-3 py-2.5 text-left ${
        active ? "border-accent/60 bg-raised" : "border-line"
      }`}
      data-testid={`profile-choice-${mode}`}
    >
      <span className="mt-0.5 text-accent">{active ? <Check className="size-4" /> : null}</span>
      <span className="min-w-0">
        <span className="block text-sm text-ink">{title}</span>
        <span className="block text-xs text-ink-muted">{description}</span>
      </span>
    </button>
  );
}

function ProviderStep() {
  const providers = useAppStore((state) => state.providers);
  const providersLoaded = useAppStore((state) => state.providersLoaded);
  const loadProviders = useAppStore((state) => state.loadProviders);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const configured = providers.filter((provider) => provider.configured);
  const ordered = [...providers].sort((a, b) => Number(b.configured) - Number(a.configured));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        {configured.length > 0
          ? `Connected: ${configured.map((provider) => provider.label).join(", ")}. You can add another provider now or later.`
          : "Connect at least one provider — a subscription sign-in or an API key. Credentials are stored by Pi in the shared profile."}
      </p>
      {!providersLoaded ? (
        <p className="text-xs text-ink-faint">Loading providers…</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="onboarding-providers">
          {ordered.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProviderRow({ provider }: { provider: ProviderSummary }) {
  const setProviderKey = useAppStore((state) => state.setProviderKey);
  const startProviderLogin = useAppStore((state) => state.startProviderLogin);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submitKey = async (): Promise<void> => {
    if (key.length === 0) return;
    setBusy(true);
    setFormError(null);
    try {
      await setProviderKey(provider.id, key);
      setKey("");
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 rounded-sm border border-line px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-ink">
          {provider.label}
          <Badge tone={statusTone(provider)}>{statusLabel(provider)}</Badge>
        </span>
        {canSignIn(provider) && !provider.configured ? (
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => void startProviderLogin(provider.id)}
          >
            Sign in
          </Button>
        ) : null}
      </div>
      {canAddKey(provider) && !provider.configured ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitKey();
          }}
        >
          <input
            type="password"
            aria-label={`API key for ${provider.label}`}
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="Paste the API key — it is never shown again"
            className="min-w-0 flex-1 rounded-sm border border-line bg-transparent px-2 py-1 text-xs text-ink outline-none"
          />
          <Button size="sm" type="submit" disabled={busy || key.length === 0}>
            Save key
          </Button>
        </form>
      ) : null}
      {formError ? (
        <p className="text-xs text-danger" role="alert">
          {formError}
        </p>
      ) : null}
    </li>
  );
}

function ProjectStep() {
  const project = useAppStore((state) => state.project);
  const quickSessionInHome = useAppStore((state) => state.quickSessionInHome);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        {project
          ? `Open project: ${project.name}`
          : "Pick the folder the session should run in. Pi reads AGENTS.md, .pi/ configuration and skills from there."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" onClick={() => void openProjectAction()}>
          <FolderOpen className="size-3.5" aria-hidden />
          Open project folder…
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
          <FolderPlus className="size-3.5" aria-hidden />
          Create blank project…
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void quickSessionInHome()}>
          <Home className="size-3.5" aria-hidden />
          Quick session in home
        </Button>
      </div>
      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function ExtensionsStep() {
  const settings = useAppStore((state) => state.settings);
  const loadSettings = useAppStore((state) => state.loadSettings);
  const packagesBusy = useAppStore((state) => state.packagesBusy);
  const installRecommendedPackage = useAppStore((state) => state.installRecommendedPackage);
  const setView = useAppStore((state) => state.setView);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const installedScopes = settings ?? { global: {}, project: {} };
  const sourcesOf = (document: Record<string, unknown>): string[] => {
    const value = document.packages;
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  };
  const installed = [...sourcesOf(installedScopes.global), ...sourcesOf(installedScopes.project)];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        A short, reviewed list. Installing runs the package manager with the source shown here;
        nothing installs silently, and you can skip this.
      </p>
      <ul className="flex flex-col gap-2" data-testid="onboarding-recommended">
        {RECOMMENDED_PACKAGES.map((entry) => {
          const already = isRecommendedInstalled(entry, installed);
          return (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-3 rounded-sm border border-line px-3 py-2"
            >
              <div className="min-w-0">
                <span className="block truncate text-xs font-medium text-ink">{entry.name}</span>
                <span className="block text-xs text-ink-muted">{entry.description}</span>
              </div>
              {already ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-ok">
                  <Check className="size-3" aria-hidden /> Installed
                </span>
              ) : (
                <Button
                  size="sm"
                  disabled={packagesBusy}
                  onClick={() => installRecommendedPackage(entry)}
                >
                  Install
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <Button variant="ghost" size="sm" onClick={() => setView("extensions")}>
        Open the Extensions hub
      </Button>
    </div>
  );
}

function OfficeStep() {
  const focusIntegrations = useAppStore((state) => state.focusIntegrations);
  const setView = useAppStore((state) => state.setView);
  const completeOnboarding = useAppStore((state) => state.completeOnboarding);
  const newSession = useAppStore((state) => state.createSessionTab);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        Pi for Office connects Word, Excel and PowerPoint documents to a session. It is an optional
        integration, installed like any other extension — the app works fully without it.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void completeOnboarding();
            focusIntegrations();
            setView("extensions");
          }}
        >
          <Mail className="size-3.5" aria-hidden />
          Open Integrations
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            void completeOnboarding();
            void newSession();
          }}
          data-testid="onboarding-start-session"
        >
          Start a session
        </Button>
      </div>
      <p className="text-xs text-ink-faint">
        Finish when you are ready — you can set Office up later from Extensions → Integrations.
      </p>
    </div>
  );
}
