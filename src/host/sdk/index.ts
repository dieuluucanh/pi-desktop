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
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  hasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";
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
    options.settingsManager ?? SettingsManager.create(options.cwd, options.agentDir);
  if (options.npmCommand && options.npmCommand.length > 0) {
    // Runtime-only override: never written to the shared settings.json.
    settingsManager.applyOverrides({ npmCommand: [...options.npmCommand] });
  }

  const buildRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
  }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager });
    const created = await createAgentSessionFromServices({ services, sessionManager });
    return { ...created, services, diagnostics: services.diagnostics };
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
