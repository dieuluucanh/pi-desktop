import { describe, expect, it, vi } from "vitest";
import {
  createIntegrationsService,
  parseOfficeIntegrationPatch,
  type IntegrationStoreLike,
} from "../../src/main/integrations-service";
import type { IntegrationsState } from "../../src/shared/integrations";

/**
 * The app's integration record (plan step 19). The service is the only writer of
 * `app-state.json#integrations`, and it must be impossible for a renderer to
 * smuggle an unknown key (or a non-timestamp) into the store.
 */

function memoryStore(initial: Partial<IntegrationsState> = {}): {
  store: IntegrationStoreLike;
  state: { integrations?: unknown };
  updates: number;
} {
  const state: { integrations?: unknown } = { integrations: { ...initial } };
  let updates = 0;
  return {
    state,
    get updates() {
      return updates;
    },
    store: {
      read: async () => ({ ...state }),
      update: async (patch) => {
        updates += 1;
        if (patch.integrations !== undefined) state.integrations = patch.integrations;
        return state;
      },
    },
  };
}

describe("parseOfficeIntegrationPatch", () => {
  it("accepts a plain object and rejects everything else", () => {
    expect(parseOfficeIntegrationPatch({ bridgeInstalledAt: "x" })).toEqual({
      bridgeInstalledAt: "x",
    });
    expect(() => parseOfficeIntegrationPatch(null)).toThrow(/patch object/);
    expect(() => parseOfficeIntegrationPatch([])).toThrow(/patch object/);
    expect(() => parseOfficeIntegrationPatch("nope")).toThrow(/patch object/);
  });
});

describe("createIntegrationsService", () => {
  it("returns an empty record for a store that has none", async () => {
    const { store } = memoryStore();
    const service = createIntegrationsService({ store });
    expect(await service.get()).toEqual({
      office: { bridgeInstalledAt: null, lastSetupAt: null },
    });
  });

  it("records a consented install and returns the new state", async () => {
    const memory = memoryStore();
    const service = createIntegrationsService({ store: memory.store });

    const next = await service.recordOffice({ bridgeInstalledAt: "2026-09-20T10:00:00.000Z" });

    expect(next.office.bridgeInstalledAt).toBe("2026-09-20T10:00:00.000Z");
    expect(next.office.lastSetupAt).toBeNull();
    expect(memory.updates).toBe(1);
    expect(memory.state.integrations).toEqual(next);
  });

  it("keeps the other timestamp when only one is patched", async () => {
    const memory = memoryStore({
      office: { bridgeInstalledAt: "2026-09-20T10:00:00.000Z", lastSetupAt: null },
    });
    const service = createIntegrationsService({ store: memory.store });

    const next = await service.recordOffice({ lastSetupAt: "2026-09-20T11:00:00.000Z" });

    expect(next.office).toEqual({
      bridgeInstalledAt: "2026-09-20T10:00:00.000Z",
      lastSetupAt: "2026-09-20T11:00:00.000Z",
    });
  });

  it("drops unknown keys and invalid timestamps instead of persisting them", async () => {
    const memory = memoryStore();
    const service = createIntegrationsService({ store: memory.store });

    const next = await service.recordOffice({
      bridgeInstalledAt: "not a date",
      lastSetupAt: "2026-09-20T11:00:00.000Z",
      somethingElse: "ignored",
    });

    expect(next.office.bridgeInstalledAt).toBeNull();
    expect(next.office.lastSetupAt).toBe("2026-09-20T11:00:00.000Z");
    expect(Object.keys(next.office).sort()).toEqual(["bridgeInstalledAt", "lastSetupAt"]);
  });

  it("refuses a non-object patch before touching the store", async () => {
    const memory = memoryStore();
    const update = vi.spyOn(memory.store, "update");
    const service = createIntegrationsService({ store: memory.store });

    await expect(service.recordOffice("nope")).rejects.toThrow(/patch object/);
    expect(update).not.toHaveBeenCalled();
  });
});
