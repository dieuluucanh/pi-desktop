/**
 * The app's integration record (plan step 19).
 *
 * `app-state.json` is the single writer of the record; this service turns a
 * validated patch into the new state and returns it, so the renderer never has
 * to guess what the store did. It is Electron-free: the store is injected, and
 * the timestamps come from the caller (the wizard's own clock), not this layer.
 *
 * Pi's `settings.json` stays the source of truth for *whether* the Office
 * bridge is installed — the package manager writes that entry. This record only
 * adds what Pi cannot say: that the user consented to the install here, and
 * when setup last completed.
 */

import {
  applyOfficeIntegrationPatch,
  sanitizeIntegrationsState,
  type IntegrationsState,
  type OfficeIntegrationRecord,
} from "../shared/integrations";

export interface IntegrationStoreLike {
  read(): Promise<{ integrations?: unknown }>;
  update(patch: { integrations?: IntegrationsState }): Promise<unknown>;
}

export interface IntegrationsService {
  get(): Promise<IntegrationsState>;
  recordOffice(patch: unknown): Promise<IntegrationsState>;
}

/** Rejects a patch that is not a plain object, so a bad renderer is visible. */
export function parseOfficeIntegrationPatch(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("integrations: a record patch object is required");
  }
  return value as Record<string, unknown>;
}

export function createIntegrationsService(deps: {
  store: IntegrationStoreLike;
}): IntegrationsService {
  const read = async (): Promise<IntegrationsState> => {
    const current = await deps.store.read();
    return sanitizeIntegrationsState(current.integrations);
  };

  return {
    get: read,
    recordOffice: async (patch) => {
      const parsed = parseOfficeIntegrationPatch(patch);
      const current = await read();
      const office: OfficeIntegrationRecord = applyOfficeIntegrationPatch(current.office, parsed);
      const next: IntegrationsState = { office };
      await deps.store.update({ integrations: next });
      return next;
    },
  };
}
