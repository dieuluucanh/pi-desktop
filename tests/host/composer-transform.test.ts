import { describe, expect, it } from "vitest";

import {
  COMPOSER_CONTROL_KIND,
  COMPOSER_CONTROL_SLOT,
  COMPOSER_TRANSFORM_CONTRACT,
  COMPOSER_TRANSFORM_EVENTS,
  composerRendezvousChannel,
  parseComposerBootstrapArgs,
  parseComposerControlContribution,
  parseComposerGrant,
  type ComposerCommandRegistration,
  type ComposerControlContribution,
  type ComposerGrant,
  type ComposerProjectedAction,
  type ComposerTransformPort,
} from "../../src/shared/composer-transform";
import { HOST_METHODS, isHostMethod } from "../../src/shared/host-protocol";
import {
  COMPOSER_TRANSFORM_METHODS,
  composerTransformHostLimits,
  createComposerTransformHost,
  type ComposerTransformBus,
  type ComposerTransformClock,
  type ComposerTransformControlPort,
} from "../../src/host/composer-transform";
import {
  composerCommandRegistrations,
  createSdkComposerTransformHost,
} from "../../src/host/sdk/composer-transform";
import type { CommandContext, CommandRunner } from "../../src/host/commands";

/**
 * Source-bound composer-transform operation host (prompt-refinement row 14).
 *
 * The bus is anonymous and SDK 1.5 has no structured command registration, so
 * authority comes from live command provenance + a host-minted CSPRNG grant +
 * a single-use private rendezvous. These tests exercise spoofing, foreign
 * provenance, replay/expiry/cancellation and the privacy of the bootstrap.
 */

const OWNER = "alpha.ext";
const DRAFT = "SECRET_DRAFT_SENTINEL please refine this";
const EXPANDED = "SECRET_EXPANDED_SENTINEL expanded paste";
const DIGEST = "SECRET_DIGEST_SENTINEL";
const ATTACHMENT_ID = "sec-attachment-id";
const IMAGE_DATA = Buffer.from("abcdefgh").toString("base64");
const IMAGE_SENTINEL = "SECRET_IMAGE_SENTINEL";

const CONTROL_RAW = {
  id: "alpha-composer",
  kind: COMPOSER_CONTROL_KIND,
  slot: COMPOSER_CONTROL_SLOT,
  tone: "accent",
  order: 1,
  label: "Refine",
  description: "Refine the draft only",
  icon: "sparkles",
  checked: false,
  enabled: true,
  behavior: "one-shot-return",
  actionRef: "alpha-toggle",
  transformActionRef: "alpha-transform",
  operation: {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    publicCommand: "prompt",
    companionCommand: "prompt-companion",
  },
} as const;

const CONTROL = (() => {
  const parsed = parseComposerControlContribution(CONTROL_RAW);
  if (!parsed.ok) throw new Error(`fixture control invalid: ${parsed.error.message}`);
  return parsed.value;
})();

const ACTIONS: ComposerProjectedAction[] = [
  {
    ownerId: OWNER,
    id: "alpha-toggle",
    kind: "action",
    label: "Toggle refinement",
    command: { name: "prompt-toggle" },
  },
  {
    ownerId: OWNER,
    id: "alpha-transform",
    kind: "action",
    label: "Refine",
    command: { name: "prompt" },
  },
];

const SAME_SOURCE: ComposerCommandRegistration[] = [
  {
    name: "prompt",
    sourceInfo: { path: "C:/ext/alpha/index.ts", source: "alpha", scope: "session" },
  },
  {
    name: "prompt-companion",
    sourceInfo: { path: "C:/ext/alpha/index.ts", source: "alpha", scope: "session" },
  },
];

function inMemoryBus() {
  const listeners = new Map<string, Set<(payload: unknown) => unknown>>();
  return {
    on(channel: string, handler: (payload: unknown) => unknown) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) listeners.delete(channel);
      };
    },
    emit(channel: string, payload?: unknown) {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
    },
    count(channel: string) {
      return listeners.get(channel)?.size ?? 0;
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
    clearTimeout(handle: unknown) {
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

function deterministicRandom(seed = 3) {
  let counter = seed;
  return (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) {
      bytes[index] = (counter++ * 31 + 7) & 0xff;
    }
    return bytes;
  };
}

function baseRequest(over: Record<string, unknown> = {}) {
  return {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: "req-alpha-0001",
    ownerId: OWNER,
    controlId: "alpha-composer",
    actionId: "alpha-toggle",
    transformActionId: "alpha-transform",
    contributionRevision: 7,
    binding: {
      sessionId: "session-1",
      epoch: 1,
      bindingId: "binding-alpha",
      hostGeneration: 12,
    },
    snapshot: {
      draftRevision: 4,
      text: DRAFT,
      expandedText: EXPANDED,
      selection: { start: 0, end: DRAFT.length },
      attachments: [
        {
          id: ATTACHMENT_ID,
          digest: DIGEST,
          mimeType: "image/png",
          byteLength: 8,
        },
      ],
      inputState: "idle",
    },
    images: [{ id: ATTACHMENT_ID, mimeType: "image/png", dataBase64: IMAGE_DATA }],
    ...over,
  };
}

function controlPort(over: { missingOwner?: boolean } = {}): ComposerTransformControlPort {
  return {
    resolve({ ownerId, controlId, contributionRevision }) {
      if (over.missingOwner) {
        return { ok: false, error: { code: "foreign-action", message: "no owner" } };
      }
      if (ownerId !== OWNER || controlId !== CONTROL.id) {
        return { ok: false, error: { code: "unresolved-action", message: "no control" } };
      }
      if (contributionRevision !== 7) {
        return { ok: false, error: { code: "stale-revision", message: "stale revision" } };
      }
      return {
        ok: true,
        control: CONTROL as ComposerControlContribution,
        actions: ACTIONS,
      };
    },
  };
}

interface HarnessOptions {
  behavior?: "claim" | "none" | "throw" | "skip";
  registrations?: ComposerCommandRegistration[];
  binding?: () => { sessionId: string | null; epoch: number };
  maxRetained?: number;
  ttlMs?: number;
  randomBytes?: (size: number) => Uint8Array;
  controls?: ComposerTransformControlPort;
}

function harness(options: HarnessOptions = {}) {
  const bus = inMemoryBus();
  const clock = fakeClock();
  const emitted: Array<{ event: string; payload: unknown; sessionId: string | undefined }> = [];
  const logs: string[] = [];
  const invocations: Array<{ name: string; args: string }> = [];
  const ports: ComposerTransformPort[] = [];
  const errors: unknown[] = [];
  const binding = options.binding ?? (() => ({ sessionId: "session-1", epoch: 1 }));
  const registrations = options.registrations ?? SAME_SOURCE;

  const companion = {
    async invoke(name: string, args: string) {
      invocations.push({ name, args });
      if (options.behavior === "skip") return { ran: false, error: "companion not registered" };
      if (options.behavior === "throw") throw new Error("bootstrap handler failed");
      if (options.behavior === "none") return { ran: true };
      const bootstrap = parseComposerBootstrapArgs(args);
      if (!bootstrap.ok) throw new Error(bootstrap.error.message);
      const grant = parseComposerGrant(bootstrap.value.grant);
      if (!grant.ok) throw new Error(grant.error.message);
      bus.emit(composerRendezvousChannel(grant.value.grantId), {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        grantId: grant.value.grantId,
        proof: grant.value.secret,
        accept: (port: ComposerTransformPort) => ports.push(port),
      });
      return { ran: true };
    },
  };

  const host = createComposerTransformHost({
    bus: bus as ComposerTransformBus,
    clock: clock as ComposerTransformClock,
    randomBytes: options.randomBytes ?? deterministicRandom(),
    controls: options.controls ?? controlPort(),
    commands: { list: () => registrations },
    companion,
    binding,
    emit: (event, payload, sessionId) => emitted.push({ event, payload, sessionId }),
    onError: (error) => errors.push(error),
    log: (line) => logs.push(line),
    ttlMs: options.ttlMs,
    maxRetained: options.maxRetained,
  });

  return { host, bus, clock, emitted, logs, invocations, ports, errors, registrations, binding };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function grantFrom(args: string): ComposerGrant {
  const parsed = parseComposerBootstrapArgs(args);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const grant = parseComposerGrant(parsed.value.grant);
  if (!grant.ok) throw new Error(grant.error.message);
  return grant.value;
}

function channelFrom(args: string): string {
  return composerRendezvousChannel(grantFrom(args).grantId);
}

describe("composer-transform host allowlist", () => {
  it("declares the frozen methods plus the additive reconciliation read", () => {
    expect([...COMPOSER_TRANSFORM_METHODS]).toEqual([
      "composer.transform",
      "composer.status",
      "composer.cancel",
      "composer.applied",
      // Additive in v1: a status read only, never a start/apply.
      "composer.current",
    ]);
    for (const method of COMPOSER_TRANSFORM_METHODS) {
      expect(HOST_METHODS).toContain(method);
      expect(isHostMethod(method)).toBe(true);
    }
    const h = harness();
    expect(Object.keys(h.host.handlers()).sort()).toEqual([...COMPOSER_TRANSFORM_METHODS].sort());
    expect(composerTransformHostLimits().maxRetained).toBe(64);
  });
});

describe("source-bound start", () => {
  it("returns a real receipt before the companion work and invokes it once", async () => {
    const h = harness();
    const started = h.host.start(baseRequest());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.status).toBe("started");
    expect(started.value.operationId).toMatch(/^op-[0-9a-f]{32}$/);
    // The receipt is already a real one; the companion has not run yet.
    expect(h.invocations).toHaveLength(0);
    await flush();
    expect(h.invocations).toHaveLength(1);
    expect(h.invocations[0]?.name).toBe("prompt-companion");
    expect(h.ports).toHaveLength(1);
    expect(h.ports[0]?.operation.request.requestId).toBe("req-alpha-0001");
  });

  it("hands over only the grant bootstrap, never the draft", async () => {
    const h = harness();
    expect(h.host.start(baseRequest()).ok).toBe(true);
    await flush();
    const args = h.invocations[0]?.args ?? "";
    const parsed = JSON.parse(args) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["contract", "grant"]);
    expect(args).not.toContain("SECRET_DRAFT_SENTINEL");
    expect(args).not.toContain("SECRET_EXPANDED_SENTINEL");
    expect(args).not.toContain(IMAGE_SENTINEL);
    expect(args).not.toContain(DIGEST);
    expect(parsed.contract).toBe(COMPOSER_TRANSFORM_CONTRACT);
  });

  it("replays an identical request id and refuses a conflicting body", async () => {
    const h = harness();
    const first = h.host.start(baseRequest());
    const second = h.host.start(baseRequest());
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.value).toEqual(first.value);
    await flush();
    expect(h.invocations).toHaveLength(1);

    const changedText = "different draft";
    const collision = h.host.start(
      baseRequest({
        requestId: "req-alpha-0001",
        snapshot: {
          ...baseRequest().snapshot,
          text: changedText,
          expandedText: changedText,
          selection: { start: 0, end: changedText.length },
        },
        images: [],
      }),
    );
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.error.code).toBe("request-conflict");
    expect(h.invocations).toHaveLength(1);
  });

  it("refuses matching-name commands from a foreign extension source", () => {
    const h = harness({
      registrations: [
        SAME_SOURCE[0]!,
        {
          name: "prompt-companion",
          sourceInfo: { path: "C:/ext/beta/index.ts", source: "beta", scope: "session" },
        },
      ],
    });
    const result = h.host.start(baseRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("foreign-companion");
    expect(h.invocations).toHaveLength(0);
  });

  it("refuses commands without live provenance and missing companions", () => {
    const noProvenance = harness({
      registrations: [{ name: "prompt" }, { name: "prompt-companion" }],
    });
    const missing = noProvenance.host.start(baseRequest());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("source-mismatch");

    const noCompanion = harness({ registrations: [SAME_SOURCE[0]!] });
    const absent = noCompanion.host.start(baseRequest());
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.error.code).toBe("missing-command");
  });

  it("refuses a foreign/unknown owner, action or stale revision", () => {
    const h = harness();
    const unknown = h.host.start(baseRequest({ ownerId: "beta.ext" }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("unresolved-action");

    const stale = h.host.start(baseRequest({ contributionRevision: 8 }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("stale-revision");

    const wrongAction = h.host.start(baseRequest({ transformActionId: "alpha-other" }));
    expect(wrongAction.ok).toBe(false);
    if (!wrongAction.ok) expect(wrongAction.error.code).toBe("invalid-reference");
  });

  it("fences the tab/session and host epoch", () => {
    const h = harness();
    const otherSession = h.host.start(
      baseRequest({ binding: { ...baseRequest().binding, sessionId: "session-2" } }),
    );
    expect(otherSession.ok).toBe(false);
    if (!otherSession.ok) expect(otherSession.error.code).toBe("not-owner");

    const staleEpoch = h.host.start(
      baseRequest({ binding: { ...baseRequest().binding, epoch: 0 } }),
    );
    expect(staleEpoch.ok).toBe(false);
    if (!staleEpoch.ok) expect(staleEpoch.error.code).toBe("stale-revision");
  });
});

describe("private rendezvous", () => {
  it("rejects a spoofed proof/owner and never delivers a late claim", async () => {
    const h = harness({ behavior: "none" });
    const started = h.host.start(baseRequest());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await flush();
    const grant = grantFrom(h.invocations[0]!.args);
    const channel = composerRendezvousChannel(grant.grantId);
    let delivered = 0;
    h.bus.emit(channel, {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      grantId: grant.grantId,
      proof: "x".repeat(43),
      ownerId: OWNER,
      accept: () => {
        delivered += 1;
      },
    });
    const status = h.host.status({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
    });
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.state).toBe("failed");
    // The rejected claim disposed the listener: a later correct proof is inert.
    h.bus.emit(channel, {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      grantId: grant.grantId,
      proof: grant.secret,
      accept: () => {
        delivered += 1;
      },
    });
    expect(delivered).toBe(0);
    expect(h.bus.count(channel)).toBe(0);
  });

  it("accepts exactly one claim and cleans the listener up", async () => {
    const h = harness();
    const started = h.host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    const channel = channelFrom(h.invocations[0]!.args);
    expect(h.ports).toHaveLength(1);
    expect(h.bus.count(channel)).toBe(0);
    const granted = grantFrom(h.invocations[0]!.args);
    let delivered = 0;
    h.bus.emit(channel, {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      grantId: granted.grantId,
      proof: granted.secret,
      accept: () => {
        delivered += 1;
      },
    });
    expect(delivered).toBe(0);
  });

  it("fails a bootstrap that never registers and never resends it", async () => {
    const h = harness({ behavior: "skip" });
    const started = h.host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    const status = h.host.status({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
    });
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.state).toBe("failed");
    h.clock.advance(10 * 60_000);
    await flush();
    expect(h.invocations).toHaveLength(1);
  });

  it("fails when the companion handler throws and does not retry", async () => {
    const h = harness({ behavior: "throw" });
    const started = h.host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    const status = h.host.status({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
    });
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.state).toBe("failed");
    h.clock.advance(10 * 60_000);
    await flush();
    expect(h.invocations).toHaveLength(1);
  });

  it("expires an unclaimed grant and ignores a late claim", async () => {
    const h = harness({ behavior: "none", ttlMs: 5_000 });
    const started = h.host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    const grant = grantFrom(h.invocations[0]!.args);
    h.clock.advance(5_000);
    const status = h.host.status({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
    });
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.state).toBe("expired");
    let delivered = 0;
    h.bus.emit(composerRendezvousChannel(grant.grantId), {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      grantId: grant.grantId,
      proof: grant.secret,
      accept: () => {
        delivered += 1;
      },
    });
    expect(delivered).toBe(0);
    expect(h.invocations).toHaveLength(1);
  });
});

describe("operation lifecycle", () => {
  it("reports progress/candidate/applied and survives a lost apply receipt", async () => {
    const h = harness();
    const started = h.host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    const port = h.ports[0]!;
    port.progress({ state: "running", phase: "inspect", at: 2_000 });
    port.candidate({ candidateRevision: 8, text: "refined text", summary: "tightened", at: 3_000 });

    const candidateStatus = h.host.status({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
    });
    expect(candidateStatus.ok).toBe(true);
    if (candidateStatus.ok) {
      expect(candidateStatus.value.state).toBe("candidate");
      expect(candidateStatus.value.revision).toBe(8);
    }
    expect(h.emitted.some((entry) => entry.event === COMPOSER_TRANSFORM_EVENTS.progress)).toBe(
      true,
    );
    expect(h.emitted.some((entry) => entry.event === COMPOSER_TRANSFORM_EVENTS.result)).toBe(true);

    const receipt = {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
      appliedRevision: 8,
      disposition: "replaced",
      appliedAt: 4_000,
    };
    const busApplied: unknown[] = [];
    const unsubscribeBus = h.bus.on(COMPOSER_TRANSFORM_EVENTS.applied, (payload) => {
      busApplied.push(payload);
    });
    const applied = h.host.applied(receipt);
    expect(applied.ok).toBe(true);
    // The publisher owns the one-shot toggle: the applied receipt reaches the
    // shared extension bus so an adapter can disarm itself and republish
    // `checked:false` (a renderer-only frame would leave a reload reading `on`).
    expect(busApplied).toHaveLength(1);
    expect(busApplied[0]).toMatchObject({
      requestId: "req-alpha-0001",
      appliedRevision: 8,
      disposition: "replaced",
    });
    // An idempotent replay never emits a second receipt.
    const appliedAgain = h.host.applied(receipt);
    expect(appliedAgain.ok).toBe(true);
    expect(busApplied).toHaveLength(1);
    unsubscribeBus();
    // A lost acknowledgement is reconciled by status and an idempotent replay.
    const status = h.host.status({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
    });
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.state).toBe("applied");
    expect(h.host.applied(receipt)).toEqual(applied);
    expect(h.emitted.some((entry) => entry.event === COMPOSER_TRANSFORM_EVENTS.applied)).toBe(true);
    expect(h.invocations).toHaveLength(1);
  });

  it("refuses stale or premature applies and non-monotonic candidates", async () => {
    const h = harness();
    const started = h.host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    const port = h.ports[0]!;
    const premature = h.host.applied({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
      appliedRevision: 1,
      disposition: "replaced",
      appliedAt: 2_000,
    });
    expect(premature.ok).toBe(false);
    if (!premature.ok) expect(premature.error.code).toBe("invalid-state");

    port.candidate({ candidateRevision: 8, text: "first", at: 3_000 });
    const stale = h.host.applied({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
      appliedRevision: 7,
      disposition: "replaced",
      appliedAt: 4_000,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("stale-revision");

    port.candidate({ candidateRevision: 8, text: "second", at: 5_000 });
    expect(
      h.errors.some(
        (error) =>
          error instanceof Error && (error as Error & { code?: string }).code === "stale-revision",
      ),
    ).toBe(true);
    const status = h.host.status({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
    });
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.revision).toBe(8);
  });

  it("cancels a claimed operation, aborts its port and reports already-terminal", async () => {
    const h = harness();
    const started = h.host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    const port = h.ports[0]!;
    const channel = channelFrom(h.invocations[0]!.args);
    const cancelled = h.host.cancel({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
      reason: "user cancelled",
    });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) expect(cancelled.value.state).toBe("cancelled");
    expect(port.operation.signal.aborted).toBe(true);
    const again = h.host.cancel({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.state).toBe("already-terminal");
    expect(h.bus.count(channel)).toBe(0);
    expect(h.invocations).toHaveLength(1);
  });

  it("disposes listeners and refuses an unknown operation", async () => {
    const h = harness({ behavior: "none" });
    const started = h.host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    const channel = channelFrom(h.invocations[0]!.args);
    expect(h.bus.count(channel)).toBe(1);
    h.host.dispose();
    expect(h.bus.count(channel)).toBe(0);

    const fresh = harness();
    const unknown = fresh.host.status({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-9999",
      operationId: "op-unknown",
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("expired");
  });

  it("resets every live operation and notes the epoch fence", async () => {
    let epoch = 1;
    const h = harness({ binding: () => ({ sessionId: "session-1", epoch }) });
    const started = h.host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    const channel = channelFrom(h.invocations[0]!.args);
    epoch = 2;
    const fenced = h.host.status({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
    });
    expect(fenced.ok).toBe(false);
    if (!fenced.ok) expect(fenced.error.code).toBe("stale-revision");
    h.host.reset();
    expect(h.bus.count(channel)).toBe(0);
    expect(
      h.host.status({
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req-alpha-0001",
        operationId: started.value.operationId,
      }).ok,
    ).toBe(false);
  });
});

describe("renderer/host lifecycle reconciliation", () => {
  const BINDING = {
    sessionId: "session-1",
    epoch: 1,
    bindingId: "binding-alpha",
    hostGeneration: 12,
  } as const;

  it("answers a bound current read with the live operation, never a terminal one", async () => {
    const h = harness();
    expect(h.host.start(baseRequest()).ok).toBe(true);
    await flush();
    const port = h.ports[0]!;
    port.progress({ state: "running", phase: "inspect", at: 2_000 });

    const current = h.host.current({ contract: COMPOSER_TRANSFORM_CONTRACT, binding: BINDING });
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(current.value.operation?.ownerId).toBe(OWNER);
    expect(current.value.operation?.controlId).toBe("alpha-composer");
    expect(current.value.operation?.state).toBe("running");

    // A stale epoch (a replaced host generation) sees nothing live instead of
    // another tab's operation.
    const stale = h.host.current({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      binding: { ...BINDING, epoch: 2 },
    });
    expect(stale.ok).toBe(true);
    if (stale.ok) expect(stale.value.operation).toBe(null);

    // A finished operation is replayed through status/receipts, not adopted.
    const receipt = {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: current.value.operation!.operationId,
      appliedRevision: 3,
      disposition: "replaced" as const,
      appliedAt: 3_000,
    };
    port.candidate({ candidateRevision: 3, text: "refined", at: 2_500 });
    expect(h.host.applied(receipt).ok).toBe(true);
    const after = h.host.current({ contract: COMPOSER_TRANSFORM_CONTRACT, binding: BINDING });
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value.operation).toBe(null);
  });

  it("carries candidate text only to the exact bound read", async () => {
    const h = harness();
    expect(h.host.start(baseRequest()).ok).toBe(true);
    await flush();
    h.ports[0]!.candidate({ candidateRevision: 8, text: "private refined", at: 3_000 });
    const current = h.host.current({ contract: COMPOSER_TRANSFORM_CONTRACT, binding: BINDING });
    expect(current.ok).toBe(true);
    if (current.ok) {
      expect(current.value.operation?.candidate?.text).toBe("private refined");
      expect(current.value.operation?.candidate?.candidateRevision).toBe(8);
    }
    // Privacy: the bounded diagnostics/log stream never carries the text.
    expect(JSON.stringify(h.logs)).not.toContain("private refined");
    expect(JSON.stringify(h.host.diagnostics("req-alpha-0001") ?? {})).not.toContain(
      "private refined",
    );
  });

  it("refuses a second live operation for the same composer binding", async () => {
    const h = harness();
    expect(h.host.start(baseRequest()).ok).toBe(true);
    await flush();
    const second = h.host.start(baseRequest({ requestId: "req-alpha-0002" }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("request-conflict");
    expect(h.invocations).toHaveLength(1);
  });

  it("invalidate cancels jobs/grants but keeps bounded receipts idempotent", async () => {
    const h = harness();
    const started = h.host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    const port = h.ports[0]!;
    port.progress({ state: "running", phase: "model", at: 2_000 });

    h.host.invalidate("the project trust decision changed");

    const status = h.host.status({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
    });
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.state).toBe("cancelled");
    // The cancelled operation can never produce an applicable candidate.
    port.candidate({ candidateRevision: 9, text: "late", at: 3_000 });
    expect(
      h.host.applied({
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req-alpha-0001",
        operationId: started.value.operationId,
        appliedRevision: 9,
        disposition: "replaced",
        appliedAt: 3_100,
      }).ok,
    ).toBe(false);
    expect(h.emitted.some((entry) => entry.event === COMPOSER_TRANSFORM_EVENTS.result)).toBe(true);
    // A new operation may start after the invalidation.
    expect(h.host.start(baseRequest({ requestId: "req-alpha-0003" })).ok).toBe(true);
    await flush();
    expect(h.invocations).toHaveLength(2);
  });

  it("reset after a host restart drops live jobs and settled receipts", async () => {
    const h = harness();
    const started = h.host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    h.host.reset();
    const status = h.host.status({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
    });
    expect(status.ok).toBe(false);
    const current = h.host.current({ contract: COMPOSER_TRANSFORM_CONTRACT, binding: BINDING });
    expect(current.ok).toBe(true);
    if (current.ok) expect(current.value.operation).toBe(null);
  });

  it("dispose on app quit cancels grants, listeners and late results", async () => {
    const h = harness();
    const started = h.host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    const port = h.ports[0]!;
    port.progress({ state: "running", phase: "model", at: 2_000 });

    h.host.dispose();

    const status = h.host.status({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
    });
    expect(status.ok).toBe(false);
    // The private rendezvous/listener is gone, so a late candidate cannot be
    // delivered after the app quit.
    const before = h.emitted.length;
    port.candidate({ candidateRevision: 9, text: "late", at: 3_000 });
    expect(h.emitted).toHaveLength(before);
    expect(h.host.start(baseRequest({ requestId: "req-alpha-0009" })).ok).toBe(false);
  });
});

describe("bounded retention and privacy", () => {
  it("evicts the oldest settled request id instead of growing forever", async () => {
    const h = harness({ behavior: "none", maxRetained: 2 });
    for (const suffix of ["0001", "0002", "0003"]) {
      const requestId = `req-alpha-${suffix}`;
      const started = h.host.start(baseRequest({ requestId }));
      expect(started.ok).toBe(true);
      if (!started.ok) continue;
      h.host.cancel({
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId,
        operationId: started.value.operationId,
      });
    }
    await flush();
    expect(h.invocations).toHaveLength(3);

    // The newest id replays; the evicted first id starts a fresh operation.
    const replayed = h.host.start(baseRequest({ requestId: "req-alpha-0003" }));
    expect(replayed.ok).toBe(true);
    expect(h.invocations).toHaveLength(3);
    const restarted = h.host.start(baseRequest({ requestId: "req-alpha-0001" }));
    expect(restarted.ok).toBe(true);
    await flush();
    expect(h.invocations).toHaveLength(4);
  });

  it("never logs the draft, images, digests or grant tokens", async () => {
    const h = harness();
    const started = h.host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    const port = h.ports[0]!;
    port.progress({ state: "running", message: "working", at: 2_000 });
    port.candidate({ candidateRevision: 8, text: "refined", at: 3_000 });
    const args = h.invocations[0]!.args;
    const grant = grantFrom(args);
    const everything = `${h.logs.join("\n")}\n${JSON.stringify(h.emitted)}\n${JSON.stringify(
      h.host.diagnostics("req-alpha-0001"),
    )}`;
    for (const secret of [
      DRAFT,
      EXPANDED,
      DIGEST,
      ATTACHMENT_ID,
      "SECRET_IMAGE_SENTINEL",
      grant.grantId,
      grant.secret,
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(h.logs.length).toBeGreaterThan(0);
  });
});

describe("SDK bridge adapter", () => {
  it("projects provenance and invokes the resolved handler with createCommandContext", async () => {
    const bus = inMemoryBus();
    const context = { marker: "real-command-context" } as CommandContext;
    const calls: Array<{ name: string; args: string; context: CommandContext }> = [];
    const runner: CommandRunner = {
      getCommand(name) {
        if (name !== "prompt-companion") return undefined;
        return {
          handler(args, ctx) {
            calls.push({ name, args, context: ctx });
            const bootstrap = parseComposerBootstrapArgs(args);
            if (!bootstrap.ok) throw new Error(bootstrap.error.message);
            const grant = parseComposerGrant(bootstrap.value.grant);
            if (!grant.ok) throw new Error(grant.error.message);
            bus.emit(composerRendezvousChannel(grant.value.grantId), {
              contract: COMPOSER_TRANSFORM_CONTRACT,
              grantId: grant.value.grantId,
              proof: grant.value.secret,
              accept: (port: ComposerTransformPort) => ports.push(port),
            });
          },
        };
      },
      createCommandContext: () => context,
    };
    const ports: ComposerTransformPort[] = [];
    const host = createSdkComposerTransformHost({
      bus: bus as ComposerTransformBus,
      registrations: () => SAME_SOURCE,
      commands: () => runner,
      controls: controlPort(),
      binding: () => ({ sessionId: "session-1", epoch: 1 }),
      randomBytes: deterministicRandom(),
      clock: fakeClock() as ComposerTransformClock,
    });
    const started = host.start(baseRequest());
    expect(started.ok).toBe(true);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.context).toBe(context);
    expect(calls[0]?.name).toBe("prompt-companion");
    expect(calls[0]?.args).not.toContain("SECRET_DRAFT_SENTINEL");
    expect(ports).toHaveLength(1);
  });

  it("drops nameless registrations and keeps live source info", () => {
    const projected = composerCommandRegistrations([
      { name: "prompt", sourceInfo: { path: "/a/index.ts", source: "alpha", scope: "session" } },
      { name: 42 },
      { sourceInfo: { path: "/a/index.ts" } },
    ]);
    expect(projected).toEqual([
      {
        name: "prompt",
        sourceInfo: { path: "/a/index.ts", source: "alpha", scope: "session" },
      },
    ]);
  });

  it("delegates a companion error to the host and fails closed", async () => {
    const bus = inMemoryBus();
    const errors: unknown[] = [];
    const runner: CommandRunner = {
      getCommand: () => undefined,
      createCommandContext: () => ({}),
    };
    const host = createSdkComposerTransformHost({
      bus: bus as ComposerTransformBus,
      registrations: () => SAME_SOURCE,
      commands: () => runner,
      controls: controlPort(),
      binding: () => ({ sessionId: "session-1", epoch: 1 }),
      randomBytes: deterministicRandom(),
      clock: fakeClock() as ComposerTransformClock,
      onError: (error) => errors.push(error),
    });
    const started = host.start(baseRequest());
    if (!started.ok) return;
    await flush();
    const status = host.status({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: "req-alpha-0001",
      operationId: started.value.operationId,
    });
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.value.state).toBe("failed");
  });
});
