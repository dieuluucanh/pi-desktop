import type { OfficeSetupView } from "../../shared/office-setup";
import { projectBridgeCompatibility, type OfficeRunState } from "../../shared/office-bridge";
import type { OfficeSetupState } from "./setup-controller";

/**
 * Projects the wizard's internal state onto the renderer contract.
 *
 * The internal state carries everything (full detection results, the raw bridge
 * health payload, all log lines); the view carries only what the panel renders.
 */

export interface ToOfficeSetupViewOptions {
  dryRun: boolean;
  port: number;
  /** Log lines to keep (the tail is what the panel shows). */
  logLimit?: number;
  /**
   * Live Office run, when this process owns an Office session. Omitted until the
   * app starts one, which the view reports as `{ available: false }`.
   */
  run?: OfficeRunState | null;
}

const DEFAULT_LOG_LIMIT = 60;

function appList(state: OfficeSetupState): OfficeSetupView["detection"] {
  const detection = state.detection;
  if (!detection) return null;

  return {
    os: detection.os,
    supported: detection.supported,
    isWsl: detection.isWsl,
    officeVersion: detection.office.version,
    products: [...detection.office.products],
    apps: detection.apps.map((app) => ({
      host: app.host,
      label: app.label,
      installed: app.installed,
    })),
    anyAppInstalled: detection.anyAppInstalled,
    sideloaded: detection.sideload.installed,
    sideloadProblems: [...detection.sideload.problems],
    notes: [...detection.notes],
    checkedAt: detection.checkedAt,
  };
}

export function toOfficeSetupView(
  state: OfficeSetupState,
  options: ToOfficeSetupViewOptions,
): OfficeSetupView {
  const logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;

  return {
    status: state.status,
    currentStep: state.currentStep,
    running: state.status === "running",
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    dryRun: options.dryRun,
    port: options.port,
    steps: state.checklist.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      detail: step.detail,
      actions: [...step.actions],
    })),
    detection: appList(state),
    bridge: state.bridge
      ? {
          status: state.bridge.status,
          version: state.bridge.state.version,
          error: state.bridge.error,
          installLog: state.bridge.installLog,
        }
      : null,
    sideload: state.sideload
      ? {
          ok: state.sideload.ok,
          verified: state.sideload.verified,
          error: state.sideload.error,
          platform: state.sideload.platform,
        }
      : null,
    openOffice: state.openOffice
      ? {
          ok: state.openOffice.ok,
          host: state.openOffice.host,
          path: state.openOffice.path,
          usedWebFallback: state.openOffice.usedWebFallback,
          note: state.openOffice.note,
          error: state.openOffice.error,
        }
      : null,
    health: state.health
      ? {
          status: state.health.status,
          url: state.health.url,
          portConflict: state.health.portConflict,
          error: state.health.error,
          serverName: state.health.health?.serverName ?? null,
          serverVersion: state.health.health?.serverVersion ?? null,
          protocolVersion: state.health.health?.protocolVersion ?? null,
          catalogVersion: state.health.health?.catalogVersion ?? null,
          capabilities: [...(state.health.health?.capabilities ?? [])],
        }
      : null,
    bridgeConnect: state.bridgeConnect,
    compatibility: state.health?.health
      ? projectBridgeCompatibility({
          protocolVersion: state.health.health.protocolVersion,
          capabilities: state.health.health.capabilities,
          serverVersion: state.health.health.serverVersion,
          catalogVersion: state.health.health.catalogVersion,
        })
      : null,
    run: options.run ?? { available: false, run: null, compatibility: null },
    panes: state.panes.map((pane) => ({
      host: pane.host,
      clientName: pane.clientName,
      documentId: pane.documentId,
      documentName: pane.documentName,
      focused: pane.focused,
      visible: pane.visible,
      windows: pane.windows,
      ops: pane.ops,
      model: pane.model,
      provider: pane.provider,
    })),
    troubleshooting: state.troubleshooting.map((item) => ({
      id: item.id,
      severity: item.severity,
      title: item.title,
      detail: item.detail,
      actions: [...item.actions],
    })),
    diagnostics: state.diagnostics,
    redactions: state.redactions,
    error: state.error,
    log: state.log.slice(-logLimit).map((entry) => ({ ...entry })),
  };
}
