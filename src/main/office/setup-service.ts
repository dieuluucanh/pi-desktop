import { PI_OFFICE_BRIDGE } from "../../shared/office";
import type { OfficeBridgeEnsureResult, OfficeSetupView } from "../../shared/office-setup";
import { createMemoryFsPort, createNodeFsPort, type FsPort } from "../fs-port";
import { createNpmPackageInstaller, type PackageInstaller } from "../packages/installer";
import { createDefaultDetectDeps, type DetectDeps } from "./detect";
import { createCommandRunner, createFakeCommandRunner, type CommandRunner } from "./exec";
import {
  OfficeSetupController,
  type OfficeSetupAppInfo,
  type OfficeSetupState,
  type OfficeSetupStepId,
} from "./setup-controller";
import { toOfficeSetupView } from "./setup-view";
import { createDefaultSideloadDeps, type SideloadDeps } from "./sideload";
import { createDefaultVerifyDeps, type VerifyDeps } from "./verify";

/**
 * Binds the UI-free wizard to the real machine: bundled runtime, npm installer,
 * Electron `shell` callbacks and the shared Pi profile.
 *
 * Deliberately electron-free (AGENTS rule 1) — the Electron glue that registers
 * IPC lives in `src/main/ipc.ts` and passes `openPath`/`openExternal` in.
 *
 * Dry run (`PI_DESKTOP_OFFICE_DRY_RUN=1`) rehearses the whole flow with an
 * in-memory filesystem and a fake registry runner, so nothing is written and
 * Office is never launched — that is what E2E and CI use.
 */

export interface OfficeSetupServiceOptions {
  /** `~/.pi/agent` (or the profile override). */
  agentDir: string;
  /** Working directory used for project-scope settings. */
  cwd: string;
  /** Absolute path of the vendored `manifest.prod.xml`. */
  manifestPath: string;
  /** Resolved bundled runtime (plan step 2). */
  nodePath: string | null;
  npmCliPath: string | null;
  port?: number;
  dryRun?: boolean;
  backupDir?: string;
  openPath?: (path: string) => Promise<string>;
  openExternal?: (url: string) => Promise<void>;
  appInfo?: OfficeSetupAppInfo;
  onView?: (view: OfficeSetupView) => void;
  /** Injection seams for tests. */
  fs?: FsPort;
  runner?: CommandRunner;
  detect?: DetectDeps;
  verify?: VerifyDeps;
  sideload?: SideloadDeps;
  installer?: PackageInstaller;
  waitForPane?: { pollIntervalMs?: number; timeoutMs?: number };
  /** Starts/connects the bridge in a Pi session (bridge 0.6+). */
  ensureBridge?: () => Promise<OfficeBridgeEnsureResult>;
  now?: () => Date;
}

export interface OfficeSetupService {
  readonly dryRun: boolean;
  readonly port: number;
  getView(): OfficeSetupView;
  getState(): OfficeSetupState;
  start(): Promise<OfficeSetupView>;
  retryStep(step: OfficeSetupStepId): Promise<OfficeSetupView>;
  cancel(): OfficeSetupView;
  refreshHealth(): Promise<OfficeSetupView>;
  unsideload(): Promise<OfficeSetupView>;
  diagnostics(): string;
}

/** Coalescing window for `onChange` → IPC frames (the controller can emit per poll). */
const FLUSH_INTERVAL_MS = 50;

export function createOfficeSetupService(options: OfficeSetupServiceOptions): OfficeSetupService {
  const dryRun = options.dryRun ?? false;
  const port = options.port ?? PI_OFFICE_BRIDGE.defaultPort;
  const now = options.now ?? ((): Date => new Date());

  const fs = options.fs ?? (dryRun ? createMemoryFsPort() : createNodeFsPort());
  const runner = options.runner ?? (dryRun ? createFakeCommandRunner([]) : createCommandRunner());
  const detect = options.detect ?? { ...createDefaultDetectDeps(), runner, now };
  const sideload = options.sideload ?? createDefaultSideloadDeps({ fs, detect });
  const verify = options.verify ?? createDefaultVerifyDeps();
  const installer =
    options.installer ??
    createNpmPackageInstaller({
      runner,
      nodePath: options.nodePath ?? "node",
      npmCliPath: options.npmCliPath ?? "",
    });

  let latest: OfficeSetupState | null = null;
  let pending: OfficeSetupState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const viewOf = (state: OfficeSetupState): OfficeSetupView =>
    toOfficeSetupView(state, { dryRun, port });

  const flush = (): void => {
    timer = null;
    if (!pending) return;
    const state = pending;
    pending = null;
    options.onView?.(viewOf(state));
  };

  const controller = new OfficeSetupController({
    fs,
    agentDir: options.agentDir,
    cwd: options.cwd,
    manifestPath: options.manifestPath,
    detect,
    installer,
    verify,
    sideload,
    port,
    scope: "user",
    ...(options.backupDir ? { backupDir: options.backupDir } : {}),
    ...(options.openPath ? { openPath: options.openPath } : {}),
    ...(options.openExternal ? { openExternal: options.openExternal } : {}),
    ...(options.appInfo ? { appInfo: options.appInfo } : {}),
    ...(dryRun ? { openOfficeApp: false } : {}),
    ...(options.waitForPane ? { waitForPane: options.waitForPane } : {}),
    ...(options.ensureBridge ? { ensureBridge: options.ensureBridge } : {}),
    now,
    onChange: (state) => {
      latest = state;
      pending = state;
      if (timer) return;
      timer = setTimeout(flush, FLUSH_INTERVAL_MS);
      // Never hold the process open for a pending UI flush.
      if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
    },
  });

  latest = controller.getState();

  const finish = (state: OfficeSetupState): OfficeSetupView => {
    latest = state;
    return viewOf(state);
  };

  return {
    dryRun,
    port,
    getState: () => latest ?? controller.getState(),
    getView: () => viewOf(latest ?? controller.getState()),

    start: async () => finish(await controller.run()),
    retryStep: async (step) => {
      switch (step) {
        case "detect":
          return finish(await controller.detect());
        case "bridge-package":
          return finish(await controller.installBridge());
        case "sideload":
          return finish(await controller.sideload());
        case "open-office":
          return finish(await controller.openOffice());
        case "verify":
          return finish(await controller.verifyBridge());
      }
    },
    cancel: () => {
      controller.cancel();
      return finish(controller.getState());
    },
    refreshHealth: async () => finish(await controller.refreshHealth()),
    unsideload: async () => finish(await controller.unsideload()),
    diagnostics: () => controller.buildDiagnostics(),
  };
}
