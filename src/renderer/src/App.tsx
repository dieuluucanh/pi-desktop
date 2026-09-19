import { useEffect, useState } from "react";
import type { AppInfo, WindowState } from "../../shared/ipc";
import { OfficeSetupPanel } from "./office/OfficeSetupPanel";

/**
 * App shell.
 *
 * Session tabs, the chat transcript and the settings surfaces are added by later
 * plan steps; this step ships the chrome plus the Office setup wizard panel.
 */

type TabKind = "session" | "office" | "settings";

interface ShellTab {
  id: string;
  title: string;
  kind: TabKind;
}

const SHELL_TABS: readonly ShellTab[] = [
  { id: "session-1", title: "New session", kind: "session" },
  { id: "office", title: "Office", kind: "office" },
  { id: "settings", title: "Settings", kind: "settings" },
];

const NEXT_STEPS: readonly string[] = [
  "Step 4 — Pi host process, supervisor and the real host IPC surface",
  "Step 5 — sessions, settings, project trust and events in the host",
  "Step 6 — extension UI host: dialogs, status, widgets, theme",
];

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(() =>
    window.pi ? null : "The preload bridge is unavailable (window.pi is missing).",
  );
  const [windowState, setWindowState] = useState<WindowState | null>(null);
  const [activeTab, setActiveTab] = useState(SHELL_TABS[0]?.id ?? "session-1");

  useEffect(() => {
    const bridge = window.pi;
    if (!bridge) return;

    let cancelled = false;
    bridge
      .getAppInfo()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });

    const unsubscribe = bridge.onWindowState((state) => setWindowState(state));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar__brand">
          <span
            className="titlebar__dot"
            data-state={windowState?.focused === false ? "idle" : "live"}
          />
          Pi Desktop
        </div>
        <div className="titlebar__meta">{info ? `v${info.version}` : "loading…"}</div>
      </header>

      <nav className="tabs" aria-label="Tabs">
        {SHELL_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className="tabs__tab"
            aria-current={tab.id === activeTab}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className={`tabs__badge tabs__badge--${tab.kind}`}>{tab.kind}</span>
            {tab.title}
          </button>
        ))}
        <span className="tabs__hint">Session tabs and webview tabs arrive in steps 11 and 20</span>
      </nav>

      <main className="content">
        {error ? (
          <section className="card card--error">
            <h2>Could not read app info</h2>
            <p>{error}</p>
          </section>
        ) : null}

        {activeTab === "office" ? <OfficeSetupPanel /> : null}

        {activeTab === "settings" ? (
          <section className="card">
            <h2>Settings</h2>
            <p>
              The full settings mirror (every key in Pi's <code>settings.json</code>) lands in step
              14. The connection settings that exist today are the Office setup wizard.
            </p>
            <button type="button" onClick={() => setActiveTab("office")}>
              Set up Pi for Office
            </button>
          </section>
        ) : null}

        {activeTab === "session-1" ? (
          <>
            <section className="card">
              <h2>Scaffold is running</h2>
              <p>
                The Electron shell, the bundled Node runtime and the Office setup backend are wired.
                Chat, sessions and the extension UI host arrive in the next steps.
              </p>
              <dl className="facts">
                <Fact label="App" value={info ? `${info.name} ${info.version}` : "…"} />
                <Fact
                  label="Electron"
                  value={info ? `${info.electron} (Chromium ${info.chrome})` : "…"}
                />
                <Fact label="App Node" value={info?.node ?? "…"} />
                <Fact label="Platform" value={info ? `${info.platform}/${info.arch}` : "…"} />
                <Fact label="Mode" value={modeLabel(info)} />
                <Fact label="Safe mode" value={info ? String(info.safeMode) : "…"} />
                <Fact
                  label="Pi runtime"
                  value={
                    info
                      ? `${info.runtimeSource ?? "unavailable"}${info.runtimeNodeVersion ? ` · node ${info.runtimeNodeVersion}` : ""}`
                      : "…"
                  }
                />
                <Fact label="Pi profile" value={info?.profileDir ?? "…"} />
                <Fact label="App state" value={info?.appStateFile ?? "…"} />
              </dl>
              {info?.runtimeProblems.length ? (
                <div className="banner banner--warn">{info.runtimeProblems.join(" · ")}</div>
              ) : null}
            </section>

            <section className="card">
              <h2>Next up</h2>
              <ol>
                {NEXT_STEPS.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}

function modeLabel(info: AppInfo | null): string {
  if (!info) return "…";
  return info.isDev ? "development" : "packaged";
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </>
  );
}
