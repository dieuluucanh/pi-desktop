/**
 * The SDK adapter boundary (plan risk R1).
 *
 * This is the **only** module in the host that imports
 * `@earendil-works/pi-coding-agent`. Everything else depends on the narrow
 * interfaces declared next to the code that uses them, so a Pi upgrade touches
 * this directory and nothing else.
 */

import {
  AgentSessionRuntime,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  VERSION,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  hasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";
import { checkpointExtensionLoaderOptions } from "../safe-mode";
import { resolveSessionScope } from "./model-scope";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionServices,
  CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

export {
  AgentSessionRuntime,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  VERSION,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  hasTrustRequiringProjectResources,
};

export type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionServices,
  CreateAgentSessionRuntimeFactory,
};

/** The subset of `AgentSession` the host drives; kept narrow for test doubles. */
export type SessionRuntimeFactory = (options: {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  /** Optional: the adapter creates one for the profile when omitted. */
  settingsManager?: SettingsManager;
  npmCommand?: readonly string[] | null;
  /** Safe mode (plan step 22): disable every resource-loader collection. */
  safeMode?: boolean;
  /** Whether the project is trusted, so its `.pi/settings.json` may be read. */
  projectTrusted?: boolean;
  /**
   * The bundled checkpoint extension (git-checkpoint plan step 24). No-op in
   * safe mode: `checkpointExtensionLoaderOptions` decides, because `noExtensions`
   * does *not* gate `additionalExtensionPaths`.
   */
  checkpointsExtensionPath?: string | null;
}) => Promise<{
  runtime: AgentSessionRuntime;
  session: AgentSession;
  services: AgentSessionServices;
}>;

/**
 * Builds a session runtime with the shared Pi profile: settings first (so the
 * bundled npm can be injected as a runtime override, plan D20), then cwd-bound
 * services, then the session itself.
 */
export const createSdkSessionRuntime: SessionRuntimeFactory = async (options) => {
  const settingsManager =
    options.settingsManager ??
    SettingsManager.create(options.cwd, options.agentDir, {
      projectTrusted: options.projectTrusted ?? true,
    });
  if (options.npmCommand && options.npmCommand.length > 0) {
    // Runtime-only override: never written to the shared settings.json.
    settingsManager.applyOverrides({ npmCommand: [...options.npmCommand] });
  }

  const buildRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      // Safe mode (plan step 22) and the app's own checkpoint extension (step 24)
      // share one decision: in safe mode the options disable every collection
      // *and* drop the extra path, because `noExtensions` alone does not.
      resourceLoaderOptions: checkpointExtensionLoaderOptions({
        safeMode: options.safeMode,
        extensionPath: options.checkpointsExtensionPath,
      }),
    });
    // Resolve `enabledModels` exactly as terminal Pi does at startup. The scope
    // is what extensions see as `ctx.scopedModels` and what `cycleModel` walks;
    // without it the workflow pickers believe no scope is configured and mark
    // every catalogue entry as out of scope. It does NOT pick the startup model:
    // `createAgentSession` calls `findInitialModel({ scopedModels: [] })`
    // internally, so the saved default still wins.
    const scope = await resolveSessionScope({
      patterns: settingsManager.getEnabledModels(),
      runtime: services.modelRuntime,
    });
    for (const diagnostic of scope.diagnostics) {
      // Same information terminal Pi prints; the host's stderr is captured in
      // the Diagnostics view's log tail.
      console.warn(`Warning: ${diagnostic.message}`);
    }
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(scope.scopedModels.length > 0 ? { scopedModels: scope.scopedModels } : {}),
    });
    return {
      ...created,
      services,
      diagnostics: [...services.diagnostics, ...scope.diagnostics],
    };
  };

  const runtime = await createAgentSessionRuntime(buildRuntime, {
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager: options.sessionManager,
  });

  return { runtime, session: runtime.session, services: runtime.services };
};

/**
 * Settings for a control host (plan D-A3). The bundled npm is injected as a
 * runtime-only override (plan D20) exactly as the session path does, so package
 * operations in the control host use the same npm.
 */
export function createSdkSettings(
  cwd: string,
  agentDir: string,
  npmCommand?: readonly string[] | null,
): SettingsManager {
  const manager = SettingsManager.create(cwd, agentDir);
  if (npmCommand && npmCommand.length > 0) {
    manager.applyOverrides({ npmCommand: [...npmCommand] });
  }
  return manager;
}

/** Every session of the profile across projects — the session browser's source. */
export function listAllSessions(): Promise<unknown[]> {
  return SessionManager.listAll() as Promise<unknown[]>;
}

/**
 * Renames a stored session that is not open in a tab (plan step 11).
 *
 * Uses `SessionManager.open(path)` and `appendSessionInfo(name)` — the SDK's own
 * writer — so the app never touches the JSONL format itself. The session file is
 * opened read/write by Pi and the new `session_info` entry is appended in place;
 * an open tab for the same file keeps its own manager and is renamed through it
 * instead (see the renderer's `renameStoredSession`).
 */
export function renameStoredSession(
  sessionFile: string,
  name: string,
): { path: string; name: string } {
  const manager = SessionManager.open(sessionFile);
  manager.appendSessionInfo(name);
  return { path: sessionFile, name };
}

/**
 * Providers, credentials and gateways (plan step 9). Re-exported here so the
 * composition root keeps importing the SDK adapters from one place.
 */
export {
  createSdkProviderPort,
  keyOnlyInteraction,
  type SdkProviderPortOptions,
} from "./providers";

/** Custom model gateways in `models.json` (plan step 9, slice 5). */
export { createSdkCustomProviderStore, type SdkCustomProviderOptions } from "./custom-providers";

/** The Extensions hub's loader source for a control host (plan step 13). */
export { createSdkResourceInspector, type SdkResourceInspectorOptions } from "./resources";

/** Package install/update/remove through Pi's package manager (plan step 14). */
export {
  applyNpmOverride,
  createSdkPackagePort,
  NPM_CAPTURE_CLI_ENV,
  NPM_CAPTURE_LOG_ENV,
  NPM_CAPTURE_SHIM,
  npmOverrideCommand,
  type SdkPackageOptions,
} from "./packages";

/** Settings reads, writes and backups through `SettingsManager` (plan step 12). */
export {
  createSdkSettingsPort,
  parseSettingsFile,
  serializeSettingsFile,
  type SdkSettingsOptions,
} from "./settings";

/** Theme catalogue, swatches and imports (plan step 15). */
export { createSdkThemePort, createThemeSettingsManager, type SdkThemePortOptions } from "./themes";

/** Profile `keybindings.json` (plan step 15). */
export { createSdkKeybindingPort, type SdkKeybindingPortOptions } from "./keybindings";

/** Extension shortcuts over a live `ExtensionRunner` (plan step 15). */
export { createSdkShortcutRunner, type SdkExtensionRunner } from "./shortcuts";
export { createSdkBashPort } from "./bash";
export {
  CHANGELOG_UNAVAILABLE,
  readSdkChangelog,
  sdkChangelogPath,
  type ChangelogResult,
} from "./changelog";

/** Extension commands: direct execution and argument completion (2026-10-24). */
export { createSdkCommandRunner, type SdkCommandRunner } from "./commands";

/**
 * Extension-driven model/thinking selections: `AgentSession` announces these
 * to the extension runner only, so the host observes `emit` to refresh state.
 */
export { observeSdkModelChanges } from "./model-changes";

/** Model scope (`enabledModels`): resolution and one-model star toggles. */
export {
  createSdkModelScope,
  ModelScopeError,
  resolveSessionScope,
  type ModelScopeResolver,
  type SdkModelScope,
} from "./model-scope";

/**
 * The extension-UI host (plan step 16): Pi's `ExtensionUIContext` over the
 * SDK-free UI port, plus the `bindSession` callback the session core calls.
 */
export {
  createSdkCommandContextActions,
  createSdkExtensionBinder,
  createSdkExtensionUiContext,
  createSdkThemeAccess,
  THEME_GLOBAL_SYMBOL,
  type SdkExtensionBinderOptions,
  type SdkThemeAccess,
  type SdkThemeAccessOptions,
  type SdkUiSurface,
} from "./extension-ui";

/** The extension TUI surface (plan step 17): pi-tui helpers, keybindings, footer data. */
export {
  createSdkFooterData,
  createSdkTuiKeybindings,
  createSdkTuiSurface,
  sdkEditorTheme,
  SDK_TUI_KIT,
  type SdkTuiSurfaceOptions,
} from "./tui-surface";
