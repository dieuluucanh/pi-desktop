import { Button } from "../ui/button";
import { useAppStore } from "../state/app-store";

/**
 * Diagnostics (plan step 1): real, verifiable facts about this process, the
 * bundled runtime and the paths the app writes to. Step 22 adds host logs,
 * extension errors, the Office bridge status and a redacted export bundle.
 */

export function DiagnosticsView() {
  const info = useAppStore((state) => state.info);

  const facts: readonly [string, string][] = info
    ? [
        ["App", `${info.name} ${info.version}`],
        ["Mode", info.isDev ? "development" : "packaged"],
        ["Safe mode", String(info.safeMode)],
        ["Electron", `${info.electron} (Chromium ${info.chrome})`],
        ["App node", info.node],
        ["Platform", `${info.platform}/${info.arch}`],
        ["Pi runtime", info.runtimeSource ?? "unavailable"],
        ["Runtime node", info.runtimeNodeVersion ?? "unavailable"],
        ["Pi profile", info.profileDir],
        ["settings.json", info.settingsFile],
        ["auth.json", info.authFile],
        ["models.json", info.modelsFile],
        ["App state", info.appStateFile],
        ["Logs", info.logsDir],
        ["Blob cache", info.blobCacheDir],
      ]
    : [];

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto px-8 py-6">
      <header>
        <h1 className="text-lg font-semibold">Diagnostics</h1>
        <p className="text-sm text-ink-muted">
          Everything below is read from the running process — no cached or guessed values.
        </p>
      </header>

      {info ? (
        <section className="card flex flex-col gap-3">
          <dl className="facts">
            {facts.map(([label, value]) => (
              <div key={label} className="contents">
                <dt>{label}</dt>
                <dd title={value}>{value}</dd>
              </div>
            ))}
          </dl>
          {info.runtimeProblems.length ? (
            <div className="banner banner--warn">{info.runtimeProblems.join(" · ")}</div>
          ) : null}
          <div className="toolbar">
            <Button size="sm" onClick={() => void window.pi?.revealPath(info.logsDir)}>
              Reveal logs folder
            </Button>
            <Button size="sm" onClick={() => void window.pi?.revealPath(info.appStateFile)}>
              Reveal app state
            </Button>
          </div>
        </section>
      ) : (
        <p className="text-sm text-ink-muted">Waiting for app info…</p>
      )}
    </div>
  );
}
