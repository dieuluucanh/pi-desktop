/**
 * Renderer-facing contract for the Pi for Office setup wizard.
 *
 * The Electron main process projects the rich wizard state
 * (`OfficeSetupState` in `src/main/office/setup-controller.ts`) into these small
 * view models: no `raw` payloads, no filesystem objects, and — because they live
 * in `src/shared` — the renderer never has to import main-process code.
 */

import type { OfficeHost } from "./office";
import type { BridgeCompatibility, OfficeRunState } from "./office-bridge";

export type OfficeSetupStatus = "idle" | "running" | "attention" | "done" | "failed" | "cancelled";

export type OfficeSetupStepId = "detect" | "bridge-package" | "sideload" | "open-office" | "verify";

export const OFFICE_SETUP_STEP_ORDER: readonly OfficeSetupStepId[] = [
  "detect",
  "bridge-package",
  "sideload",
  "open-office",
  "verify",
] as const;

export function isOfficeSetupStepId(value: unknown): value is OfficeSetupStepId {
  return (
    typeof value === "string" && (OFFICE_SETUP_STEP_ORDER as readonly string[]).includes(value)
  );
}

export type OfficeChecklistStatus = "pending" | "running" | "ok" | "failed" | "skipped";

export interface OfficeSetupStepView {
  id: string;
  title: string;
  status: OfficeChecklistStatus;
  detail: string;
  actions: string[];
}

export interface OfficeSetupTroubleshootView {
  id: string;
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
  actions: string[];
}

export interface OfficeSetupAppView {
  host: OfficeHost;
  label: string;
  installed: boolean;
}

export interface OfficeSetupDetectionView {
  os: string;
  supported: boolean;
  isWsl: boolean;
  officeVersion: string | null;
  products: string[];
  apps: OfficeSetupAppView[];
  anyAppInstalled: boolean;
  sideloaded: boolean;
  sideloadProblems: string[];
  notes: string[];
  checkedAt: string;
}

export interface OfficeSetupBridgeView {
  status: string;
  version: string | null;
  error: string | null;
  installLog: string;
}

export interface OfficeSetupSideloadView {
  ok: boolean;
  verified: boolean;
  error: string | null;
  platform: string;
}

export interface OfficeSetupOpenOfficeView {
  ok: boolean;
  host: OfficeHost;
  path: string | null;
  usedWebFallback: boolean;
  note: string | null;
  error: string | null;
}

export interface OfficeSetupHealthView {
  status: string;
  url: string;
  portConflict: boolean;
  error: string | null;
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: number | null;
  catalogVersion: number | null;
  /** Capabilities the bridge advertised (`agent-deltas`, `client-abort`, …). */
  capabilities: string[];
}

export interface OfficeSetupPaneView {
  host: OfficeHost | null;
  clientName: string | null;
  documentId: string | null;
  documentName: string | null;
  focused: boolean;
  visible: boolean;
  windows: number;
  ops: number;
  model: string | null;
  provider: string | null;
}

export interface OfficeSetupLogView {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface OfficeSetupView {
  status: OfficeSetupStatus;
  currentStep: OfficeSetupStepId | null;
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** True while the wizard runs without touching the machine (tests, E2E). */
  dryRun: boolean;
  port: number;
  steps: OfficeSetupStepView[];
  detection: OfficeSetupDetectionView | null;
  bridge: OfficeSetupBridgeView | null;
  sideload: OfficeSetupSideloadView | null;
  openOffice: OfficeSetupOpenOfficeView | null;
  health: OfficeSetupHealthView | null;
  /**
   * What the connected bridge can actually do. Protocol v3 (bridge 0.5.0) adds
   * streamed deltas and a pane-side Stop; an older bridge connects and answers
   * with a single final message instead. Null until `/health` has been probed.
   */
  compatibility: BridgeCompatibility | null;
  /**
   * Live Office run (streamed text + the Stop target). Null until this app owns
   * an Office session; `available` is false in that case.
   */
  run: OfficeRunState | null;
  panes: OfficeSetupPaneView[];
  troubleshooting: OfficeSetupTroubleshootView[];
  diagnostics: string;
  redactions: number;
  error: string | null;
  log: OfficeSetupLogView[];
}
