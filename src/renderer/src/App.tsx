import { useEffect, type ReactElement } from "react";
import { CommandPalette } from "./layout/CommandPalette";
import { ProviderLoginDialog } from "./connections/ProviderLoginDialog";
import { PackageConsentDialog } from "./extensions/PackageConsentDialog";
import { TrustDialog } from "./projects/TrustDialog";
import { Sidebar } from "./layout/Sidebar";
import { StatusBar } from "./layout/StatusBar";
import { TabStrip } from "./layout/TabStrip";
import { TitleBar } from "./layout/TitleBar";
import { handleMenuCommand } from "./menu-actions";
import { useAppStore, type AppView } from "./state/app-store";
import { ShortcutDispatcher } from "./shortcuts/ShortcutDispatcher";
import { ShortcutsHelp } from "./shortcuts/ShortcutsHelp";
import { Toaster } from "./ui/toaster";
import { ForkDialog } from "./sessions/ForkDialog";
import { SessionBrowserDialog } from "./sessions/SessionBrowser";
import { SessionTreeDialog } from "./sessions/SessionTree";
import { ConnectionsView } from "./views/ConnectionsView";
import { DiagnosticsView } from "./views/DiagnosticsView";
import { ExtensionsView } from "./views/ExtensionsView";
import { OfficeView } from "./views/OfficeView";
import { SessionView } from "./views/SessionView";
import { SettingsView } from "./views/SettingsView";
import { SkillsView } from "./views/SkillsView";
import { WelcomeView } from "./views/WelcomeView";

/**
 * App shell (plan step 1, IA per D-A4).
 *
 * Regions: title bar, sidebar (projects → sessions, then the product views),
 * session tab strip, the active view, status bar, plus the command palette and
 * the toast host. Global shortcuts belong to the Electron menu (step 1) — the
 * renderer only owns palette-local keys, so nothing fires twice.
 */

const VIEWS: Record<AppView, () => ReactElement> = {
  welcome: WelcomeView,
  session: SessionView,
  settings: SettingsView,
  extensions: ExtensionsView,
  connections: ConnectionsView,
  skills: SkillsView,
  diagnostics: DiagnosticsView,
  office: OfficeView,
};

function prefersLight(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  );
}

export function App() {
  const view = useAppStore((state) => state.view);
  const theme = useAppStore((state) => state.prefs.theme);
  const loadPrefs = useAppStore((state) => state.loadPrefs);
  const loadProjects = useAppStore((state) => state.loadProjects);
  const loadTabs = useAppStore((state) => state.loadTabs);
  const setInfo = useAppStore((state) => state.setInfo);

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
    void loadTabs();
    const offTabs = api.sessions.onTabs((envelope) => useAppStore.getState().applyTabs(envelope));
    const offState = api.sessions.onState((envelope) =>
      useAppStore.getState().applySessionState(envelope),
    );
    const offEvents = api.sessions.onEvent((envelope) =>
      useAppStore.getState().applySessionEvents(envelope),
    );
    return () => {
      cancelled = true;
      offMenu();
      offTabs();
      offState();
      offEvents();
    };
  }, [loadTabs, setInfo]);

  useEffect(() => {
    // The appearance preference paints first paint; once the Pi theme loads,
    // the active Pi theme owns the chrome (plan step 15) and this yields.
    if (useAppStore.getState().themesLoaded) return;
    const resolved = theme === "system" ? (prefersLight() ? "light" : "dark") : theme;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [theme]);

  const View = VIEWS[view];
  const bridgeMissing = typeof window !== "undefined" && !window.pi;

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      {bridgeMissing ? (
        <div className="banner banner--error m-3">
          The preload bridge is unavailable (window.pi is missing), so no command can reach the main
          process. This build is broken — reinstall or run from source.
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
      </div>
      <StatusBar />
      <CommandPalette />
      <SessionBrowserDialog />
      <SessionTreeDialog />
      <ForkDialog />
      <ProviderLoginDialog />
      <PackageConsentDialog />
      <TrustDialog />
      <ShortcutsHelp />
      <ShortcutDispatcher />
      <Toaster theme={theme} />
    </div>
  );
}
