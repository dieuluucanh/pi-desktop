import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CONTRIBUTION_EVENTS, createContributionHost } from "../../src/host/contributions";
import { createSessionHostBridge } from "../../src/host/related-sessions";
import { createSdkContributionBridge } from "../../src/host/sdk/contributions";
import {
  RELATED_SESSION_CHANNELS,
  RELATED_SESSION_VERSION,
  type RelatedSessionCapabilities,
  type RelatedSessionResult,
} from "../../src/shared/related-sessions";
import {
  parseContributionEnvelope,
  type Contribution,
  type ContributionEnvelope,
} from "../../src/shared/extension-contributions";

/**
 * Generic end-to-end contract coverage (orchestrator step 46).
 *
 * Two unrelated fixture extensions use arbitrary mode names. The Desktop host
 * must render both from the generic contract, keep their registries separate,
 * refuse cross-owner actions, and resolve related-session ownership from the
 * registered command source — never from a payload's owner string.
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
  };
}

const alphaMode: Contribution = {
  id: "alpha-mode",
  kind: "mode",
  slot: "mode",
  label: "Focus",
  tone: "accent",
  order: 1,
  actions: [],
};

const alphaInput: Contribution = {
  id: "alpha-input",
  kind: "input",
  slot: "input",
  availability: "available",
  tone: "neutral",
  order: 2,
};

const alphaChild: Contribution = {
  id: "alpha-child",
  kind: "related-session",
  slot: "sessions",
  relation: "child",
  sessionRef: "tab-alpha-child",
  title: "Alpha task",
  focusable: true,
  tone: "info",
  order: 3,
};

const alphaAction: Contribution = {
  id: "alpha-action",
  kind: "action",
  slot: "action",
  label: "Run alpha",
  command: { name: "alpha-run" },
  enabled: true,
  tone: "neutral",
  order: 4,
};

const betaMode: Contribution = {
  id: "beta-mode",
  kind: "mode",
  slot: "mode",
  label: "Triage",
  tone: "accent",
  order: 1,
  actions: [],
};

const betaInput: Contribution = {
  id: "beta-input",
  kind: "input",
  slot: "input",
  availability: "locked",
  reason: "waiting for a decision",
  tone: "warning",
  order: 2,
};

const betaAction: Contribution = {
  id: "beta-action",
  kind: "action",
  slot: "action",
  label: "Run beta",
  command: { name: "beta-run" },
  enabled: true,
  tone: "neutral",
  order: 3,
};

function envelope(
  ownerId: string,
  contributions: Contribution[],
  over: Partial<ContributionEnvelope> = {},
): ContributionEnvelope {
  return {
    version: 1,
    owner: { id: ownerId },
    sessionId: "session-a",
    epoch: 0,
    revision: 1,
    removed: [],
    contributions,
    ...over,
  };
}

function contributionHarness() {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const commands: Array<{ name: string; args: string }> = [];
  const known = new Set(["alpha-run", "beta-run"]);
  const host = createContributionHost({
    emit: (event, payload) => emitted.push({ event, payload }),
    runCommand: async (name, args) => {
      if (!known.has(name)) return { ran: false, error: `unknown command ${name}` };
      commands.push({ name, args });
      return { ran: true };
    },
    now: () => 500,
  });
  return { host, emitted, commands, known };
}

function contributionBridge(host: ReturnType<typeof createContributionHost>) {
  const bus = inMemoryBus();
  const bridge = createSdkContributionBridge({ host, bus });
  return { bus, bridge };
}

const RELATED_CAPABILITIES: RelatedSessionCapabilities = {
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

function relatedHarness(over: Partial<RelatedSessionCapabilities> = {}) {
  const bus = inMemoryBus();
  const clock = fakeClock();
  const forwarded: Array<{ request: unknown; owner: { key: string; label?: string } }> = [];
  // The host mints grants; a request without one is never forwarded.
  const issued = new Set<string>();
  const GRANT = {
    token: "grant-alpha",
    ownerCommand: "fixture-alpha",
    sessionId: "session-1",
    epoch: 2,
  };
  issued.add(GRANT.token);
  const bridge = createSessionHostBridge({
    bus,
    clock,
    capabilities: () => ({ ...RELATED_CAPABILITIES, ...over }),
    resolveOwner: (name) =>
      name === "fixture-alpha" ? { key: "C:/ext/alpha/index.ts", label: "fixture.alpha" } : null,
    grants: {
      accept: ({ raw, ownerCommand, sessionId, epoch }) => {
        const grant = raw as
          | { token?: unknown; ownerCommand?: unknown; sessionId?: unknown; epoch?: unknown }
          | undefined;
        const token = grant?.token;
        if (typeof token !== "string" || !issued.has(token)) {
          return { ok: false, error: "the capability grant was not issued by this host" };
        }
        // Mirror the host: the token's own claims must match the record and the
        // live request, so it cannot be re-labelled.
        if (grant?.ownerCommand !== GRANT.ownerCommand || ownerCommand !== GRANT.ownerCommand) {
          return { ok: false, error: "the capability grant belongs to another extension" };
        }
        if (grant?.sessionId !== GRANT.sessionId || sessionId !== GRANT.sessionId) {
          return { ok: false, error: "the capability grant belongs to another session" };
        }
        if (grant?.epoch !== GRANT.epoch || epoch !== GRANT.epoch) {
          return { ok: false, error: "the capability grant is from a previous host epoch" };
        }
        return { ok: true };
      },
    },
    sessionId: () => GRANT.sessionId,
    epoch: () => GRANT.epoch,
    forward: (request, owner) => forwarded.push({ request, owner }),
  });
  const results = (): Array<{ requestId: string; result: RelatedSessionResult }> =>
    bus.sent
      .filter((entry) => entry.channel === RELATED_SESSION_CHANNELS.result)
      .map((entry) => entry.payload as { requestId: string; result: RelatedSessionResult });
  return { bus, clock, forwarded, bridge, results, grant: GRANT };
}

function relatedRequest(over: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    operation: "create",
    ownerCommand: "fixture-alpha",
    grant: {
      token: "grant-alpha",
      ownerCommand: "fixture-alpha",
      sessionId: "session-1",
      epoch: 2,
    },
    spec: {
      requestId: "req-1",
      parentSessionRef: "session-parent",
      relation: "child",
      title: "Alpha task",
      cwd: "C:/work/app",
      dedupeKey: "alpha-task",
      bootstrap: [
        { customType: "workflow-managed-session", content: "{}", display: false },
        { customType: "workflow-task-assignment", content: "{}", display: false },
      ],
    },
    ...over,
  };
}

describe("generic extension contract: two unrelated fixtures", () => {
  it("renders both arbitrary modes, input availability and child navigation", () => {
    const { host } = contributionHarness();
    const { bus, bridge } = contributionBridge(host);
    bridge.announce();

    bus.emit(
      CONTRIBUTION_EVENTS.update,
      envelope("fixture.alpha", [alphaMode, alphaInput, alphaChild, alphaAction]),
    );
    bus.emit(
      CONTRIBUTION_EVENTS.update,
      envelope("fixture.beta", [betaMode, betaInput, betaAction]),
    );

    const snapshot = host.snapshot();
    expect(snapshot.supported).toBe(true);
    expect(snapshot.owners.map((owner) => owner.ownerId)).toEqual([
      "fixture.alpha",
      "fixture.beta",
    ]);
    const modes = snapshot.contributions
      .filter((entry) => entry.kind === "mode")
      .map((entry) => entry.text);
    expect(modes).toEqual(["Focus", "Triage"]);
    expect(snapshot.contributions.find((entry) => entry.id === "alpha-input")).toMatchObject({
      availability: "available",
    });
    expect(snapshot.contributions.find((entry) => entry.id === "beta-input")).toMatchObject({
      availability: "locked",
    });
    expect(snapshot.contributions.find((entry) => entry.id === "alpha-child")).toMatchObject({
      relation: "child",
      sessionRef: "tab-alpha-child",
      focusable: true,
    });
  });

  it("keeps owner registries separate and refuses cross-owner actions", async () => {
    const { host, commands } = contributionHarness();
    host.receive(envelope("fixture.alpha", [alphaMode, alphaAction]));
    host.receive(envelope("fixture.beta", [betaMode, betaAction]));

    // Beta cannot remove Alpha's row: removals are scoped to the publisher.
    host.receive(envelope("fixture.beta", [betaMode], { revision: 2, removed: ["alpha-mode"] }));
    expect(host.snapshot().contributions.some((entry) => entry.id === "alpha-mode")).toBe(true);

    expect(await host.runAction("fixture.beta", "alpha-action")).toMatchObject({ ran: false });
    expect(commands).toHaveLength(0);
    expect(await host.runAction("fixture.alpha", "alpha-action")).toEqual({ ran: true });
    expect(commands).toEqual([{ name: "alpha-run", args: "" }]);
  });

  it("runs only registered host commands and refuses disabled actions", async () => {
    const { host, commands } = contributionHarness();
    host.receive(
      envelope("fixture.alpha", [
        {
          ...alphaAction,
          id: "unknown-command",
          command: { name: "not-registered" },
        },
        {
          ...alphaAction,
          id: "disabled",
          enabled: false,
          disabledReason: "not yet",
        },
      ]),
    );
    expect(await host.runAction("fixture.alpha", "unknown-command")).toMatchObject({ ran: false });
    expect(await host.runAction("fixture.alpha", "disabled")).toEqual({
      ran: false,
      error: "not yet",
    });
    expect(commands).toHaveLength(0);
  });

  it("a stale epoch is rejected and a newer epoch starts that owner clean", () => {
    const { host } = contributionHarness();
    host.receive(envelope("fixture.alpha", [alphaMode, alphaAction], { revision: 3 }));
    host.receive(
      envelope("fixture.alpha", [betaMode], { epoch: 1, revision: 1, removed: ["alpha-mode"] }),
    );
    const after = host.snapshot();
    expect(after.owners).toEqual([{ ownerId: "fixture.alpha", revision: 1, epoch: 1 }]);
    expect(after.contributions.map((entry) => entry.id)).toEqual(["beta-mode"]);

    // A late publish from the old epoch must not resurrect the old row.
    expect(
      host.receive(envelope("fixture.alpha", [alphaMode], { epoch: 0, revision: 9 })),
    ).toMatchObject({
      accepted: false,
    });
    expect(host.snapshot().contributions.map((entry) => entry.id)).toEqual(["beta-mode"]);
  });

  it("reload clears every owner and leaves no actionable stale button", async () => {
    const { host } = contributionHarness();
    host.receive(envelope("fixture.alpha", [alphaMode, alphaAction]));
    expect(host.snapshot().contributions.length).toBeGreaterThan(0);
    host.reset();
    expect(host.snapshot().contributions).toEqual([]);
    expect(await host.runAction("fixture.alpha", "alpha-action")).toMatchObject({ ran: false });
  });
});

describe("shared two-extension fixture", () => {
  it("reads the same fixture the publisher repo ships", () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, "..", "fixtures", "two-extension-contract.json"), "utf8"),
    ) as {
      version: number;
      extensions: Array<{ name: string; envelope: unknown }>;
      expect: { ownerIds: string[]; modes: string[]; inputAvailability: string[] };
    };
    expect(fixture.version).toBe(1);
    const { host } = contributionHarness();
    const ownerIds: string[] = [];
    for (const extension of fixture.extensions) {
      const parsed = parseContributionEnvelope(extension.envelope);
      expect(parsed.ok, extension.name).toBe(true);
      if (!parsed.ok) continue;
      ownerIds.push(parsed.value.envelope.owner.id);
      expect(host.receive(extension.envelope)).toMatchObject({ accepted: true });
    }
    const snapshot = host.snapshot();
    expect(ownerIds).toEqual(fixture.expect.ownerIds);
    expect(
      snapshot.contributions.filter((entry) => entry.kind === "mode").map((entry) => entry.text),
    ).toEqual(fixture.expect.modes);
    expect(
      snapshot.contributions
        .filter((entry) => entry.kind === "input")
        .map((entry) => entry.availability),
    ).toEqual(fixture.expect.inputAvailability);
  });
});

describe("generic related-session contract", () => {
  it("forwards a source-bound create and replays a duplicate instead of creating twice", async () => {
    const h = relatedHarness();
    h.bus.emit(RELATED_SESSION_CHANNELS.request, relatedRequest());

    expect(h.forwarded).toHaveLength(1);
    expect(h.forwarded[0]?.owner).toEqual({
      key: "C:/ext/alpha/index.ts",
      label: "fixture.alpha",
    });

    h.bridge.settle({
      requestId: "req-1",
      result: { ok: true, sessionRef: "tab-child", focused: true, reused: false, running: false },
    });
    expect(h.results().at(-1)).toEqual({
      requestId: "req-1",
      result: { ok: true, sessionRef: "tab-child", focused: true, reused: false, running: false },
    });

    // A lost-result retry replays the settled answer; main is not asked again.
    h.bus.emit(RELATED_SESSION_CHANNELS.request, relatedRequest());
    expect(h.forwarded).toHaveLength(1);
    expect(h.results()).toHaveLength(2);
    expect(h.results().at(-1)?.result).toEqual({
      ok: true,
      sessionRef: "tab-child",
      focused: true,
      reused: false,
      running: false,
    });
  });

  it("rejects a forged owner command and an absent capability before work starts", () => {
    const h = relatedHarness();
    h.bus.emit(
      RELATED_SESSION_CHANNELS.request,
      relatedRequest({ requestId: "req-forged", ownerCommand: "fixture-beta" }),
    );
    expect(h.forwarded).toHaveLength(0);
    expect(h.results().at(-1)?.result).toMatchObject({
      ok: false,
      code: "rejected",
    });

    const noInspect = relatedHarness({ inspect: false });
    noInspect.bus.emit(
      RELATED_SESSION_CHANNELS.request,
      relatedRequest({ requestId: "req-inspect", operation: "inspect", sessionRef: "tab-child" }),
    );
    expect(noInspect.forwarded).toHaveLength(0);
    expect(noInspect.results().at(-1)?.result).toMatchObject({
      ok: false,
      code: "unsupported",
    });

    const unbound = relatedHarness({ sourceBound: false });
    unbound.bus.emit(
      RELATED_SESSION_CHANNELS.request,
      relatedRequest({ requestId: "req-unbound" }),
    );
    expect(unbound.forwarded).toHaveLength(0);
    expect(unbound.results().at(-1)?.result).toMatchObject({
      ok: false,
      code: "unsupported",
    });
  });

  it("a timeout and a teardown settle without creating a second child", () => {
    const h = relatedHarness();
    h.bus.emit(RELATED_SESSION_CHANNELS.request, relatedRequest());
    expect(h.forwarded).toHaveLength(1);
    h.clock.advance(20_000);
    expect(h.results().at(-1)?.result).toMatchObject({ ok: false, code: "failed" });

    // The timeout is remembered; a retry replays it instead of forwarding.
    h.bus.emit(RELATED_SESSION_CHANNELS.request, relatedRequest());
    expect(h.forwarded).toHaveLength(1);

    const torn = relatedHarness({ create: true });
    torn.bus.emit(RELATED_SESSION_CHANNELS.request, relatedRequest());
    torn.bridge.dispose();
    expect(torn.results().at(-1)?.result).toMatchObject({ ok: false, code: "cancelled" });
    expect(torn.forwarded).toHaveLength(1);
  });

  it("settle rejects a malformed result and never trusts an owner in the payload", () => {
    const h = relatedHarness();
    h.bus.emit(
      RELATED_SESSION_CHANNELS.request,
      relatedRequest({
        ownerKey: "C:/evil/index.ts",
        ownerLabel: "evil",
      }),
    );
    expect(h.forwarded).toHaveLength(1);
    expect(h.forwarded[0]?.owner.key).toBe("C:/ext/alpha/index.ts");

    expect(
      h.bridge.settle({ requestId: "req-1", result: { ok: true, sessionRef: "" } }),
    ).toMatchObject({
      accepted: false,
    });
    expect(h.results()).toHaveLength(0);
  });
});

describe("related sessions: the grant, not the command name, is the authority", () => {
  it("refuses a request with no grant even when the command really exists", async () => {
    const h = relatedHarness();
    const request = relatedRequest();
    delete (request as { grant?: unknown }).grant;
    h.bus.emit(RELATED_SESSION_CHANNELS.request, request);
    expect(h.forwarded).toHaveLength(0);
    const [settled] = h.results();
    expect(settled?.result.ok).toBe(false);
    expect((settled?.result as { reason?: string }).reason).toMatch(/capability grant/);
  });

  it("refuses a grant minted for another extension", async () => {
    const h = relatedHarness();
    h.bus.emit(
      RELATED_SESSION_CHANNELS.request,
      relatedRequest({
        requestId: "req-foreign",
        // Same registered command, but the grant itself names another owner.
        grant: {
          token: "grant-alpha",
          ownerCommand: "fixture-beta",
          sessionId: "session-1",
          epoch: 2,
        },
      }),
    );
    expect(h.forwarded).toHaveLength(0);
    const [settled] = h.results();
    expect((settled?.result as { reason?: string }).reason).toMatch(/another extension/);
  });

  it("refuses a stale host epoch", async () => {
    const h = relatedHarness();
    h.bus.emit(
      RELATED_SESSION_CHANNELS.request,
      relatedRequest({
        requestId: "req-epoch",
        grant: {
          token: "grant-alpha",
          ownerCommand: "fixture-alpha",
          sessionId: "session-1",
          epoch: 1,
        },
      }),
    );
    expect(h.forwarded).toHaveLength(0);
    const [settled] = h.results();
    expect((settled?.result as { reason?: string }).reason).toMatch(/previous host epoch/);
  });
});
