import { describe, expect, it } from "vitest";
import { createSessionHostBridge } from "../../src/host/related-sessions";
import {
  RELATED_SESSION_CHANNELS,
  RELATED_SESSION_VERSION,
  type RelatedSessionCapabilities,
  type RelatedSessionResult,
} from "../../src/shared/related-sessions";

/**
 * Host-side related-session bridge (orchestrator step 12). The bus is
 * anonymous, so ownership comes from a registered command's source info; a
 * request without one never reaches main. Retries and timeouts must not create
 * a second child.
 */

function inMemoryBus() {
  const listeners = new Map<string, Array<(payload: unknown) => unknown>>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    on(channel: string, handler: (payload: unknown) => unknown) {
      const list = listeners.get(channel) ?? [];
      list.push(handler);
      listeners.set(channel, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    emit(channel: string, payload?: unknown) {
      sent.push({ channel, payload });
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
    },
  };
}

function fakeClock() {
  let now = 1_000;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let next = 1;
  return {
    now: () => now,
    setTimeout(callback: () => void, ms: number) {
      const id = next++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(handle: number | object) {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pending: () => timers.size,
  };
}

const CAPS: RelatedSessionCapabilities = {
  version: RELATED_SESSION_VERSION,
  create: true,
  open: true,
  focus: true,
  inspect: true,
  interrupt: true,
  close: true,
  separateWindow: true,
  bootstrapBeforeStart: true,
  sourceBound: true,
  label: "Pi Desktop",
};

function spec() {
  return {
    requestId: "req-1",
    parentSessionRef: "parent",
    relation: "child" as const,
    title: "Task 2",
    cwd: "C:/work/app",
    dedupeKey: "task-2",
    bootstrap: [{ customType: "workflow-managed-session" as const, content: "{}", display: false }],
  };
}

function request(over: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    operation: "create",
    ownerCommand: "workflow",
    spec: spec(),
    // Host-issued capability grant: the bus is anonymous, so a command name
    // alone is not authority.
    grant: { token: "grant-1", ownerCommand: "workflow", sessionId: "session-1", epoch: 1 },
    ...over,
  };
}

function harness(over: { capabilities?: Partial<RelatedSessionCapabilities> } = {}) {
  const bus = inMemoryBus();
  const clock = fakeClock();
  const forwarded: Array<{ request: unknown; owner: { key: string } }> = [];
  const bridge = createSessionHostBridge({
    bus,
    clock,
    capabilities: () => ({ ...CAPS, ...over.capabilities }),
    resolveOwner: (name) =>
      name === "workflow" ? { key: "C:/ext/workflow/index.ts", label: "@dieulc/workflow" } : null,
    sessionId: () => "session-1",
    epoch: () => 1,
    grants: {
      accept: ({ raw, ownerCommand, sessionId, epoch }) => {
        const grant = raw as Record<string, unknown> | undefined;
        if (!grant || typeof grant.token !== "string") {
          return { ok: false, error: "the request has no capability grant" };
        }
        if (grant.ownerCommand !== ownerCommand) {
          return { ok: false, error: "the capability grant belongs to another extension" };
        }
        if (grant.sessionId !== sessionId) {
          return { ok: false, error: "the capability grant belongs to another session" };
        }
        if (grant.epoch !== epoch) {
          return { ok: false, error: "the capability grant is from a previous host epoch" };
        }
        return { ok: true };
      },
    },
    forward: (request, owner) => forwarded.push({ request, owner }),
  });
  const results = (): Array<{ requestId: string; result: RelatedSessionResult }> =>
    bus.sent
      .filter((entry) => entry.channel === RELATED_SESSION_CHANNELS.result)
      .map((entry) => entry.payload as { requestId: string; result: RelatedSessionResult });
  return { bus, clock, forwarded, bridge, results };
}

describe("related-session host bridge", () => {
  it("announces capabilities on bind and on probe", () => {
    const h = harness();
    h.bridge.announce();
    h.bus.emit(RELATED_SESSION_CHANNELS.probe, {});

    const hellos = h.bus.sent.filter((entry) => entry.channel === RELATED_SESSION_CHANNELS.hello);
    expect(hellos).toHaveLength(2);
    expect(hellos[0]?.payload).toMatchObject({ label: "Pi Desktop", sourceBound: true });
  });

  it("forwards a valid create and settles it with main's answer", () => {
    const h = harness();
    h.bus.emit(RELATED_SESSION_CHANNELS.request, request());

    expect(h.forwarded).toHaveLength(1);
    expect(h.forwarded[0]?.owner).toEqual({
      key: "C:/ext/workflow/index.ts",
      label: "@dieulc/workflow",
    });
    expect(h.results()).toHaveLength(0);

    expect(
      h.bridge.settle({
        requestId: "req-1",
        result: { ok: true, sessionRef: "tab-child", focused: true, reused: false },
      }),
    ).toEqual({ accepted: true });
    expect(h.results()).toEqual([
      {
        requestId: "req-1",
        result: { ok: true, sessionRef: "tab-child", focused: true, reused: false },
      },
    ]);
    expect(h.clock.pending()).toBe(0);
  });

  it("rejects an owner command the host cannot resolve", () => {
    const h = harness();
    h.bus.emit(RELATED_SESSION_CHANNELS.request, request({ ownerCommand: "not-registered" }));

    expect(h.forwarded).toHaveLength(0);
    expect(h.results()[0]?.result).toMatchObject({ ok: false, code: "rejected" });
  });

  it("fails closed when the host cannot derive source ownership", () => {
    const h = harness({ capabilities: { sourceBound: false } });
    h.bus.emit(RELATED_SESSION_CHANNELS.request, request());

    expect(h.forwarded).toHaveLength(0);
    expect(h.results()[0]?.result).toMatchObject({ ok: false, code: "unsupported" });
  });

  it("refuses an operation the host does not advertise", () => {
    const h = harness({ capabilities: { interrupt: false } });
    h.bus.emit(
      RELATED_SESSION_CHANNELS.request,
      request({
        requestId: "req-x",
        operation: "interrupt",
        spec: undefined,
        sessionRef: "tab-child",
      }),
    );

    expect(h.forwarded).toHaveLength(0);
    expect(h.results()[0]?.result).toMatchObject({ ok: false, code: "unsupported" });
  });

  it("joins a duplicate pending request and replays a settled result", () => {
    const h = harness();
    h.bus.emit(RELATED_SESSION_CHANNELS.request, request());
    h.bus.emit(RELATED_SESSION_CHANNELS.request, request());
    expect(h.forwarded).toHaveLength(1);

    h.bridge.settle({
      requestId: "req-1",
      result: { ok: true, sessionRef: "tab-child", focused: true, reused: false },
    });
    h.bus.emit(RELATED_SESSION_CHANNELS.request, request());
    expect(h.forwarded).toHaveLength(1);
    expect(h.results()).toHaveLength(2);
  });

  it("times out instead of hanging the extension", () => {
    const h = harness();
    h.bus.emit(RELATED_SESSION_CHANNELS.request, request());
    h.clock.advance(20_000);

    const result = h.results()[0]?.result;
    expect(result).toMatchObject({ ok: false, code: "failed" });
    if (result && !result.ok) expect(result.reason).toMatch(/did not answer/);
  });

  it("cancels pending operations on teardown", () => {
    const h = harness();
    h.bus.emit(RELATED_SESSION_CHANNELS.request, request());
    h.bridge.dispose();

    expect(h.results()[0]?.result).toMatchObject({ ok: false, code: "cancelled" });
    expect(h.clock.pending()).toBe(0);
  });
});
