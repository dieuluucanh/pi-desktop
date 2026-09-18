/**
 * The Pi for Office setup wizard controller.
 *
 * This is the contract the panel UI binds to: an ordered Detect → Install
 * bridge → Sideload → Open Office → Verify run, a live checklist, ranked
 * troubleshooting, and a redacted diagnostics bundle for "Copy diagnostics".
 *
 * It is intentionally UI-free so the whole wizard can be tested headlessly and
 * driven from either the Electron main process or a fixture harness.
 */

import { PI_OFFICE_BRIDGE, type OfficeHost } from "../../shared/office";
import type { FsPort } from "../fs-port";
import { npmRootPaths } from "../packages/npm-root";
import type { PackageInstaller } from "../packages/installer";
import {
  defaultBridgeSettingsPath,
  ensureBridgePackage,
  type BridgeInstallResult,
} from "./bridge-install";
import { detectOfficeWith, type DetectDeps } from "./detect";
import type { OfficeDetectionResult } from "./types";
import { sideloadAddIn, type SideloadDeps, type SideloadResult } from "./sideload";
import {
  buildDiagnosticsBundle,
  buildTroubleshooting,
  type DiagnosticsInput,
  type TroubleshootItem,
} from "./troubleshoot";
import {
  buildSetupChecklist,
  checkBridgeHealth,
  openOfficeHost,
  waitForPane,
  type BridgeHealthCheck,
  type BridgePane,
  type ChecklistStep,
  type OpenOfficeResult,
  type VerifyDeps,
} from "./verify";

export type OfficeSetupStatus = "idle" | "running" | "attention" | "done" | "failed" | "cancelled";

export type OfficeSetupStepId = "detect" | "bridge-package" | "sideload" | "open-office" | "verify";

export const OFFICE_SETUP_STEP_ORDER: readonly OfficeSetupStepId[] = [
  "detect",
  "bridge-package",
  "sideload",
  "open-office",
  "verify",
];

export interface OfficeSetupLogEntry {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface OfficeSetupState {
  status: OfficeSetupStatus;
  currentStep: OfficeSetupStepId | null;
  startedAt: string | null;
  finishedAt: string | null;
  detection: OfficeDetectionResult | null;
  bridge: BridgeInstallResult | null;
  sideload: SideloadResult | null;
  openOffice: OpenOfficeResult | null;
  health: BridgeHealthCheck | null;
  panes: BridgePane[];
  checklist: ChecklistStep[];
  troubleshooting: TroubleshootItem[];
  diagnostics: string;
  redactions: number;
  error: string | null;
  log: OfficeSetupLogEntry[];
}

export interface OfficeSetupAppInfo {
  name: string;
  version: string;
  electron: string | null;
  node: string | null;
  chrome?: string | null;
  platform: string;
  arch: string;
  osRelease: string | null;
}

export interface OfficeSetupControllerOptions {
  fs: FsPort;
  agentDir: string;
  cwd: string;
  manifestPath: string;
  detect: DetectDeps;
  installer: PackageInstaller;
  verify: VerifyDeps;
  /** Defaults to `{ fs, detect }`. */
  sideload?: SideloadDeps;
  scope?: "user" | "project";
  settingsPath?: string;
  backupDir?: string;
  port?: number;
  hosts?: readonly OfficeHost[];
  openPath?: (path: string) => Promise<string>;
  openExternal?: (url: string) => Promise<void>;
  /** Open an Office app during `run()`. Default: true. */
  openOfficeApp?: boolean;
  waitForPane?: { pollIntervalMs?: number; timeoutMs?: number };
  now?: () => Date;
  onChange?: (state: OfficeSetupState) => void;
  env?: Record<string, string | undefined>;
  appInfo?: OfficeSetupAppInfo;
}

export class OfficeSetupController {
  private readonly options: OfficeSetupControllerOptions;
  private readonly emit: (state: OfficeSetupState) => void;
  private readonly controller = new AbortController();
  private state: OfficeSetupState;
  private log: OfficeSetupLogEntry[] = [];

  constructor(options: OfficeSetupControllerOptions) {
    this.options = options;
    this.emit = options.onChange ?? (() => {});
    this.state = this.createInitialState();
  }

  get port(): number {
    return this.options.port ?? PI_OFFICE_BRIDGE.defaultPort;
  }

  private createInitialState(): OfficeSetupState {
    return {
      status: "idle",
      currentStep: null,
      startedAt: null,
      finishedAt: null,
      detection: null,
      bridge: null,
      sideload: null,
      openOffice: null,
      health: null,
      panes: [],
      checklist: [],
      troubleshooting: [],
      diagnostics: "",
      redactions: 0,
      error: null,
      log: [],
    };
  }

  getState(): OfficeSetupState {
    return this.state;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private addLog(level: OfficeSetupLogEntry["level"], message: string): void {
    this.log = [...this.log, { at: this.now().toISOString(), level, message }].slice(-200);
  }

  private update(patch: Partial<OfficeSetupState>): OfficeSetupState {
    this.state = { ...this.state, ...patch };
    this.refreshDerived();
    this.emit(this.state);
    return this.state;
  }

  /** Recomputes checklist, troubleshooting and diagnostics from current state. */
  private refreshDerived(): void {
    const checklist = buildSetupChecklist({
      detection: this.state.detection,
      bridge: this.state.bridge
        ? {
            status: this.state.bridge.status,
            packageName: PI_OFFICE_BRIDGE.packageName,
            version: this.state.bridge.state.version,
            error: this.state.bridge.error,
          }
        : null,
      sideload: this.state.sideload
        ? {
            ok: this.state.sideload.ok,
            verified: this.state.sideload.verified,
            error: this.state.sideload.error,
            platform: this.state.sideload.platform,
          }
        : null,
      openOffice: this.state.openOffice,
      health: this.state.health,
      panes: this.state.panes,
    });

    const troubleshooting = buildTroubleshooting({
      platform: this.state.detection?.os ?? (this.options.detect.platform === "win32" ? "windows" : this.options.detect.platform === "darwin" ? "macos" : "linux"),
      isWsl: this.state.detection?.isWsl ?? false,
      detection: this.state.detection,
      bridge: this.state.bridge,
      sideload: this.state.sideload,
      health: this.state.health,
      panes: this.state.panes,
      port: this.port,
    });

    const diagnostics = this.composeDiagnostics(checklist, troubleshooting);
    this.state = {
      ...this.state,
      checklist,
      troubleshooting,
      diagnostics: diagnostics.text,
      redactions: diagnostics.redactions,
      log: this.log,
    };
  }

  private composeDiagnostics(
    checklist: readonly ChecklistStep[],
    troubleshooting: readonly TroubleshootItem[],
  ): { text: string; redactions: number } {
    const settingsPath =
      this.options.settingsPath ??
      defaultBridgeSettingsPath(this.options.agentDir, this.options.cwd, this.options.scope ?? "user");
    const appInfo: OfficeSetupAppInfo = this.options.appInfo ?? {
      name: "Pi Desktop",
      version: "0.0.1",
      electron: null,
      node: typeof process === "undefined" ? null : process.versions.node,
      platform: this.options.detect.platform,
      arch: "unknown",
      osRelease: null,
    };

    const input: DiagnosticsInput = {
      app: { ...appInfo, isWsl: this.state.detection?.isWsl ?? false },
      profile: {
        agentDir: this.options.agentDir,
        cwd: this.options.cwd,
        settingsPath,
        npmRoot: npmRootPaths({
          agentDir: this.options.agentDir,
          cwd: this.options.cwd,
          scope: this.options.scope ?? "user",
        }).root,
      },
      port: this.port,
      detection: this.state.detection,
      bridge: this.state.bridge,
      sideload: this.state.sideload,
      health: this.state.health,
      panes: this.state.panes,
      checklist,
      troubleshooting,
      ...(this.options.env ? { env: this.options.env } : {}),
      now: () => this.now(),
    };

    return buildDiagnosticsBundle(input);
  }

  /** Latest diagnostics text (already redacted) for the Copy-diagnostics button. */
  buildDiagnostics(): string {
    this.refreshDerived();
    return this.state.diagnostics;
  }

  cancel(): void {
    if (!this.controller.signal.aborted) this.controller.abort();
    this.addLog("warn", "Setup cancelled by the user");
    this.update({ status: "cancelled", currentStep: null, finishedAt: this.now().toISOString() });
  }

  async detect(): Promise<OfficeSetupState> {
    this.update({ currentStep: "detect", status: "running" });
    try {
      const detection = await detectOfficeWith(this.options.detect);
      this.addLog("info", `Detected ${detection.apps.filter((app) => app.installed).length} Office app(s) on ${detection.os}`);
      return this.update({ detection, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addLog("error", `Detection failed: ${message}`);
      return this.update({ error: message, status: "failed" });
    }
  }

  async installBridge(): Promise<OfficeSetupState> {
    this.update({ currentStep: "bridge-package", status: "running" });
    const result = await ensureBridgePackage({
      fs: this.options.fs,
      installer: this.options.installer,
      agentDir: this.options.agentDir,
      cwd: this.options.cwd,
      scope: this.options.scope ?? "user",
      ...(this.options.settingsPath ? { settingsPath: this.options.settingsPath } : {}),
      ...(this.options.backupDir ? { backupDir: this.options.backupDir } : {}),
      now: () => this.now(),
      onProgress: (event) => this.addLog("info", `[bridge] ${event.phase}: ${event.message}`),
    });
    this.addLog(
      result.status === "failed" ? "error" : "info",
      `Bridge package: ${result.status}${result.state.version ? ` (v${result.state.version})` : ""}`,
    );
    if (result.installLog) this.addLog("info", `[npm] ${result.installLog}`);

    return this.update({
      bridge: result,
      error: result.status === "failed" ? result.error : null,
      ...(result.status === "failed" ? { status: "failed" as const } : {}),
    });
  }

  async sideload(): Promise<OfficeSetupState> {
    this.update({ currentStep: "sideload", status: "running" });
    const sideloadDeps: SideloadDeps = this.options.sideload ?? {
      fs: this.options.fs,
      detect: this.options.detect,
    };
    const result = await sideloadAddIn(sideloadDeps, {
      manifestPath: this.options.manifestPath,
      ...(this.options.hosts ? { hosts: this.options.hosts } : {}),
    });
    this.addLog(
      result.ok ? "info" : "error",
      `Sideload: ${result.ok ? "ok" : "failed"}${result.error ? ` — ${result.error}` : ""}`,
    );
    // Refresh the environment view: after a successful write, detection is the
    // evidence that Office can now see the add-in.
    return this.update({
      sideload: result,
      ...(result.verification ? { detection: result.verification } : {}),
      error: result.ok ? null : result.error,
    });
  }

  async unsideload(): Promise<OfficeSetupState> {
    this.update({ currentStep: "sideload", status: "running" });
    const sideloadDeps: SideloadDeps = this.options.sideload ?? {
      fs: this.options.fs,
      detect: this.options.detect,
    };
    const { unsideloadAddIn } = await import("./sideload");
    const result = await unsideloadAddIn(sideloadDeps);
    this.addLog(result.ok ? "info" : "error", `Unsideload: ${result.ok ? "ok" : "failed"}`);
    return this.update({
      detection: result.verification ?? this.state.detection,
      sideload: null,
      error: result.ok ? null : result.error,
    });
  }

  async openOffice(): Promise<OfficeSetupState> {
    if (!this.state.detection) {
      return this.update({ error: "Run detection before opening Office." });
    }
    this.update({ currentStep: "open-office", status: "running" });
    const result = await openOfficeHost({
      host: this.options.hosts?.[0] ?? "excel",
      detection: this.state.detection,
      ...(this.options.openPath ? { openPath: this.options.openPath } : {}),
      ...(this.options.openExternal ? { openExternal: this.options.openExternal } : {}),
    });
    this.addLog(
      result.ok ? "info" : "error",
      result.ok
        ? `Opened ${result.usedWebFallback ? "Office on the web" : result.path}`
        : `Could not open Office: ${result.error}`,
    );
    return this.update({ openOffice: result });
  }

  /** One health probe (used by the panel's "check again" action). */
  async refreshHealth(): Promise<OfficeSetupState> {
    const check = await checkBridgeHealth(this.options.verify, { port: this.port });
    this.addLog(
      check.status === "ok" ? "info" : "warn",
      `Bridge health: ${check.status}${check.error ? ` — ${check.error}` : ""}`,
    );
    return this.update({
      health: check,
      panes: check.health?.panes ?? [],
    });
  }

  async verifyBridge(): Promise<OfficeSetupState> {
    this.update({ currentStep: "verify", status: "running" });
    const result = await waitForPane(this.options.verify, {
      port: this.port,
      ...(this.options.hosts ? { hosts: this.options.hosts } : {}),
      ...(this.options.waitForPane?.pollIntervalMs !== undefined
        ? { pollIntervalMs: this.options.waitForPane.pollIntervalMs }
        : {}),
      ...(this.options.waitForPane?.timeoutMs !== undefined
        ? { timeoutMs: this.options.waitForPane.timeoutMs }
        : {}),
      signal: this.controller.signal,
      // Emitting per poll is what makes the checklist update live while the
      // user is opening Office (one emit per poll interval).
      onPoll: (check) => {
        this.update({ health: check, panes: check.health?.panes ?? [] });
      },
    });

    if (result.status === "aborted") {
      return this.update({ health: result.check, panes: result.panes, status: "cancelled" });
    }

    this.addLog(
      result.status === "attached" ? "info" : "warn",
      result.status === "attached"
        ? `Task pane attached after ${result.polls} poll(s)`
        : (result.error ?? "No task pane attached"),
    );

    return this.update({
      health: result.check,
      panes: result.panes,
      error: result.status === "attached" ? null : result.error,
    });
  }

  /** Full wizard run. Never throws: every step records its own failure. */
  async run(): Promise<OfficeSetupState> {
    this.log = [];
    this.update({
      ...this.createInitialState(),
      status: "running",
      startedAt: this.now().toISOString(),
    });

    try {
      await this.detect();
      const detection = this.state.detection;
      if (!detection) return this.finish("failed", "Detection failed.");

      if (!detection.supported) {
        // Nothing to install or sideload locally; report it as needing attention.
        return this.finish("attention", null);
      }

      await this.installBridge();
      if (this.state.bridge?.status === "failed") {
        return this.finish("failed", this.state.bridge.error);
      }

      await this.sideload();
      // A port conflict is worth knowing before we launch Office.
      await this.refreshHealth();

      if (this.options.openOfficeApp ?? true) {
        await this.openOffice();
      }

      await this.verifyBridge();
      if (this.controller.signal.aborted) return this.state;

      return this.finish(this.state.panes.length > 0 ? "done" : "attention", null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addLog("error", `Setup failed: ${message}`);
      return this.finish("failed", message);
    }
  }

  private finish(status: OfficeSetupStatus, error: string | null): OfficeSetupState {
    return this.update({
      status,
      currentStep: null,
      finishedAt: this.now().toISOString(),
      error: error ?? (status === "done" ? null : this.state.error),
    });
  }
}
