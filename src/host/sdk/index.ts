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
