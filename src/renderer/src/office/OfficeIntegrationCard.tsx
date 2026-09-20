import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCopy, MessageSquarePlus, RefreshCw, Wrench } from "lucide-react";
import {
  deriveOfficeIntegrationFacts,
  type OfficeIntegrationStatus,
} from "../../../shared/integrations";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { OfficeSetupPanel } from "./OfficeSetupPanel";
import { useOfficeSetup } from "./useOfficeSetup";

/**
 * The Pi for Office integration card (plan step 19).
 *
 * The only Office surface in the app (plan D-A10): it states what is installed
 * and connected, offers the actions the plan names, and folds the unchanged
 * wizard panel in as the detailed evidence. The bridge install goes through the
 * package manager's standard consent dialog, and the app records that consent
 * in its own state — the card never installs anything silently.
 */

const STATUS_LABEL: Record<OfficeIntegrationStatus, string> = {
  "not-installed": "Not installed",
  installed: "Installed",
  connected: "Connected",
  attention: "Needs attention",
};

const STATUS_TONE: Record<OfficeIntegrationStatus, "neutral" | "accent" | "ok" | "warn"> = {
  "not-installed": "neutral",
  installed: "accent",
  connected: "ok",
  attention: "warn",
};

export function OfficeIntegrationCard() {
  const office = useOfficeSetup();
  const packages = useAppStore((state) => state.packages);
  const loadPackages = useAppStore((state) => state.loadPackages);
  const loadIntegrations = useAppStore((state) => state.loadIntegrations);
  const recordOfficeIntegration = useAppStore((state) => state.recordOfficeIntegration);
  const installOfficeBridge = useAppStore((state) => state.installOfficeBridge);
  const openOfficeSession = useAppStore((state) => state.openOfficeSession);
  const record = useAppStore((state) => state.integrations.office);

  const [copied, setCopied] = useState(false);
  const [detailsOverride, setDetailsOverride] = useState<boolean | null>(null);

  useEffect(() => {
    void loadIntegrations();
    void loadPackages();
  }, [loadIntegrations, loadPackages]);

  const view = office.view;
  const facts = useMemo(() => deriveOfficeIntegrationFacts({ view, packages }), [view, packages]);
  const busy = office.busy || view?.running === true;

  // Record the completed setup once per finish, so the card can say when it last
  // verified the machine (plan step 19: "recorded in app state").
  const recordedSetup = useRef<string | null>(null);
  const finishedAt = view?.finishedAt ?? null;
  const viewStatus = view?.status ?? "idle";
  useEffect(() => {
    if (viewStatus !== "done" || !finishedAt) return;
    if (recordedSetup.current === finishedAt) return;
    recordedSetup.current = finishedAt;
    void recordOfficeIntegration({ lastSetupAt: finishedAt });
  }, [viewStatus, finishedAt, recordOfficeIntegration]);

  // A run in flight, a failure or an unsupported bridge should not hide the
  // evidence behind a collapsed disclosure. The user's own toggle wins, so this
  // is derived rather than pushed into state by an effect.
  const autoOpen =
    view?.running === true || viewStatus === "failed" || facts.status === "attention";
  const detailsOpen = detailsOverride ?? autoOpen;

  const primary = (): void => {
    if (!facts.installed) {
      installOfficeBridge();
      return;
    }
    void office.run();
  };

  const copyDiagnostics = async (): Promise<void> => {
    const text = await office.loadDiagnostics();
    if (!text) return;
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
    } catch {
      // A missing clipboard is not worth an error banner; the bundle is still
      // rendered by the wizard panel below.
    }
  };

  return (
    <section
      className="flex flex-col gap-3 rounded-sm border border-line px-4 py-3"
      data-testid="office-integration-card"
      data-status={facts.status}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Pi for Office</h3>
            <Badge tone={STATUS_TONE[facts.status]}>{STATUS_LABEL[facts.status]}</Badge>
          </span>
          <p className="text-xs text-ink-muted">
            Optional integration. It installs the Office bridge as a normal Pi package, sideloads
            the add-in and verifies the connection; the app works without it.
          </p>
        </div>
      </header>

      {office.error ? (
        <p className="banner banner--error text-xs" role="alert">
          {office.error}
        </p>
      ) : null}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <Fact
          label="Bridge package"
          value={
            facts.installed
              ? `${facts.packageName}${facts.installedVersion ? ` v${facts.installedVersion}` : ""}`
              : "not installed"
          }
        />
        <Fact label="Pinned version" value={facts.pinnedVersion} />
        <Fact label="Add-in" value={facts.sideloaded ? "sideloaded" : "not sideloaded"} />
        <Fact label="Port" value={String(facts.port)} />
        <Fact
          label="Bridge health"
          value={facts.healthStatus ?? "not probed"}
          title={facts.healthUrl ?? undefined}
        />
        <Fact
          label="Protocol / catalog"
          value={
            facts.protocolVersion === null && facts.catalogVersion === null
              ? "—"
              : `v${facts.protocolVersion ?? "?"} / v${facts.catalogVersion ?? "?"}`
          }
        />
        <Fact label="Last checked" value={facts.checkedAt ?? "never"} />
        {record.bridgeInstalledAt ? (
          <Fact label="Installed here" value={record.bridgeInstalledAt} />
        ) : null}
      </dl>

      <Separator />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={primary} disabled={busy}>
          {facts.installed ? <Wrench className="size-3" aria-hidden /> : null}
          {!facts.installed
            ? "Install bridge package"
            : viewStatus === "done"
              ? "Repair"
              : "Set up Pi for Office"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void openOfficeSession()}
          disabled={!facts.installed}
          title={
            facts.installed
              ? undefined
              : "Install the bridge package before opening an Office session"
          }
        >
          <MessageSquarePlus className="size-3" aria-hidden />
          Open Office session
        </Button>
        <Button size="sm" variant="ghost" onClick={office.refreshHealth} disabled={busy}>
          <RefreshCw className="size-3" aria-hidden />
          Re-check bridge
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyDiagnostics()} disabled={busy}>
          <ClipboardCopy className="size-3" aria-hidden />
          {copied ? "Copied" : "Copy diagnostics"}
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={office.unsideload}
          disabled={busy || !facts.sideloaded}
        >
          Reset add-in
        </Button>
      </div>

      {facts.installed || office.started() ? (
        <details
          className="flex flex-col gap-2"
          open={detailsOpen}
          onToggle={(event) => setDetailsOverride(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-xs font-medium text-ink-muted">
            Setup details, documents and log
          </summary>
          <div className="pt-2" data-testid="office-setup-details">
            <OfficeSetupPanel />
          </div>
        </details>
      ) : (
        <p className="text-[11px] text-ink-faint">
          Installing the bridge package first keeps the wizard's evidence honest: every step it runs
          is either already satisfied or reported as failed.
        </p>
      )}
    </section>
  );
}

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="truncate font-mono text-ink" title={title ?? value}>
        {value}
      </dd>
    </>
  );
}
