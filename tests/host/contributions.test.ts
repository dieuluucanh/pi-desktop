import { describe, expect, it } from "vitest";

import { CONTRIBUTION_EVENTS, createContributionHost } from "../../src/host/contributions";
import { createSdkContributionBridge } from "../../src/host/sdk/contributions";
import type { ContributionEnvelope } from "../../src/shared/extension-contributions";

/**
 * Host contribution registry (orchestrator plan step 8).
 *
 * The registry is the trust boundary between extension payloads and the
 * renderer: it re-validates, enforces revision/epoch monotonicity, and only
 * runs commands the host can resolve.
 */

const envelope = (over: Partial<ContributionEnvelope> = {}): ContributionEnvelope => ({
  version: 1,
  owner: { id: "dieulc.example" },
  sessionId: "session-a",
  epoch: 0,
  revision: 1,
  removed: [],
  contributions: [
    { id: "s", kind: "status", slot: "status", text: "hello", tone: "neutral", order: 0 },
  ],
  ...over,
});

function harness() {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const commands: Array<{ name: string; args: string }> = [];
  let known = new Set(["build", "review"]);
  const host = createContributionHost({
    emit: (event, payload) => emitted.push({ event, payload }),
    runCommand: async (name, args) => {
      if (!known.has(name)) return { ran: false, error: `unknown command ${name}` };
      commands.push({ name, args });
      return { ran: true };
    },
    now: () => 1_000,
  });
  return { host, emitted, commands, setKnown: (next: string[]) => (known = new Set(next)) };
}

describe("contribution host registry", () => {
  it("accepts a valid envelope and publishes a snapshot", () => {
    const h = harness();
    expect(h.host.receive(envelope())).toEqual({ accepted: true });
    const snapshot = h.host.snapshot();
    expect(snapshot.supported).toBe(true);
    expect(snapshot.contributions.map((entry) => entry.id)).toEqual(["s"]);
    expect(snapshot.owners).toEqual([{ ownerId: "dieulc.example", revision: 1, epoch: 0 }]);
    expect(h.emitted.at(-1)?.event).toBe("contributions.state");
  });

  it("rejects malformed payloads without touching the registry", () => {
    const h = harness();
    expect(h.host.receive({ version: 99 }).accepted).toBe(false);
    expect(
      h.host.receive({ version: 1, owner: {}, sessionId: "s", epoch: 0, revision: 1 }).accepted,
    ).toBe(false);
    expect(h.host.snapshot().contributions).toEqual([]);
  });

  it("drops stale and duplicate revisions, and an older epoch", () => {
    const h = harness();
    h.host.receive(envelope({ revision: 3 }));
    expect(h.host.receive(envelope({ revision: 3 })).accepted).toBe(false);
    expect(h.host.receive(envelope({ revision: 2 })).accepted).toBe(false);
    expect(h.host.receive(envelope({ epoch: -1 as never })).accepted).toBe(false);
    // The registry kept revision 3.
    expect(h.host.snapshot().owners[0]?.revision).toBe(3);
  });

  it("merges two unrelated owners with deterministic order", () => {
    const h = harness();
    h.host.receive(envelope({ owner: { id: "b.ext" } }));
    h.host.receive(
      envelope({
        owner: { id: "a.ext" },
        contributions: [
          {
            id: "mode",
            kind: "mode",
            slot: "mode",
            label: "Plan",
            tone: "accent",
            order: -5,
            actions: [],
          },
        ],
      }),
    );
    expect(h.host.snapshot().contributions.map((entry) => `${entry.ownerId}:${entry.id}`)).toEqual([
      "a.ext:mode",
      "b.ext:s",
    ]);
  });

  it("a newer epoch starts that owner's registry clean", () => {
    const h = harness();
    h.host.receive(envelope({ revision: 5 }));
    h.host.receive(
      envelope({
        epoch: 1,
        revision: 1,
        contributions: [
          {
            id: "fresh",
            kind: "status",
            slot: "status",
            text: "new epoch",
            tone: "neutral",
            order: 0,
          },
        ],
      }),
    );
    const owners = h.host.snapshot().owners;
    expect(owners[0]?.epoch).toBe(1);
    expect(owners[0]?.revision).toBe(1);
    // The old epoch's contribution is gone; only the new one remains.
    expect(h.host.snapshot().contributions.map((entry) => entry.id)).toEqual(["fresh"]);
  });

  it("reset clears every owner and publishes an empty snapshot", () => {
    const h = harness();
    h.host.receive(envelope());
    h.host.reset();
    expect(h.host.snapshot().contributions).toEqual([]);
    expect(h.emitted.at(-1)?.event).toBe("contributions.state");
  });

  it("runs only an enabled action whose command the host knows", async () => {
    const h = harness();
    h.host.receive(
      envelope({
        contributions: [
          {
            id: "go",
            kind: "action",
            slot: "action",
            label: "Build",
            tone: "accent",
            order: 0,
            command: { name: "build" },
            enabled: true,
          },
        ],
      }),
    );
    await expect(h.host.runAction("dieulc.example", "go")).resolves.toEqual({ ran: true });
    expect(h.commands).toEqual([{ name: "build", args: "" }]);

    // A command that was removed after publication is refused.
    h.setKnown([]);
    await expect(h.host.runAction("dieulc.example", "go")).resolves.toEqual({
      ran: false,
      error: "unknown command build",
    });
  });

  it("keeps a nonempty command.args host-owned and out of the renderer snapshot", async () => {
    const h = harness();
    h.host.receive(
      envelope({
        contributions: [
          {
            id: "go",
            kind: "action",
            slot: "action",
            label: "Build fast",
            tone: "accent",
            order: 0,
            command: { name: "build", args: "--fast" },
            enabled: true,
          },
        ],
      }),
    );
    const snapshot = h.host.snapshot();
    // The renderer snapshot carries the command identity only; the executable
    // arguments stay in the host registry and are re-resolved on run.
    expect(snapshot.contributions[0]?.command).toEqual({ name: "build" });
    expect(snapshot.contributions[0]?.command).not.toHaveProperty("args");
    await expect(h.host.runAction("dieulc.example", "go")).resolves.toEqual({ ran: true });
    expect(h.commands).toEqual([{ name: "build", args: "--fast" }]);
  });

  it("routes a /review action verb through the host-owned command.args", async () => {
    const h = harness();
    h.host.receive(
      envelope({
        contributions: [
          {
            id: "review-pause",
            kind: "action",
            slot: "action",
            label: "Pause review",
            tone: "accent",
            order: 0,
            command: { name: "review", args: "pause" },
            enabled: true,
          },
        ],
      }),
    );
    await expect(h.host.runAction("dieulc.example", "review-pause")).resolves.toEqual({
      ran: true,
    });
    // `review` is the registered command; `pause` is its host-owned verb arg.
    expect(h.commands).toEqual([{ name: "review", args: "pause" }]);
  });

  it("refuses a disabled action and a nested display action", async () => {
    const h = harness();
    h.host.receive(
      envelope({
        contributions: [
          {
            id: "go",
            kind: "action",
            slot: "action",
            label: "Build",
            tone: "accent",
            order: 0,
            command: { name: "build" },
            enabled: false,
            disabledReason: "already building",
          },
          {
            id: "mode",
            kind: "mode",
            slot: "mode",
            label: "Plan",
            tone: "accent",
            order: 0,
            actions: [],
          },
        ],
      }),
    );
    await expect(h.host.runAction("dieulc.example", "go")).resolves.toEqual({
      ran: false,
      error: "already building",
    });
    const nested = await h.host.runAction("dieulc.example", "mode");
    expect(nested.ran).toBe(false);
    expect(nested.error).toMatch(/not executable/);
    expect(h.commands).toEqual([]);
  });

  it("refuses an action from a stale or unknown owner", async () => {
    const h = harness();
    await expect(h.host.runAction("nobody", "go")).resolves.toEqual({
      ran: false,
      error: "action is no longer available",
    });
  });

  it("exposes state and run handlers that validate their params", async () => {
    const h = harness();
    h.host.receive(envelope());
    const handlers = h.host.handlers();
    const state = await handlers["contributions.state"]?.({}, {} as never);
    expect((state as { contributions: unknown[] }).contributions).toHaveLength(1);
    await expect(handlers["contributions.run"]?.({}, {} as never)).rejects.toThrow(/requires/);
  });
});

describe("contribution bus bridge", () => {
  function fakeBus() {
    const handlers = new Map<string, (payload: unknown) => unknown>();
    const emitted: Array<{ channel: string; payload?: unknown }> = [];
    return {
      bus: {
        on(channel: string, handler: (payload: unknown) => unknown) {
          handlers.set(channel, handler);
          return () => handlers.delete(channel);
        },
        emit(channel: string, payload?: unknown) {
          emitted.push({ channel, ...(payload === undefined ? {} : { payload }) });
        },
      },
      emitted,
      deliver: (channel: string, payload?: unknown) => handlers.get(channel)?.(payload),
      size: () => handlers.size,
    };
  }

  it("routes update envelopes to the registry and answers a probe", () => {
    const h = harness();
    const b = fakeBus();
    const bridge = createSdkContributionBridge({ host: h.host, bus: b.bus });
    b.deliver(CONTRIBUTION_EVENTS.update, envelope());
    expect(h.host.snapshot().contributions).toHaveLength(1);

    b.deliver(CONTRIBUTION_EVENTS.probe, {});
    const hello = b.emitted.find((entry) => entry.channel === CONTRIBUTION_EVENTS.hello);
    expect(hello).toBeTruthy();
    expect((hello?.payload as { contractVersion: number }).contractVersion).toBe(1);
    bridge.dispose();
    expect(b.size()).toBe(0);
  });

  it("announce emits the host capabilities", () => {
    const h = harness();
    const b = fakeBus();
    const bridge = createSdkContributionBridge({ host: h.host, bus: b.bus });
    bridge.announce();
    expect(b.emitted.at(-1)?.channel).toBe(CONTRIBUTION_EVENTS.hello);
  });

  it("a throwing bus listener is reported, never propagated", () => {
    const h = harness();
    const errors: unknown[] = [];
    const bus = {
      on() {
        throw new Error("bus exploded");
      },
      emit() {
        throw new Error("bus exploded");
      },
    };
    const bridge = createSdkContributionBridge({
      host: h.host,
      bus,
      onError: (error) => errors.push(error),
    });
    expect(errors).toHaveLength(1);
    // A bridge without a bus degrades to "no contributions", never a crash.
    bridge.announce();
    expect(errors).toHaveLength(2);
    bridge.dispose();
  });
});
