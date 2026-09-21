import { useCallback, useEffect, useState } from "react";
import type { DiagnosticsExport, Incident } from "../../../shared/diagnostics";
import { formatBytes, formatDuration } from "../../../shared/performance";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useAppStore } from "../state/app-store";

/**
 * Diagnostics (plan step 22): the evidence a support request needs.
 *
 * Everything here is read from the running process — the app/runtime facts, the
 * profile paths, each host's status and log tail, the incidents recorded this
 * run, extension errors, the Office bridge's last probe and the allowlisted
 * environment. The export reuses the Office wizard's `redactSecrets`, so the
 * bundle is safe to paste; the view never renders `auth.json`.
 */

function toneFor(severity: Incident["severity"]): "neutral" | "warn" | "danger" {
  if (severity === "error") return "danger";
  if (severity === "warning") return "warn";
  return "neutral";
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString();
}

export function DiagnosticsView() {
  const info = useAppStore((state) => state.info);
  const snapshot = useAppStore((state) => state.diagnostics);
  const error = useAppStore((state) => state.diagnosticsError);
  const loadDiagnostics = useAppStore((state) => state.loadDiagnostics);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  const copyBundle = useCallback(async () => {
    const api = window.pi;
    if (!api?.diagnostics) return;
    setBusy(true);
    try {
      const bundle: DiagnosticsExport = await api.diagnostics.export();
      await navigator.clipboard?.writeText(bundle.text);
      setNotice(
        `Copied ${bundle.text.length} characters${bundle.redactions > 0 ? ` (${bundle.redactions} secret${bundle.redactions === 1 ? "" : "s"} redacted)` : ""}.`,
      );
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const saveBundle = useCallback(async () => {
    const api = window.pi;
    if (!api?.diagnostics) return;
    setBusy(true);
    try {
      const result = await api.diagnostics.save();
      if (result.ok) setNotice(`Saved to ${result.path}`);
      else if (result.error) setNotice(result.error);
      else setNotice(null);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const facts: readonly [string, string][] = info
    ? [
        ["App", `${info.name} ${info.version}`],
        ["Mode", info.isDev ? "development" : "packaged"],
        ["Electron", `${info.electron} (Chromium ${info.chrome})`],
        ["App node", info.node],
        ["Platform", `${info.platform}/${info.arch}`],
      ]
    : [];

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto px-8 py-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Diagnostics</h1>
          <p className="text-sm text-ink-muted">
            Read from the running process — no cached or guessed values.
          </p>
        </div>
        <div className="toolbar">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void loadDiagnostics()}
          >
            Refresh
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void copyBundle()}>
            Copy bundle
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void saveBundle()}>
            Save bundle…
          </Button>
        </div>
      </header>

      {notice ? (
        <div className="banner banner--info" role="status" data-testid="diagnostics-notice">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="banner banner--error" role="alert">
          {error}
        </div>
      ) : null}

      {snapshot ? (
        <>
          <section className="card flex flex-col gap-3" data-testid="diagnostics-app">
            <h2 className="text-sm font-semibold">This process</h2>
            <div className="flex flex-wrap gap-2">
              {snapshot.safeMode ? <Badge tone="warn">safe mode</Badge> : null}
              {snapshot.environment.PI_OFFLINE ? <Badge tone="warn">PI_OFFLINE</Badge> : null}
              <Badge tone={snapshot.hosts.length > 0 ? "ok" : "neutral"}>
                {snapshot.hosts.length} host{snapshot.hosts.length === 1 ? "" : "s"}
              </Badge>
              <Badge tone={snapshot.incidents.length > 0 ? "warn" : "neutral"}>
                {snapshot.incidents.length} incident{snapshot.incidents.length === 1 ? "" : "s"}
              </Badge>
            </div>
            <dl className="facts">
              {facts.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt>{label}</dt>
                  <dd title={value}>{value}</dd>
                </div>
              ))}
              <div className="contents">
                <dt>Pi runtime</dt>
                <dd>{snapshot.runtime.source ?? "unavailable"}</dd>
              </div>
              <div className="contents">
                <dt>Runtime node</dt>
                <dd>{snapshot.runtime.nodeVersion ?? "unavailable"}</dd>
              </div>
              <div className="contents">
                <dt>Pi profile</dt>
                <dd title={snapshot.paths.profileDir}>{snapshot.paths.profileDir}</dd>
              </div>
              <div className="contents">
                <dt>Logs</dt>
                <dd title={snapshot.paths.logsDir}>{snapshot.paths.logsDir}</dd>
              </div>
            </dl>
            {snapshot.runtime.problems.length ? (
              <div className="banner banner--warn">{snapshot.runtime.problems.join(" · ")}</div>
            ) : null}
            <div className="toolbar">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void window.pi?.revealPath(snapshot.paths.logsDir)}
              >
                Reveal logs folder
              </Button>
            </div>
          </section>

          <section className="card flex flex-col gap-3" data-testid="diagnostics-startup">
            <h2 className="text-sm font-semibold">Startup</h2>
            <p className="text-xs text-ink-muted">
              Measured from process start; the budgets are the plan's targets (window interactive{" "}
              {formatDuration(snapshot.startup.windowInteractive.budgetMs)}, warm session{" "}
              {formatDuration(snapshot.startup.sessionReady.budgetMs)}).
            </p>
            <dl className="facts">
              <div className="contents">
                <dt>App ready</dt>
                <dd>{formatDuration(snapshot.startup.appReadyMs)}</dd>
              </div>
              <div className="contents">
                <dt>Window interactive</dt>
                <dd>
                  <Badge tone={snapshot.startup.windowInteractive.status === "met" ? "ok" : "warn"}>
                    {formatDuration(snapshot.startup.windowInteractiveMs)}
                  </Badge>
                </dd>
              </div>
              <div className="contents">
                <dt>Warm session ready</dt>
                <dd>
                  <Badge tone={snapshot.startup.sessionReady.status === "met" ? "ok" : "warn"}>
                    {formatDuration(snapshot.startup.sessionReadyMs)}
                  </Badge>
                </dd>
              </div>
            </dl>
          </section>

          <section className="card flex flex-col gap-3" data-testid="diagnostics-hosts">
            <h2 className="text-sm font-semibold">Hosts</h2>
            <p className="text-xs text-ink-muted">
              {snapshot.capacity.hosts.used}/{snapshot.capacity.hosts.limit} hosts ·{" "}
              {snapshot.capacity.tabs.used}/{snapshot.capacity.tabs.limit} tabs · per-host budget{" "}
              {formatBytes(snapshot.memory.budgetBytes)} (recycle at{" "}
              {formatBytes(snapshot.memory.restartBytes)})
            </p>
            {snapshot.hosts.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No host process is running. Open a session to start one.
              </p>
            ) : (
              snapshot.hosts.map((host) => (
                <div key={host.tabId} className="flex flex-col gap-1 border-t border-line pt-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={host.status === "ready" ? "ok" : "warn"}>{host.status}</Badge>
                    <span className="text-xs text-ink-muted">
                      {host.role} · {host.tabId}
                      {host.pid !== null ? ` · pid ${host.pid}` : ""}
                      {host.officeHost ? " · office" : ""}
                    </span>
                    {host.rssBytes !== null ? (
                      <Badge
                        tone={host.rssBytes > snapshot.memory.budgetBytes ? "warn" : "neutral"}
                      >
                        RSS {formatBytes(host.rssBytes)}
                      </Badge>
                    ) : null}
                  </div>
                  <span className="truncate text-xs text-ink-muted" title={host.cwd}>
                    {host.cwd}
                  </span>
                  {host.logLines.length > 0 ? (
                    <pre className="max-h-40 overflow-auto rounded bg-surface-sunken p-2 text-[11px] leading-4">
                      {host.logLines.slice(-12).join("")}
                    </pre>
                  ) : null}
                </div>
              ))
            )}
          </section>

          <section className="card flex flex-col gap-3" data-testid="diagnostics-incidents">
            <h2 className="text-sm font-semibold">Incidents</h2>
            {snapshot.incidents.length === 0 ? (
              <p className="text-sm text-ink-muted">Nothing has failed this run.</p>
            ) : (
              snapshot.incidents.map((incident) => (
                <div key={incident.id} className="flex flex-col gap-1 border-t border-line pt-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={toneFor(incident.severity)}>{incident.kind}</Badge>
                    <span className="text-xs text-ink-muted">{formatTime(incident.at)}</span>
                    {incident.tabId ? (
                      <span className="text-xs text-ink-muted">· {incident.tabId}</span>
                    ) : null}
                  </div>
                  <span className="text-sm">{incident.message}</span>
                  {incident.fix ? (
                    <span className="text-xs text-ink-muted">{incident.fix}</span>
                  ) : null}
                </div>
              ))
            )}
          </section>

          {snapshot.extensionErrors.length > 0 ? (
            <section
              className="card flex flex-col gap-3"
              data-testid="diagnostics-extension-errors"
            >
              <h2 className="text-sm font-semibold">Extension errors</h2>
              {snapshot.extensionErrors.map((entry) => (
                <div
                  key={`${entry.tabId}-${entry.at}-${entry.message}`}
                  className="flex flex-col gap-1 border-t border-line pt-2"
                >
                  <span className="text-xs text-ink-muted">
                    {entry.extensionId ?? "unknown extension"} · {entry.tabId}
                  </span>
                  <span className="text-sm">{entry.message}</span>
                </div>
              ))}
            </section>
          ) : null}

          <section className="card flex flex-col gap-3" data-testid="diagnostics-office">
            <h2 className="text-sm font-semibold">Office bridge</h2>
            <dl className="facts">
              <div className="contents">
                <dt>Status</dt>
                <dd>{snapshot.office.available ? snapshot.office.status : "not running"}</dd>
              </div>
              <div className="contents">
                <dt>Port</dt>
                <dd>{snapshot.office.port}</dd>
              </div>
              <div className="contents">
                <dt>Protocol</dt>
                <dd>{snapshot.office.protocolVersion ?? "unknown"}</dd>
              </div>
              <div className="contents">
                <dt>Attached panes</dt>
                <dd>{snapshot.office.panes}</dd>
              </div>
            </dl>
            {snapshot.office.error ? (
              <div className="banner banner--warn">{snapshot.office.error}</div>
            ) : null}
          </section>

          <section className="card flex flex-col gap-3" data-testid="diagnostics-environment">
            <h2 className="text-sm font-semibold">Environment</h2>
            {Object.keys(snapshot.environment).length === 0 ? (
              <p className="text-sm text-ink-muted">None of the allowlisted variables are set.</p>
            ) : (
              <dl className="facts">
                {Object.entries(snapshot.environment).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt>{key}</dt>
                    <dd title={value}>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        </>
      ) : (
        <p className="text-sm text-ink-muted">Reading diagnostics…</p>
      )}
    </div>
  );
}
