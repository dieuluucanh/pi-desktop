import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BACKUP_DIR_ENV,
  BLOB_DIR_ENV,
  HOST_BUILD_ENV,
  HOST_ROLE_ENV,
  NODE_BIN_ENV,
  NPM_CLI_ENV,
  ROLE_FLAG,
  SAFE_MODE_ENV,
  SERVICE_ENV,
  SERVICE_FLAG,
  SESSION_ID_ENV,
  isHostRole,
  type HostRole,
} from "../shared/host-protocol";
import { createControlCore } from "./control-core";
import { createExtensionRendererRegistry } from "./extension-renderers";
import { createExtensionUiBridge, createExtensionUiPort } from "./extension-ui";
import {
  createNodeFileListingIo,
  createNodeModelsFileIo,
  createNodeProjectIo,
  createNodeSettingsFileIo,
  createNodeWorkspaceFileIo,
} from "./file-io";
import { listWorkspaceFiles } from "./file-listing";
import { readWorkspaceFile, writeWorkspaceFile } from "./workspace-files";
import { inspectProject } from "./project-inspect";
import { createProjectTrust } from "./project-trust";
import { createProviderLoginHandlers } from "./provider-login";
import { PACKAGE_METHODS, PackageError } from "./packages";
import { SAFE_MODE_PACKAGE_REFUSAL } from "./safe-mode";
import type { CustomProviderStore } from "./custom-providers";
import type { ProviderPort } from "./providers";
import { createSessionCore, type SessionCore } from "./session-core";
import { createHostService, type HostHandler, type HostService } from "./service";
import {
  ProjectTrustStore,
  SessionManager,
  createSdkCustomProviderStore,
  createSdkCommandRunner,
  createSdkExtensionBinder,
  createSdkKeybindingPort,
  createSdkPackagePort,
  createSdkProviderPort,
  createSdkResourceInspector,
  createSdkSessionRuntime,
  createSdkSettingsPort,
  createSdkShortcutRunner,
  createSdkThemePort,
  createSdkTuiSurface,
  createThemeSettingsManager,
  hasTrustRequiringProjectResources,
  listAllSessions,
  observeSdkModelChanges,
  renameStoredSession,
} from "./sdk";

/**
 * Pi host entry point — the process that runs the Pi SDK (plan D4, D16).
 *
 * Two shapes:
 *
 * 1. **CLI shape** (default): behaves exactly like the `pi` binary by delegating
 *    to the SDK's exported `main()`. The bundled `bin/pi` shim points here, so
 *    extensions that shell out to `pi` (workflow's `explore` subagent, reviewer
 *    subagents) keep working with no global install (plan D16, risk R4).
 *
 * 2. **Service shape** (`--service`, or `PI_DESKTOP_HOST_MODE=service`): the
 *    JSONL protocol the Electron main process drives (plan step 4). Session
 *    semantics are injected in plan step 5.
 *
 * Service mode is selected only by an explicit flag or environment variable, so
 * no legitimate `pi` argument can ever be shadowed by the app.
 */

export const BLOB_DIR_DEFAULT = join(tmpdir(), "pi-desktop-blobs");

// Re-exported so the supervisor and tests import the protocol constants from the
// host entry point as well as from `src/shared/host-protocol.ts`.
export { SERVICE_ENV, SERVICE_FLAG, SESSION_ID_ENV };

export type HostInvocation = { mode: "cli"; args: string[] } | { mode: "service"; args: string[] };

export function classifyInvocation(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): HostInvocation {
  const wantsService = argv.includes(SERVICE_FLAG) || env[SERVICE_ENV] === "service";
  const args = argv.filter((arg) => arg !== SERVICE_FLAG);
  return wantsService ? { mode: "service", args } : { mode: "cli", args };
}

/** Delegates to the Pi coding agent CLI (the SDK's `main`). */
export async function runCli(args: readonly string[]): Promise<void> {
  const { main } = await import("@earendil-works/pi-coding-agent");
  await main([...args]);
}

function flagValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

/**
 * Builds the session core with the real SDK adapters. Split out so the service
 * loop stays readable and the SDK import stays inside `src/host/sdk`.
 */
function createCore(options: {
  cwd: string;
  agentDir: string;
  emit: (event: string, payload?: unknown, sessionId?: string) => void;
  npmCommand?: readonly string[] | null;
  backupDir?: string;
  safeMode?: boolean;
  bindSession?: (session: never, runtime: never) => Promise<void>;
}): SessionCore {
  const trustStore = new ProjectTrustStore(options.agentDir);
  const settingsIo = createNodeSettingsFileIo();
  const modelsIo = createNodeModelsFileIo();
  const fileListingIo = createNodeFileListingIo();
  // Profile keybindings (plan step 15): one port for the whole host process.
  const keybindingPort = createSdkKeybindingPort({ agentDir: options.agentDir, io: modelsIo });

  return createSessionCore({
    cwd: options.cwd,
    agentDir: options.agentDir,
    ...(options.npmCommand ? { npmCommand: options.npmCommand } : {}),
    ...(options.safeMode ? { safeMode: true } : {}),
    ...(options.bindSession ? { bindSession: options.bindSession as never } : {}),
    emit: options.emit,
    trustStore,
    requiresTrust: (cwd) => hasTrustRequiringProjectResources(cwd),
    // Settings writes use the session's own manager for the session cwd, so a
    // change is visible to this session without a second manager (plan step 12).
    createSettingsPort: (manager) =>
      createSdkSettingsPort({
        agentDir: options.agentDir,
        cwd: options.cwd,
        io: settingsIo,
        ...(options.backupDir ? { backupDir: options.backupDir } : {}),
        ...(manager ? { manager: manager as never } : {}),
        ...(options.npmCommand ? { npmCommand: options.npmCommand } : {}),
      }),
    newSessionManager: (cwd, sessionDir) => SessionManager.create(cwd, sessionDir) as never,
    openSessionManager: (sessionFile, cwd, sessionDir) =>
      SessionManager.open(sessionFile, sessionDir, cwd) as never,
    listSessions: (cwd) => SessionManager.list(cwd) as Promise<never[]>,
    listFiles: (cwd, options) => listWorkspaceFiles(createNodeFileListingIo(), cwd, options),
    // Workspace file access (plan step 23): one node adapter, rooted at the
    // session cwd by the guard inside `workspace-files.ts`.
    readWorkspaceFile: (root, path, options) =>
      readWorkspaceFile(createNodeWorkspaceFileIo(), root, path, options ?? {}),
    writeWorkspaceFile: (root, path, text) =>
      writeWorkspaceFile(createNodeWorkspaceFileIo(), root, path, text),
    // Themes (plan step 15) resolve against the session's own manager and
    // loader when a session is open, so the catalogue is the running truth.
    createThemePort: (input) =>
      createSdkThemePort({
        agentDir: options.agentDir,
        cwd: options.cwd,
        manager: input.manager as never,
        loaderThemes: input.loader,
        io: modelsIo,
        listing: fileListingIo,
      }),
    keybindingPort,
    // Extension shortcuts (plan step 15) run through the live runner with
    // the app's effective bindings, so a user remap is honoured.
    wrapShortcutRunner: (runner) => createSdkShortcutRunner(runner as never),
    // Extension commands: direct execution and argument completion through
    // the live runner (2026-10-24 command parity plan).
    wrapCommandRunner: (runner) => createSdkCommandRunner(runner as never),
    // Extension-driven model/thinking selections (`/profile`, role switches)
    // are announced only on the extension runner; refresh the snapshot from
    // that broadcast so the header/footer follow the live session.
    observeModelChanges: observeSdkModelChanges,
    createRuntime: async (request) => {
      // Annotated with the adapter's own parameter type: if the SDK adapter ever
      // requires another field, this line fails to compile instead of drifting.
      const runtimeRequest: Parameters<typeof createSdkSessionRuntime>[0] = {
        cwd: request.cwd,
        agentDir: request.agentDir,
        sessionManager: request.sessionManager as never,
        ...(request.npmCommand ? { npmCommand: request.npmCommand } : {}),
      };
      const created = await createSdkSessionRuntime(runtimeRequest);
      return { runtime: created.runtime, session: created.session };
    },
  });
}

/** Which core a host process builds (plan D-A3): flag first, then environment. */
export function resolveHostRole(
  args: readonly string[] = [],
  env: Record<string, string | undefined> = {},
): HostRole {
  const fromFlag = flagValue(args, ROLE_FLAG);
  if (isHostRole(fromFlag)) return fromFlag;
  const fromEnv = env[HOST_ROLE_ENV];
  return isHostRole(fromEnv) ? fromEnv : "session";
}

/**
 * The control core's real adapters: settings, providers/credentials and the
 * profile-wide session list. Deliberately no session runtime — a control host
 * never owns an `AgentSession` (plan D-A3).
 */
function createControlHostCore(options: {
  cwd: string;
  agentDir: string;
  backupDir?: string;
  safeMode?: boolean;
  providers: ProviderPort;
  customProviders: CustomProviderStore;
  npmCommand?: readonly string[] | null;
}) {
  const trust = createProjectTrust({
    store: new ProjectTrustStore(options.agentDir),
    requiresTrust: (cwd) => hasTrustRequiringProjectResources(cwd),
  });
  const projectIo = createNodeProjectIo();
  const modelsIo = createNodeModelsFileIo();
  const fileListingIo = createNodeFileListingIo();

  return createControlCore({
    // One port; it resolves a `SettingsManager` per project cwd on demand, so a
    // project's settings are editable with no session open (plan step 12). Trust
    // comes from the same store the session flow uses, so an untrusted project
    // refuses project writes exactly as Pi does.
    settings: createSdkSettingsPort({
      agentDir: options.agentDir,
      cwd: options.cwd,
      io: createNodeSettingsFileIo(),
      ...(options.backupDir ? { backupDir: options.backupDir } : {}),
      isProjectTrusted: (cwd) => trust.status(cwd).trusted,
    }),
    listSessions: () => listAllSessions(),
    // Renaming a closed session goes through `SessionManager`, the SDK's own
    // writer — the control host still never builds an `AgentSession`.
    renameSession: async (sessionFile, name) => renameStoredSession(sessionFile, name),
    // The port is lazy: no `ModelRuntime` is built until the Connections view
    // (or onboarding) asks for providers.
    providers: options.providers,
    customProviders: options.customProviders,
    // Packages (plan step 14): install/update/remove through Pi's package
    // manager, with the bundled npm as a runtime-only override so installs work
    // even when `npm` is absent from PATH.
    packages: createSdkPackagePort({
      agentDir: options.agentDir,
      defaultCwd: options.cwd,
      ...(options.npmCommand ? { npmCommand: options.npmCommand } : {}),
      isProjectTrusted: (cwd) => trust.status(cwd).trusted,
    }),
    trust,
    defaultCwd: options.cwd,
    // The hub loads resources for a project on demand, so it works with no
    // session open; an untrusted project keeps its project resources hidden.
    resources: createSdkResourceInspector({
      agentDir: options.agentDir,
      cwd: options.cwd,
      isProjectTrusted: (cwd) => trust.status(cwd).trusted,
      ...(options.safeMode ? { safeMode: true } : {}),
    }),
    // Profile keybindings and the theme catalogue (plan step 15) work with no
    // session open; the theme port is built per project cwd over a fresh
    // settings manager, exactly as the control settings port does.
    keybindings: createSdkKeybindingPort({ agentDir: options.agentDir, io: modelsIo }),
    createThemePort: (cwd) =>
      createSdkThemePort({
        agentDir: options.agentDir,
        cwd,
        manager: createThemeSettingsManager(cwd, options.agentDir),
        io: modelsIo,
        listing: fileListingIo,
      }),
    projectInspect: (cwd) =>
      inspectProject(cwd, {
        io: projectIo,
        agentDir: options.agentDir,
        trust,
        joinPath: join,
      }),
  });
}

/**
 * The bundled `[node, npm-cli.js]` command (plan step 14), when the supervisor
 * provided both paths. `null` means the host has no runtime npm override and
 * package operations fall back to PATH.
 */
export function resolveNpmCommand(env: Record<string, string | undefined>): string[] | null {
  const nodePath = env[NODE_BIN_ENV]?.trim();
  const npmCli = env[NPM_CLI_ENV]?.trim();
  if (!nodePath || !npmCli) return null;
  return [nodePath, npmCli];
}

/**
 * Runs the host protocol service on stdio until the supervisor shuts it down.
 * Returns only when the process is about to exit.
 */
export function runService(
  args: readonly string[] = [],
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const blobDir = env[BLOB_DIR_ENV]?.trim() || BLOB_DIR_DEFAULT;
  const backupDir = env[BACKUP_DIR_ENV]?.trim() || undefined;
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(process.cwd(), ".pi", "agent");
  const bridgePort = flagValue(args, "--port") ?? env.PI_OFFICE_BRIDGE_PORT ?? null;
  const cwd = flagValue(args, "--cwd") ?? process.cwd();
  const role = resolveHostRole(args, env);
  const safeMode = env[SAFE_MODE_ENV] === "1";
  const npmCommand = resolveNpmCommand(env);

  return new Promise<void>((resolve) => {
    // The core is built before the service (which owns the frame writer), so the
    // emitter is forwarded through this small indirection.
    const forward = {
      emit: (_event: string, _payload?: unknown, _sessionId?: string): void => undefined,
    };

    // The control host owns the app-wide credential surface, so its provider port
    // is shared by the `providers.*` handlers and the login bridge below.
    const providerPort = role === "control" ? createSdkProviderPort({ agentDir }) : null;
    const customProviderStore = providerPort
      ? createSdkCustomProviderStore({
          modelsPath: join(agentDir, "models.json"),
          io: createNodeModelsFileIo(),
        })
      : null;

    // Extension UI (plan step 16) exists only for session hosts: a control host
    // never owns an `AgentSession`, so it has no extensions to bind. The port
    // owns dialogs, statuses, widgets and the composer mirror; its `bindSession`
    // callback installs Pi's real `ExtensionUIContext` on each attached session.
    const uiPort =
      role === "control"
        ? null
        : createExtensionUiPort({
            emit: (event, payload) => forward.emit(event, payload, undefined),
          });
    // The TUI surface (plan step 17) renders extension components to ANSI frames
    // and routes the renderer's key bytes back to them. It shares the UI port's
    // `onTerminalInput` handlers, which must run before the focused component.
    const tuiSurface =
      uiPort === null
        ? null
        : createSdkTuiSurface({
            emit: (event, payload) => forward.emit(event, payload, undefined),
            terminalInput: () => uiPort.terminalInputHandlers(),
          });
    // Extension-owned renderers (plan step 18) run in the host and return ANSI
    // lines for tool cards, custom messages and custom entries. Session hosts
    // only: a control host has no runner to render from.
    const rendererRegistry =
      uiPort === null
        ? null
        : createExtensionRendererRegistry({
            emit: (event, payload) => forward.emit(event, payload, undefined),
          });
    const keybindingIo = createNodeModelsFileIo();
    const keybindingPort = createSdkKeybindingPort({ agentDir, io: keybindingIo });
    const readKeybindings = async (): Promise<Record<string, unknown>> => {
      const text = await keybindingPort.read();
      if (!text) return {};
      try {
        const parsed = JSON.parse(text) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        // A malformed keybindings.json is surfaced by the Settings view; the
        // surface falls back to defaults rather than failing to bind.
        return {};
      }
    };
    const bindSession =
      uiPort && tuiSurface
        ? createSdkExtensionBinder({
            port: uiPort,
            tuiSurface,
            ...(rendererRegistry ? { renderers: rendererRegistry } : {}),
            readKeybindings,
            emit: (event, payload, sessionId) => forward.emit(event, payload, sessionId),
          })
        : null;

    const core =
      providerPort && customProviderStore
        ? createControlHostCore({
            cwd,
            agentDir,
            ...(backupDir ? { backupDir } : {}),
            ...(safeMode ? { safeMode: true } : {}),
            ...(npmCommand ? { npmCommand } : {}),
            providers: providerPort,
            customProviders: customProviderStore,
          })
        : createCore({
            cwd,
            agentDir,
            ...(backupDir ? { backupDir } : {}),
            ...(safeMode ? { safeMode: true } : {}),
            ...(npmCommand ? { npmCommand } : {}),
            ...(bindSession ? { bindSession } : {}),
            emit: (event, payload, sessionId) => forward.emit(event, payload, sessionId),
          });

    const handlers: Partial<Record<string, HostHandler>> = { ...core.handlers() };
    // Safe mode (plan step 22) is enforced at the composition root: installing or
    // removing a package is the one mutation that could re-introduce third-party
    // code, so every package mutation is refused outright.
    if (safeMode) {
      for (const method of PACKAGE_METHODS) {
        handlers[method] = async () => {
          throw new PackageError(SAFE_MODE_PACKAGE_REFUSAL, "safe_mode");
        };
      }
    }
    if (uiPort) Object.assign(handlers, uiPort.handlers());
    if (tuiSurface) Object.assign(handlers, tuiSurface.handlers());
    if (rendererRegistry) Object.assign(handlers, rendererRegistry.handlers());

    // Provider OAuth login is a control-host flow that reuses the `oi.respond`
    // answer path for its prompts (plan step 9, slice 3). It needs its own
    // bridge because the UI port is session-only.
    const ui = createExtensionUiBridge({
      emit: (event, payload) => forward.emit(event, payload, undefined),
    });
    const providerLogin = providerPort
      ? createProviderLoginHandlers({
          resolvePort: () => providerPort,
          emit: (event, payload) => forward.emit(event, payload, undefined),
          request: (method, params) => ui.request(method, params),
        })
      : null;
    if (providerLogin) {
      Object.assign(handlers, ui.handlers());
      Object.assign(handlers, providerLogin.handlers());
    }

    const service: HostService = createHostService({
      stdin: process.stdin,
      stdout: process.stdout,
      blobDir,
      handlers,
      info: {
        sessionId: flagValue(args, "--session") ?? env[SESSION_ID_ENV] ?? null,
        cwd,
        bridgePort: bridgePort === null ? null : Number(bridgePort),
        nodeVersion: process.version,
        piVersion: null,
        role,
        startedAt: Date.now(),
        buildId: env[HOST_BUILD_ENV]?.trim() || null,
      },
      onShutdown: () => {
        service.stop();
        ui.dispose("the host is shutting down");
        uiPort?.dispose("the host is shutting down");
        tuiSurface?.dispose("the host is shutting down");
        rendererRegistry?.dispose("the host is shutting down");
        providerLogin?.dispose();
        void core.dispose();
        // Give the response frame a tick to flush before the process ends.
        setTimeout(() => resolve(), 10);
      },
    });

    forward.emit = (event, payload, sessionId) => service.emit(event, payload, sessionId);
    service.start();
  });
}

export async function hostMain(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const invocation = classifyInvocation(argv, env);
  if (invocation.mode === "service") {
    await runService(invocation.args, env);
    return;
  }
  await runCli(invocation.args);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  hostMain(process.argv.slice(2), process.env)
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`pi-desktop host failed: ${detail}\n`);
      process.exit(1);
    });
}
