import { describe, expect, it } from "vitest";
import {
  createOfficeBridgeControl,
  type OfficeBridgeControlDeps,
} from "../../src/main/office/bridge-control";
import {
  emptyOfficeDocumentsView,
  type OfficeBridgeOwner,
  type OfficeDocumentsView,
} from "../../src/shared/office-documents";

const PORT = 38617;

const owner = (sessionId: string | null, overrides: Partial<OfficeBridgeOwner> = {}) => ({
  pid: 4242,
  sessionId,
  client: sessionId === null ? ("cli" as const) : ("desktop" as const),
  cwd: "/work/app",
  ...overrides,
});

function view(overrides: Partial<OfficeDocumentsView> = {}): OfficeDocumentsView {
  return {
    ...emptyOfficeDocumentsView(PORT),
    available: true,
    status: "ok",
    manualLifecycle: true,
    ...overrides,
  };
}

function off(): OfficeDocumentsView {
  return { ...emptyOfficeDocumentsView(PORT), available: false, status: "unreachable" };
}

function scriptedProbe(views: OfficeDocumentsView[]): {
  probe: () => Promise<OfficeDocumentsView>;
  count: () => number;
} {
  let index = 0;
  return {
    probe: async () => {
      const next = views[Math.min(index, views.length - 1)] ?? off();
      index += 1;
      return next;
    },
    count: () => index,
  };
}

function makeDeps(
  views: OfficeDocumentsView[],
  options: {
    commandResults?: unknown[];
    release?: OfficeBridgeControlDeps["releasePort"];
    timeoutMs?: number;
    now?: () => number;
  } = {},
): {
  deps: OfficeBridgeControlDeps;
  calls: { tabId: string; args: string }[];
  releases: number;
  probes: () => number;
} {
  const probe = scriptedProbe(views);
  const calls: { tabId: string; args: string }[] = [];
  const results = [...(options.commandResults ?? [])];
  let releases = 0;
  const deps: OfficeBridgeControlDeps = {
    tabs: () => [
      { id: "tab-1", kind: "session", status: "idle" },
      { id: "tab-2", kind: "session", status: "idle" },
      { id: "office-1", kind: "office", status: "idle" },
      { id: "web-1", kind: "web", status: "idle" },
    ],
    probe: probe.probe,
    request: async (tabId, _method, params) => {
      const args = (params as { args?: string }).args ?? "";
      calls.push({ tabId, args });
      return results.shift() ?? { ran: true };
    },
    sleep: async () => undefined,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.release
      ? {
          releasePort: async (input) => {
            releases += 1;
            return options.release!(input);
          },
        }
      : {}),
    ownPids: () => [1, 2],
  };
  return {
    deps,
    calls,
    get releases() {
      return releases;
    },
    probes: probe.count,
  };
}

describe("createOfficeBridgeControl.connect", () => {
  it("connects an off bridge in the requested tab", async () => {
    const deps = makeDeps([off(), view({ owner: owner("tab-1") })]);
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.connect("tab-1");

    expect(result).toEqual({
      ok: true,
      reason: "connected",
      owner: owner("tab-1"),
    });
    expect(deps.calls).toEqual([{ tabId: "tab-1", args: `connect ${PORT}` }]);
  });

  it("is idempotent when this tab already owns the bridge", async () => {
    const deps = makeDeps([view({ owner: owner("tab-1") })]);
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.connect("tab-1");

    expect(result.reason).toBe("already-connected");
    expect(deps.calls).toEqual([]);
  });

  it("closes another app tab before connecting this one", async () => {
    const deps = makeDeps([
      view({ owner: owner("office-1") }),
      off(),
      view({ owner: owner("tab-2") }),
    ]);
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.connect("tab-2");

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("connected");
    expect(result.owner?.sessionId).toBe("tab-2");
    expect(deps.calls).toEqual([
      { tabId: "office-1", args: "close" },
      { tabId: "tab-2", args: `connect ${PORT}` },
    ]);
  });

  it("reports an external owner without taking it over by default", async () => {
    const deps = makeDeps([view({ owner: owner(null) })]);
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.connect("tab-1");

    expect(result).toMatchObject({
      ok: false,
      reason: "port-busy",
      canTakeover: false,
    });
    expect(result.message).toMatch(/terminal Pi session/);
    expect(deps.calls).toEqual([]);
  });

  it("takes over an external owner only when asked", async () => {
    const deps = makeDeps([view({ owner: owner(null) }), off(), view({ owner: owner("tab-1") })], {
      release: async () => ({ ok: true }),
    });
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.connect("tab-1", { takeover: true });

    expect(result.ok).toBe(true);
    expect(deps.releases).toBe(1);
    expect(deps.calls).toEqual([{ tabId: "tab-1", args: `connect ${PORT}` }]);
  });

  it("surfaces a failed takeover instead of connecting", async () => {
    const deps = makeDeps([view({ owner: owner(null) })], {
      release: async () => ({ ok: false, detail: "PID 99 refused to exit" }),
    });
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.connect("tab-1", { takeover: true });

    expect(result).toMatchObject({ ok: false, reason: "port-busy", canTakeover: true });
    expect(result.message).toBe("PID 99 refused to exit");
    expect(deps.calls).toEqual([]);
  });

  it("refuses to control a legacy auto-start bridge", async () => {
    const deps = makeDeps([view({ owner: owner("office-1"), manualLifecycle: false })]);
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.connect("tab-1");

    expect(result.reason).toBe("legacy-bridge");
    expect(result.message).toMatch(/Update it/);
    expect(deps.calls).toEqual([]);
  });

  it("reports a bridge too old to know the connect command", async () => {
    const deps = makeDeps([off()], { commandResults: [{ ran: false }] });
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.connect("tab-1");

    expect(result).toMatchObject({ ok: false, reason: "command-missing" });
  });

  it("surfaces the exact command error from the host", async () => {
    const deps = makeDeps([off()], {
      commandResults: [{ ran: true, error: "port 38617 is already in use" }],
    });
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.connect("tab-1");

    expect(result).toMatchObject({
      ok: false,
      reason: "failed",
      message: "port 38617 is already in use",
    });
  });

  it("times out when the command succeeds but the bridge never answers", async () => {
    let clock = 0;
    const deps = makeDeps([off()], {
      timeoutMs: 100,
      now: () => {
        clock += 40;
        return clock;
      },
    });
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.connect("tab-1");

    expect(result.reason).toBe("timeout");
    expect(result.message).toMatch(/older than 0\.6/);
  });

  it("rejects a web tab and an unknown tab", async () => {
    const deps = makeDeps([off()]);
    const control = createOfficeBridgeControl(deps.deps);

    expect((await control.connect("web-1")).reason).toBe("bad-tab");
    expect((await control.connect("nope")).reason).toBe("bad-tab");
  });
});

describe("createOfficeBridgeControl.close", () => {
  it("closes the bridge only when this tab owns it", async () => {
    const deps = makeDeps([view({ owner: owner("tab-1") }), off()]);
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.close("tab-1");

    expect(result).toMatchObject({ ok: true, reason: "closed", owner: null });
    expect(deps.calls).toEqual([{ tabId: "tab-1", args: "close" }]);
  });

  it("refuses to close another tab's bridge", async () => {
    const deps = makeDeps([view({ owner: owner("office-1") })]);
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.close("tab-1");

    expect(result.reason).toBe("wrong-owner");
    expect(deps.calls).toEqual([]);
  });

  it("treats an off bridge as already closed", async () => {
    const deps = makeDeps([off()]);
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.close("tab-1");

    expect(result).toEqual({ ok: true, reason: "not-connected" });
    expect(deps.calls).toEqual([]);
  });

  it("refuses to close a legacy bridge it cannot control", async () => {
    const deps = makeDeps([view({ owner: owner("office-1"), manualLifecycle: false })]);
    const control = createOfficeBridgeControl(deps.deps);

    expect((await control.close("office-1")).reason).toBe("legacy-bridge");
    expect(deps.calls).toEqual([]);
  });
});

describe("createOfficeBridgeControl.restart", () => {
  it("closes the owner and reconnects the same tab", async () => {
    const deps = makeDeps([
      view({ owner: owner("tab-1") }),
      off(),
      // `connect` probes once before running the command, then again while
      // waiting for the new owner.
      off(),
      view({ owner: owner("tab-1") }),
    ]);
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.restart("tab-1");

    expect(result.reason).toBe("connected");
    expect(deps.calls).toEqual([
      { tabId: "tab-1", args: "close" },
      { tabId: "tab-1", args: `connect ${PORT}` },
    ]);
  });

  it("connects when the bridge is already off", async () => {
    const deps = makeDeps([off(), off(), view({ owner: owner("tab-1") })]);
    const control = createOfficeBridgeControl(deps.deps);

    const result = await control.restart("tab-1");

    expect(result.reason).toBe("connected");
    expect(deps.calls).toEqual([{ tabId: "tab-1", args: `connect ${PORT}` }]);
  });
});
