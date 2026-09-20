import type { HostMethod, HostRole } from "../shared/host-protocol";
import { createProviderHandlers, PROVIDER_METHODS, type ProviderPort } from "./providers";
import type { HostHandler } from "./service";

/**
 * The control core (plan step 3, decision D-A3).
 *
 * A control host serves app-wide state — settings, and (from step 4) providers,
 * packages and file listings — and **never constructs an `AgentSession`**: it
 * exists so the welcome screen, onboarding and the Extensions hub can work before
 * (or without) any session.
 *
 * Both dependencies are injected, so this module has no SDK import and a test can
 * prove that a control host never reaches for a session runtime.
 */

/**
 * One settings scope as Pi hands it over (the SDK's `Settings`). Its fields
 * belong to Pi, so the app-side type stays structural; the settings schema in
 * step 12 is what gives them names.
 */
export type SettingsScope = object;

/**
 * The settings surface a control host needs.
 *
 * Deliberately the two scopes rather than a merged object: Pi keeps global
 * (`~/.pi/agent/settings.json`) and project (`<cwd>/.pi/settings.json`) settings
 * apart with nested-merge semantics, and the settings UI (step 12) has to show
 * and edit both. Inventing a merge here would hide which scope wins.
 */
export interface SettingsManagerLike {
  getGlobalSettings?(): SettingsScope;
  getProjectSettings?(): SettingsScope;
  flush?(): Promise<void>;
  drainErrors?(): unknown[];
}

export interface ControlCoreDeps {
  /** Creates the settings manager on first use (never at construction). */
  createSettings(): SettingsManagerLike;
  /** Lists every session of the profile (all projects), for the session browser. */
  listSessions(): Promise<unknown[]>;
  /**
   * Provider/credential management (plan step 9). Optional for the same reason
   * `files.list` is: a host can be useful without it, and when it is missing the
   * `providers.*` handlers answer `not_implemented` instead of pretending.
   */
  providers?: ProviderPort;
}

/** The methods a control host answers. Everything else stays `not_implemented`. */
export const CONTROL_METHODS: readonly HostMethod[] = [
  "settings.get",
  "settings.raw",
  "session.list",
  ...PROVIDER_METHODS,
];

export interface ControlCore {
  role: HostRole;
  handlers(): Partial<Record<HostMethod, HostHandler>>;
  dispose(): Promise<void>;
}

export function createControlCore(deps: ControlCoreDeps): ControlCore {
  let settings: SettingsManagerLike | null = null;

  const settingsManager = (): SettingsManagerLike => {
    settings ??= deps.createSettings();
    return settings;
  };

  const readScopes = (
    manager: SettingsManagerLike,
  ): { global: SettingsScope; project: SettingsScope } => ({
    global: manager.getGlobalSettings?.() ?? {},
    project: manager.getProjectSettings?.() ?? {},
  });

  return {
    role: "control",

    handlers: () => ({
      "settings.get": () => ({
        settings: readScopes(settingsManager()),
        errors: settingsManager().drainErrors?.() ?? [],
      }),
      "settings.raw": () => ({ settings: readScopes(settingsManager()) }),
      "session.list": async () => ({ sessions: await deps.listSessions() }),
      ...createProviderHandlers(() => deps.providers ?? null).handlers(),
    }),

    dispose: async () => {
      const current = settings;
      settings = null;
      if (current?.flush) {
        try {
          await current.flush();
        } catch {
          // A failed flush of read-only app state must not block shutdown.
        }
      }
    },
  };
}
