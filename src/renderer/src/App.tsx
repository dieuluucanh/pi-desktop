import { useEffect, useState } from "react";
import type { AppInfo, WindowState } from "../../shared/ipc";

/**
 * App shell.
 *
 * This step deliberately ships only the chrome: window/tab frame, the app-info
 * panel and the preload bridge wiring. Session tabs, the chat transcript, the
 * Office wizard panel and the settings surfaces are added by later plan steps.
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
  "Step 2 — bundle the pinned Node 24 + npm runtime with pi/npm PATH shims",
  "Step 3 — Office setup wizard panel on top of the finished backend",
  "Step 4 — Pi host process, supervisor and the real IPC surface",
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

  const active = SHELL_TABS.find((tab) => tab.id === activeTab) ?? SHELL_TABS[0];

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

        <section className="card">
          <h2>Scaffold is running</h2>
          <p>
            The Electron shell, the allowlisted IPC surface and the build pipeline work. Everything
            below comes from the main process over <code>window.pi</code>.
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
            <Fact label="Pi profile" value={info?.profileDir ?? "…"} />
            <Fact label="App state" value={info?.appStateFile ?? "…"} />
          </dl>
        </section>

        <section className="card">
          <h2>Already implemented</h2>
          <ul>
            <li>
              Office setup backend: detection, bridge install, sideload, verify, troubleshooting
              (151 tests).
            </li>
            <li>
              Pi-compatible package plumbing: source parsing, atomic settings writes, npm root.
            </li>
            <li>
              Bundled Pi SDK 0.85.1, typed preload bridge, strict TS, ESLint/Prettier, CI on three
              platforms.
            </li>
          </ul>
        </section>

        <section className="card">
          <h2>Next up</h2>
          <ol>
            {NEXT_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="muted">
            Active tab: {active ? `${active.title} (${active.kind})` : "none"}
          </p>
        </section>
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
