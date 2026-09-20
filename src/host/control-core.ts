import type { HostMethod, HostRole } from "../shared/host-protocol";
import type { ProjectInspection } from "../shared/projects";
import {
  createCustomProviderHandlers,
  CUSTOM_PROVIDER_METHODS,
  type CustomProviderStore,
} from "./custom-providers";
import { createProjectHandlers, PROJECT_METHODS } from "./project-handlers";
import type { ProjectTrust } from "./project-trust";
import { createProviderHandlers, PROVIDER_METHODS, type ProviderPort } from "./providers";
import {
  buildResourcesSnapshot,
  createResourceHandlers,
  RESOURCE_METHODS,
  ResourceError,
  type ResourceInspector,
} from "./resources";
import { resolveListedSession, SessionFileError } from "./session-files";
import { createSettingsHandlers, SETTINGS_METHODS, type SettingsPort } from "./settings";
import type { HostHandler } from "./service";

/**
 * The control core (plan step 3, decision D-A3).
 *
 * A control host serves app-wide state — settings (plan step 12) and, since
 * step 4/9/10, providers, packages, projects and session listings — and **never
 * constructs an `AgentSession`**: it exists so the welcome screen, onboarding and
 * the Extensions hub can work before (or without) any session.
 *
 * Every dependency is injected, so this module has no SDK import and a test can
 * prove that a control host never reaches for a session runtime.
 */

/**
 * The settings surface the control host drives (plan step 12). Reads and errors
 * come from Pi's manager; writes are the port's concern so the SDK stays behind
 * `src/host/sdk/*`.
 */
export interface ControlCoreDeps {
  settings: SettingsPort;
  /** Lists every session of the profile (all projects), for the session browser. */
  listSessions(): Promise<unknown[]>;
  /**
   * The Extensions hub's loader source (plan step 13). Optional like the other
   * ports: a control host without it answers `resources.list` with
   * `not_implemented` instead of pretending it has no resources.
   */
  resources?: ResourceInspector;
  /** The cwd used when the hub does not name a project (the host's own cwd). */
  defaultCwd?: string;
  /**
   * Provider/credential management (plan step 9). Optional for the same reason
   * `files.list` is: a host can be useful without it, and when it is missing the
   * `providers.*` handlers answer `not_implemented` instead of pretending.
   */
  providers?: ProviderPort;
  /** Custom gateways in `models.json` (plan step 9, slice 5). */
  customProviders?: CustomProviderStore;
  /** Inspects one project folder for the project header (plan step 10). */
  projectInspect?(cwd: string): Promise<ProjectInspection>;
  /** Trust status and answers for a folder (plan step 10). */
  trust?: ProjectTrust;
  /**
   * Renames a stored session that is not open in a tab (plan step 11). The host
   * does this through `SessionManager`, never by editing the JSONL itself; a
   * host without the adapter answers `unsupported`.
   */
  renameSession?(sessionFile: string, name: string): Promise<{ path: string; name: string }>;
  /** Clock for the hub snapshot's `loadedAt` (tests inject a fixed value). */
  now?: () => number;
}

/** The methods a control host answers. Everything else stays `not_implemented`. */
export const CONTROL_METHODS: readonly HostMethod[] = [
  ...SETTINGS_METHODS,
  "session.list",
  "session.delete",
  "session.rename",
  ...PROVIDER_METHODS,
  ...CUSTOM_PROVIDER_METHODS,
  ...PROJECT_METHODS,
  ...RESOURCE_METHODS,
];

export interface ControlCore {
  role: HostRole;
  handlers(): Partial<Record<HostMethod, HostHandler>>;
  dispose(): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function createControlCore(deps: ControlCoreDeps): ControlCore {
  return {
    role: "control",

    handlers: () => ({
      ...createSettingsHandlers({ resolvePort: () => deps.settings }).handlers(),
      "session.list": async () => ({ sessions: await deps.listSessions() }),
      // Validation only: the app performs the recoverable delete with the OS
      // trash API, which a host process does not have (see `session-files.ts`).
      "session.delete": async (params) =>
        resolveListedSession(await deps.listSessions(), asRecord(params).sessionFile),
      // A stored-but-closed session can still be renamed: the host opens it with
      // `SessionManager` and appends a `session_info` entry (the SDK's own path).
      "session.rename": async (params) => {
        const input = asRecord(params);
        const { path } = resolveListedSession(await deps.listSessions(), input.sessionFile);
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (name.length === 0) throw new SessionFileError("session.rename requires a name");
        if (!deps.renameSession) {
          throw new SessionFileError(
            "renaming a stored session is not supported by this host",
            "unsupported",
          );
        }
        return deps.renameSession(path, name);
      },
      ...createProviderHandlers(() => deps.providers ?? null).handlers(),
      ...createCustomProviderHandlers({
        resolveStore: () => deps.customProviders ?? null,
      }).handlers(),
      ...createProjectHandlers({
        ...(deps.projectInspect ? { inspectProject: deps.projectInspect } : {}),
        ...(deps.trust ? { trust: deps.trust } : {}),
      }).handlers(),
      // The Extensions hub (plan step 13): build a loader on demand so the hub
      // works before (or without) any session tab.
      ...createResourceHandlers({
        inspect: async (requested, { refresh }) => {
          if (!deps.resources) {
            throw new ResourceError(
              "resources.list is not available in this host: no resource inspector is configured",
              "not_implemented",
            );
          }
          const target = requested ?? deps.defaultCwd ?? null;
          const [source, settings] = await Promise.all([
            deps.resources.load(target, { refresh }),
            deps.settings.read(target),
          ]);
          return buildResourcesSnapshot({
            cwd: target,
            scope: "control",
            settings,
            source,
            now: deps.now,
          });
        },
      }).handlers(),
    }),

    dispose: async () => {
      // A failed flush of settings must not block shutdown.
      try {
        await deps.settings.flush(null);
      } catch {
        // Intentionally ignored: the write path already surfaces its own errors.
      }
    },
  };
}
