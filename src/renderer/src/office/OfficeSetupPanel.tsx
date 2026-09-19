import type { OfficeChecklistStatus, OfficeSetupStepId } from "../../../shared/office-setup";
import { OFFICE_SETUP_STEP_ORDER } from "../../../shared/office-setup";
import { useOfficeSetup } from "./useOfficeSetup";

/**
 * Pi for Office setup wizard panel (plan step 3).
 *
 * Pure presentation over `OfficeSetupView`: a stepper with per-step retry, the
 * live detection/bridge cards, the attached-document list, ranked
 * troubleshooting and the redacted diagnostics bundle.
 */

const STEP_LABELS: Record<OfficeSetupStepId, string> = {
  detect: "Detect Office",
  "bridge-package": "Install bridge package",
  sideload: "Sideload the add-in",
  "open-office": "Open Office",
  verify: "Verify the bridge",
};

const STATUS_GLYPH: Record<OfficeChecklistStatus, string> = {
  pending: "○",
  running: "◐",
  ok: "✓",
  failed: "✗",
  skipped: "–",
};

export function OfficeSetupPanel() {
  const office = useOfficeSetup();
  const view = office.view;

  return (
    <section className="panel">
      <header className="panel__head">
        <div>
          <h2>Pi for Office</h2>
          <p className="muted">
            Connects this app to Excel, Word and PowerPoint through the Pi for Office add-in on port{" "}
            {view?.port ?? 38617}.
          </p>
        </div>
        <span className={`pill pill--${view?.status ?? "idle"}`}>{view?.status ?? "loading…"}</span>
      </header>

      {view?.dryRun ? (
        <div className="banner banner--info">
          Dry run: detection and the health probe are real, but nothing is written to your machine
          and Office is never launched.
        </div>
      ) : null}

      {office.error ? <div className="banner banner--error">{office.error}</div> : null}
      {view?.error ? <div className="banner banner--error">{view.error}</div> : null}

      <div className="toolbar">
        <button type="button" onClick={office.run} disabled={office.busy || view?.running}>
          {office.started() ? "Run again" : "Set up Pi for Office"}
        </button>
        <button type="button" onClick={office.cancel} disabled={!view?.running}>
          Cancel
        </button>
        <button type="button" onClick={office.refreshHealth} disabled={office.busy}>
          Re-check bridge
        </button>
        <button type="button" onClick={office.loadDiagnostics} disabled={office.busy}>
          Diagnostics
        </button>
        <button type="button" className="danger" onClick={office.unsideload} disabled={office.busy}>
          Reset add-in
        </button>
      </div>

      <div className="panel__grid">
        <div className="stack">
          <Section title="Steps">
            <ol className="steps">
              {OFFICE_SETUP_STEP_ORDER.map((id) => {
                const step = view?.steps.find((entry) => entry.id === id);
                const status = step?.status ?? "pending";
                const active = view?.currentStep === id;
                return (
                  <li key={id} className={`step step--${status}${active ? " step--active" : ""}`}>
                    <span className="step__glyph" aria-hidden>
                      {STATUS_GLYPH[status]}
                    </span>
                    <div className="step__body">
                      <div className="step__title">{step?.title ?? STEP_LABELS[id]}</div>
                      {step?.detail ? <div className="step__detail">{step.detail}</div> : null}
                      {step && step.actions.length > 0 ? (
                        <ul className="step__actions">
                          {step.actions.map((action) => (
                            <li key={action}>{action}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => office.retry(id)}
                      disabled={office.busy || view?.running}
                    >
                      Retry
                    </button>
                  </li>
                );
              })}
            </ol>
          </Section>

          {view?.troubleshooting.length ? (
            <Section title="What to check">
              <ul className="findings">
                {view.troubleshooting.map((item) => (
                  <li key={item.id} className={`finding finding--${item.severity}`}>
                    <div className="finding__title">{item.title}</div>
                    <div className="finding__detail">{item.detail}</div>
                    {item.actions.length > 0 ? (
                      <ul className="finding__actions">
                        {item.actions.map((action) => (
                          <li key={action}>{action}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>

        <div className="stack">
          <Section title="Office">
            {view?.detection ? (
              <dl className="facts">
                <Fact
                  label="Platform"
                  value={`${view.detection.os}${view.detection.isWsl ? " (WSL)" : ""}`}
                />
                <Fact label="Office" value={view.detection.officeVersion ?? "not detected"} />
                <Fact
                  label="Apps"
                  value={
                    view.detection.apps
                      .filter((app) => app.installed)
                      .map((app) => app.label)
                      .join(", ") || "none installed"
                  }
                />
                <Fact
                  label="Add-in"
                  value={view.detection.sideloaded ? "sideloaded" : "not sideloaded"}
                />
                <Fact label="Checked" value={view.detection.checkedAt} />
              </dl>
            ) : (
              <p className="muted">Not detected yet.</p>
            )}
          </Section>

          <Section title="Bridge">
            <dl className="facts">
              <Fact label="Status" value={view?.health?.status ?? "not probed"} />
              <Fact
                label="URL"
                value={view?.health?.url ?? `http://127.0.0.1:${view?.port ?? 38617}/health`}
              />
              <Fact label="Server" value={view?.health?.serverVersion ?? "—"} />
              <Fact label="Protocol" value={view?.health?.protocolVersion?.toString() ?? "—"} />
              <Fact label="Catalog" value={view?.health?.catalogVersion?.toString() ?? "—"} />
              <Fact
                label="Package"
                value={
                  view?.bridge
                    ? `${view.bridge.status}${view.bridge.version ? ` (v${view.bridge.version})` : ""}`
                    : "—"
                }
              />
            </dl>
            {view?.health?.portConflict ? (
              <div className="banner banner--warn">
                Something else is listening on {view.port} — close the other Pi session or free the
                port.
              </div>
            ) : null}
          </Section>

          <Section title="Attached documents">
            {view?.panes.length ? (
              <ul className="panes">
                {view.panes.map((pane, index) => (
                  <li key={`${pane.documentId ?? pane.documentName ?? "pane"}-${index}`}>
                    <span className="pane__host">{pane.host ?? "unknown"}</span>
                    <span className="pane__name">
                      {pane.documentName ?? pane.documentId ?? "untitled"}
                    </span>
                    {pane.focused ? <span className="chip chip--live">focused</span> : null}
                    {!pane.visible ? <span className="chip">hidden</span> : null}
                    <span className="muted">{pane.ops} ops</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                No task pane attached yet. Open Excel/Word/PowerPoint and the Pi for Office pane
                after setting up.
              </p>
            )}
          </Section>
        </div>
      </div>

      {office.diagnostics ? (
        <Section title={`Diagnostics${view ? ` (${view.redactions} secret(s) redacted)` : ""}`}>
          <pre className="log">{office.diagnostics}</pre>
        </Section>
      ) : null}

      <Section title="Log">
        <pre className="log">
          {view?.log.length
            ? view.log
                .map((entry) => `${entry.at}  ${entry.level.padEnd(5)}  ${entry.message}`)
                .join("\n")
            : "No steps run yet."}
        </pre>
      </Section>
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="card">
      <h3>{title}</h3>
      {children}
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </>
  );
}
