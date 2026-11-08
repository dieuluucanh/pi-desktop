import { useCallback, useEffect, useState } from "react";
import type { DiagnosticsExport, DiagnosticsHostInfo, Incident } from "../../../shared/diagnostics";
import { formatBytes, formatDuration } from "../../../shared/performance";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { copyText } from "../ui/clipboard";
import { useAppStore } from "../state/app-store";
import { ViewShell } from "./ViewShell";

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

/**
 * Boot and last-open timing for one host (2026-11-07 host-singleton plan).
 *
 * A session open is the slowest routine operation in the app, and it used to be
 * visible only once it crossed the 2 s slow-request threshold. Showing `boot`
 * (spawn → hello) separately from `open` (create/resume) is what tells a slow
 * cold start apart from a slow extension stack.
 */
function hostTiming(host: DiagnosticsHostInfo): string {
  const parts: string[] = [];
  if (typeof host.bootMs === "number") parts.push(`boot ${formatDuration(host.bootMs)}`);
  if (host.lastOpen) {
    const open = host.lastOpen;
    parts.push(
      `open ${formatDuration(open.totalMs)} (services ${formatDuration(open.servicesMs)}, bind ${formatDuration(open.bindMs)})`,
    );
  }
  return parts.join(" · ");
}

export function DiagnosticsView() {
  const info = useAppStore((state) => state.info);
  const prefs = useAppStore((state) => state.prefs);
  const snapshot = useAppStore((state) => state.diagnostics);
  const error = useAppStore((state) => state.diagnosticsError);
  const loadDiagnostics = useAppStore((state) => state.loadDiagnostics);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  // A profile switch is resolved at launch (plan step 8): until the app is
  // relaunched, the running hosts keep the old `PI_CODING_AGENT_DIR`. Warn here
  // rather than gating session operations — the onboarding banner already asks
  // for the restart.
  const profileStale = info != null && prefs.profileMode !== info.profileMode;

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

  /** One host's request/stop timeline, ready for an issue or a diff (step 16). */
  const copyTimeline = useCallback(async (host: DiagnosticsHostInfo) => {
    const text = host.logLines.join("");
    if (text.length === 0) return;
    try {
      await navigator.clipboard?.writeText(text);
      setNotice(`Copied ${text.length} characters from ${host.tabId}.`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  /** The terminal log path is what a bug report needs; copy it, not the log. */
  const copyTerminalLog = useCallback(async (file: string) => {
    const copied = await copyText(file);
    setNotice(copied ? `Copied ${file}` : "Could not copy the log path.");
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
        [
          "Build",
          `${info.buildChannel ?? "unknown"}${info.buildCommit ? ` · ${info.buildCommit}` : ""}` +
            `${info.buildVersion && info.buildVersion !== info.version ? ` · built as v${info.buildVersion}` : ""}`,
        ],
        ["Electron", `${info.electron} (Chromium ${info.chrome})`],
        ["App node", info.node],
        ["Platform", `${info.platform}/${info.arch}`],
      ]
    : [];

  return (
    <ViewShell width="narrow" gap={6}>
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
                <dt>PI_CODING_AGENT_DIR</dt>
                <dd data-testid="diagnostics-profile-override">
                  {snapshot.environment.PI_CODING_AGENT_DIR ?? "—"}
                </dd>
              </div>
              {profileStale ? (
                <div className="contents">
                  <dt>Profile change</dt>
                  <dd>
                    <Badge tone="warn" data-testid="diagnostics-profile-stale">
                      changed this run; restart to apply
                    </Badge>
                  </dd>
                </div>
              ) : null}
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
              {snapshot.capacity.liveHosts}/{snapshot.capacity.targetHosts} live hosts (ceiling{" "}
              {snapshot.capacity.ceilingHosts}) · {snapshot.capacity.openSessions} open sessions (
              {snapshot.capacity.asleepSessions} asleep) · {snapshot.capacity.visibleSessions}{" "}
              visible panes · {snapshot.capacity.editorTabs} editor tabs · host RSS{" "}
              {formatBytes(snapshot.capacity.hostRssBytes)} /{" "}
              {formatBytes(snapshot.capacity.hostRssLimitBytes)} · per-host budget{" "}
              {formatBytes(snapshot.memory.budgetBytes)} (recycle at{" "}
              {formatBytes(snapshot.memory.restartBytes)})
            </p>
            <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              {snapshot.capacity.overTarget ? <Badge tone="warn">over target</Badge> : null}
              {snapshot.capacity.overMemory ? <Badge tone="warn">over memory</Badge> : null}
              <span>
                The live-session target is soft; inactive sessions sleep and wake on first use. A
                visible pane is never parked, so a grid can legitimately sit above its target.
              </span>
            </p>
            <p className="text-xs text-ink-muted">
              System memory {formatBytes(snapshot.memory.freeBytes)} free of{" "}
              {formatBytes(snapshot.memory.totalBytes)} · {snapshot.web.tabs} web tabs ·{" "}
              {snapshot.web.liveViews}/{snapshot.web.limit} live views
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
                      {host.buildId ? ` · build ${host.buildId.slice(0, 12)}` : ""}
                      {host.officeHost ? " · office" : ""}
                    </span>
                    {host.stale ? <Badge tone="warn">stale build</Badge> : null}
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
                  {hostTiming(host) ? (
                    <span className="text-xs text-ink-muted" data-testid="diagnostics-host-timing">
                      {hostTiming(host)}
                    </span>
                  ) : null}
                  {host.logLines.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      <pre className="max-h-40 overflow-auto rounded bg-surface-sunken p-2 text-[11px] leading-4">
                        {host.logLines.slice(-12).join("")}
                      </pre>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="diagnostics-copy-timeline"
                        onClick={() => void copyTimeline(host)}
                      >
                        Copy timeline
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </section>

          {/*
            The integrated terminal is a separate host process with one native
            dependency (`node-pty`). A package whose `pty.node` cannot load is
            invisible in the session host cards, so this card reports the
            probe, the last exit and the log file to attach to a bug report.
          */}
          <section className="card flex flex-col gap-3" data-testid="diagnostics-terminal">
            <h2 className="text-sm font-semibold">Terminal</h2>
            <p className="text-xs text-ink-muted">
              The integrated terminal runs in its own host process. “node-pty loaded” means the
              native backend is available; “node-pty unavailable” names the loader error (for
              example a `GLIBC` version the packaged binary needs).
            </p>
            {(snapshot.terminal?.hosts ?? []).length === 0 ? (
              <p className="text-sm text-ink-muted">
                No terminal host has started yet. Open a terminal tab to start one.
              </p>
            ) : (
              (snapshot.terminal?.hosts ?? []).map((terminal) => (
                <div
                  key={terminal.windowId}
                  className="flex flex-col gap-1 border-t border-line pt-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        terminal.pty === null ? "neutral" : terminal.pty.loaded ? "ok" : "danger"
                      }
                    >
                      {terminal.pty === null
                        ? "not probed"
                        : terminal.pty.loaded
                          ? "node-pty loaded"
                          : "node-pty unavailable"}
                    </Badge>
                    <span className="text-xs text-ink-muted">
                      window {terminal.windowId} · host {terminal.running ? "running" : "stopped"} ·
                      node {terminal.nodePath || "?"}
                    </span>
                  </div>
                  {terminal.pty?.error ? (
                    <span className="whitespace-pre-wrap break-words text-xs text-danger">
                      {terminal.pty.error}
                    </span>
                  ) : null}
                  {terminal.lastExit ? (
                    <span className="text-xs text-ink-muted">
                      Last exit {terminal.lastExit.code}
                      {terminal.lastExit.signal ? ` (${terminal.lastExit.signal})` : ""}
                      {terminal.lastExit.expected ? " during shutdown" : ""}
                    </span>
                  ) : null}
                  {terminal.lastError ? (
                    <span className="whitespace-pre-wrap break-words text-xs text-danger">
                      {terminal.lastError}
                    </span>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-xs text-ink-muted" title={terminal.logFile}>
                      log: {terminal.logFile}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="diagnostics-copy-terminal-log"
                      onClick={() => void copyTerminalLog(terminal.logFile)}
                    >
                      Copy log path
                    </Button>
                  </div>
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
    </ViewShell>
  );
}
