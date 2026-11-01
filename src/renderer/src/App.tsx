import { useEffect, type ReactElement } from "react";
import { CommandPalette } from "./layout/CommandPalette";
import { ProviderLoginDialog } from "./connections/ProviderLoginDialog";
import { PackageConsentDialog } from "./extensions/PackageConsentDialog";
import { PrivacyDialog } from "./privacy/PrivacyDialog";
import { TrustDialog } from "./projects/TrustDialog";
import { Sidebar } from "./layout/Sidebar";
import { ProjectRail } from "./layout/ProjectRail";
import { StatusBar } from "./layout/StatusBar";
import { TabStrip } from "./layout/TabStrip";
import { UpdateBanner } from "./updates/UpdateBanner";
import { handleMenuCommand } from "./menu-actions";
import { useAppStore, type AppView } from "./state/app-store";
import { systemThemeName, watchSystemTheme } from "./themes/system-theme";
import { OnboardingWizard } from "./onboarding/OnboardingWizard";
import { ShortcutDispatcher } from "./shortcuts/ShortcutDispatcher";
import { ShortcutsHelp } from "./shortcuts/ShortcutsHelp";
import { Toaster } from "./ui/toaster";
import { ForkDialog } from "./sessions/ForkDialog";
import { SessionBrowserDialog } from "./sessions/SessionBrowser";
import { SessionTreeDialog } from "./sessions/SessionTree";
import { SessionInfoDialog } from "./sessions/SessionInfoDialog";
import { ImportSessionDialog } from "./sessions/ImportSessionDialog";
import { ChangelogDialog } from "./sessions/ChangelogDialog";
import { ShareDialog } from "./sessions/ShareDialog";
import { ExpandedEditorDialog } from "./sessions/ExpandedEditorDialog";
import { ConnectionsView } from "./views/ConnectionsView";
import { DiagnosticsView } from "./views/DiagnosticsView";
import { ExtensionsView } from "./views/ExtensionsView";
import { SessionView } from "./views/SessionView";
import { WebNavigationDialog } from "./web/WebNavigationDialog";
import { WebUrlDialog } from "./web/WebUrlDialog";
import { GitConsentDialog } from "./rail/GitConsentDialog";
import { MuteNotificationDialog } from "./extension-ui/MuteNotificationDialog";
import { DiffDialog } from "./rail/DiffDialog";
import { SettingsView } from "./views/SettingsView";
import { SkillsView } from "./views/SkillsView";
import { WelcomeView } from "./views/WelcomeView";

/**
 * App shell (plan step 1, IA per D-A4).
 *
 * Regions: sidebar (projects → sessions, then the product views), session tab
 * strip (the topmost app row — the OS frame owns the window controls), the
 * active view, status bar, plus the command palette and the toast host. Global
 * shortcuts belong to the Electron menu (step 1) — the renderer only owns
 * palette-local keys, so nothing fires twice. The update offer is a slim
 * conditional row above the tab strip; it costs no height when there is
 * nothing to do (`UpdateBanner` returns null).
 */

const VIEWS: Record<AppView, () => ReactElement> = {
  welcome: WelcomeView,
  session: SessionView,
  settings: SettingsView,
  extensions: ExtensionsView,
  connections: ConnectionsView,
  skills: SkillsView,
  diagnostics: DiagnosticsView,
};

export function App() {
  const view = useAppStore((state) => state.view);
  const theme = useAppStore((state) => state.prefs.theme);
  const followSystemTheme = useAppStore((state) => state.prefs.followSystemTheme);
  const loadPrefs = useAppStore((state) => state.loadPrefs);
  const loadProjects = useAppStore((state) => state.loadProjects);
  const loadTabs = useAppStore((state) => state.loadTabs);
  const loadThemes = useAppStore((state) => state.loadThemes);
  const loadUpdateState = useAppStore((state) => state.loadUpdateState);
  const prefsLoaded = useAppStore((state) => state.prefsLoaded);
  const privacyAcknowledged = useAppStore((state) => state.prefs.privacyAcknowledged);
  const onboardingCompletedAt = useAppStore((state) => state.prefs.onboardingCompletedAt);
  const setInfo = useAppStore((state) => state.setInfo);
  const safeMode = useAppStore((state) => state.info?.safeMode ?? false);
  const piOffline = useAppStore((state) => state.info?.piOffline ?? false);
  const offlineNotice = useAppStore((state) => state.offlineNotice);
  const clearOffline = useAppStore((state) => state.clearOffline);
  const mainOutdated = useAppStore((state) => state.mainOutdated);
  const relaunchApp = useAppStore((state) => state.relaunchApp);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const staleHostMessage = useAppStore((state) =>
    state.activeTabId ? state.staleHosts[state.activeTabId] : undefined,
  );
  const restartTab = useAppStore((state) => state.restartTab);
  useEffect(() => {
    void loadPrefs();
    void loadProjects();
  }, [loadPrefs, loadProjects]);

  useEffect(() => {
    const api = window.pi;
    if (!api) return;
    let cancelled = false;
    void api
      .getAppInfo()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch(() => undefined);
    const offMenu = api.onMenuCommand((command) => handleMenuCommand(command));
    // Session pushes (plan step 3): the tab table, per-tab state snapshots and
    // the host event batches the transcript will consume in step 5.
    void useAppStore.getState().loadOfficeDocuments();
    // Extension shortcuts (plan step 15) are needed by the composer's Tab mode
    // cycle (2026-10-19), not only by the help dialog. They must be listed
    // *after* the tab table lands, or `resourcesTarget` sees no active session
    // and asks the control host (which has no extension runner). `loadShortcuts`
    // is idempotent and no-ops for the control host.
    void loadTabs().then(() => useAppStore.getState().loadShortcuts());
    // The updater's state (plan step 26): read once, then follow main's pushes
    // so a check started from the menu or the banner updates everywhere.
    void loadUpdateState();
    const offUpdates = api.updates.onState((state) =>
      useAppStore.getState().applyUpdateState(state),
    );
    const offTabs = api.sessions.onTabs((envelope) => useAppStore.getState().applyTabs(envelope));
    const offState = api.sessions.onState((envelope) =>
      useAppStore.getState().applySessionState(envelope),
    );
    const offEvents = api.sessions.onEvent((envelope) =>
      useAppStore.getState().applySessionEvents(envelope),
    );
    // The live Office pane registry (plan step 20): pushed from main's poll so
    // the Documents panel, `#` mentions and office tool cards stay current.
    const offDocuments = api.office.onDocuments((view) =>
      useAppStore.getState().applyOfficeDocuments(view),
    );
    // Source control (git-checkpoint plan step 9) and folder checkpoints (step
    // 21): main pushes a folder's snapshot only when it changed, so one
    // subscription per surface keeps the rail live without polling the renderer.
    const offGit = api.git.onSnapshot((snapshot) =>
      useAppStore.getState().applyGitSnapshot(snapshot),
    );
    const offCheckpoints = api.checkpoints.onState((state) =>
      useAppStore.getState().applyCheckpointState(state),
    );
    // Web tabs (plan step 21): the live state of each native page view, and the
    // navigations main refused because they leave the review.
    const offWebState = api.web.onState((state) => useAppStore.getState().applyWebTabState(state));
    const offWebNav = api.web.onNavigationRequest((request) =>
      useAppStore.setState({ webNavigationPrompt: request }),
    );
    // A renderer promise rejection is captured like a main-process one: it is
    // classified, shown as a hint and recorded for Diagnostics (plan step 22).
    const onRejection = (event: PromiseRejectionEvent): void => {
      event.preventDefault();
      useAppStore.getState().noteFailure(event.reason);
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      cancelled = true;
      offMenu();
      offTabs();
      offState();
      offEvents();
      offDocuments();
      offGit();
      offCheckpoints();
      offWebState();
      offWebNav();
      offUpdates();
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [loadTabs, setInfo, loadUpdateState]);

  useEffect(() => {
    // A laptop that slept, or a window that was hidden, can miss main's tab
    // pushes. Reconcile on the first real interaction with the window, then
    // ensure the active session (which repairs a stopped/stale host).
    const resync = (): void => {
      if (document.visibilityState === "hidden") return;
      void useAppStore.getState().resyncSessions();
      void useAppStore.getState().syncModelScopesFromDisk();
    };
    window.addEventListener("focus", resync);
    document.addEventListener("visibilitychange", resync);
    return () => {
      window.removeEventListener("focus", resync);
      document.removeEventListener("visibilitychange", resync);
    };
  }, []);

  useEffect(() => {
    // The appearance preference paints first paint; once the Pi theme loads,
    // the active Pi theme owns the chrome (plan step 15) and this yields.
    if (useAppStore.getState().themesLoaded) return;
    const resolved = followSystemTheme || theme === "system" ? systemThemeName() : theme;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [theme, followSystemTheme]);

  useEffect(() => {
    // While follow-system is on, the OS appearance re-activates the matching
    // built-in Pi theme (and writes the `theme` setting so terminal Pi agrees).
    if (!followSystemTheme) return;
    return watchSystemTheme(() => {
      void useAppStore.getState().applySystemTheme();
    });
  }, [followSystemTheme]);

  useEffect(() => {
    // Load the active Pi theme as soon as the prefs are known, instead of
    // waiting for a visit to Skills → Themes. Without this the Settings theme
    // picker appeared to do nothing once the catalogue finally loaded
    // (2026-10-30 theme pass). A failure is surfaced by the store and retried
    // from the Themes section.
    if (!prefsLoaded) return;
    void loadThemes();
  }, [prefsLoaded, loadThemes]);

  useEffect(() => {
    // The first-run flow (plan step 26) opens after the privacy screen and only
    // until it is completed; dismissing it leaves the flag unset, so it returns
    // on the next launch rather than silently disappearing.
    if (prefsLoaded && privacyAcknowledged && onboardingCompletedAt === null) {
      useAppStore.getState().startOnboarding();
    }
  }, [prefsLoaded, privacyAcknowledged, onboardingCompletedAt]);

  const View = VIEWS[view];
  const bridgeMissing = typeof window !== "undefined" && !window.pi;

  return (
    <div className="flex h-full flex-col">
      <UpdateBanner />
      {bridgeMissing ? (
        <div className="banner banner--error m-3">
          The preload bridge is unavailable (window.pi is missing), so no command can reach the main
          process. This build is broken — reinstall or run from source.
        </div>
      ) : null}
      {safeMode ? (
        <div className="banner banner--warn m-3" role="status" data-testid="safe-mode-banner">
          Safe mode is on: third-party extensions and packages are not loaded. Restart without
          --safe-mode to restore them.
        </div>
      ) : null}
      {piOffline || offlineNotice ? (
        <div
          className="banner banner--warn m-3 flex items-center justify-between gap-3"
          role="status"
          data-testid="offline-banner"
        >
          <span>
            {piOffline
              ? "PI_OFFLINE is set: Pi will not make startup network calls (model lists, updates and package installs are unavailable)."
              : `This machine looks offline: ${offlineNotice}`}
          </span>
          {offlineNotice ? (
            <button type="button" className="text-xs underline" onClick={clearOffline}>
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}
      {mainOutdated ? (
        <div
          className="banner banner--warn m-3 flex items-center justify-between gap-3"
          role="status"
          data-testid="main-outdated-banner"
        >
          <span>{mainOutdated}</span>
          <button type="button" className="text-xs underline" onClick={() => void relaunchApp()}>
            Restart app
          </button>
        </div>
      ) : null}
      {staleHostMessage && activeTabId ? (
        <div
          className="banner banner--warn m-3 flex items-center justify-between gap-3"
          role="status"
          data-testid="stale-host-banner"
        >
          <span>{staleHostMessage}</span>
          <button
            type="button"
            className="text-xs underline"
            onClick={() => void restartTab(activeTabId)}
          >
            Restart session
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <TabStrip />
          <section className="min-h-0 flex-1 overflow-hidden">
            <View />
          </section>
        </main>
        {/*
          The panel rail is app chrome, not part of a view (2026-10-30
          project-scoped rail plan): it follows the selected project, so a
          project with no open session still shows its source control and
          checkpoints beside Welcome. Product views get the full width.
        */}
        <ProjectRail />
      </div>
      <StatusBar />
      <CommandPalette />
      <SessionBrowserDialog />
      <SessionTreeDialog />
      <SessionInfoDialog />
      <ImportSessionDialog />
      <ChangelogDialog />
      <ShareDialog />
      <ExpandedEditorDialog />
      <ForkDialog />
      <ProviderLoginDialog />
      <PackageConsentDialog />
      <PrivacyDialog />
      <OnboardingWizard />
      <TrustDialog />
      <WebNavigationDialog />
      <WebUrlDialog />
      <GitConsentDialog />
      <DiffDialog />
      <MuteNotificationDialog />
      <ShortcutsHelp />
      <ShortcutDispatcher />
      <Toaster theme={theme} />
    </div>
  );
}
