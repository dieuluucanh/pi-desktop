import { describe, expect, it } from "vitest";

import { createContributionHost } from "../../src/host/contributions";
import type { ContributionEnvelope } from "../../src/shared/extension-contributions";
import {
  buildContributionBar,
  contributionInputLocked,
  sanitizeContributionSnapshot,
} from "../../src/shared/extension-contributions-view";

/**
 * Mode-cycle boundary at the trust boundary (2026-11-22 plan, step 9).
 *
 * The renderer must never receive authority from a mode label. These tests go
 * through the real registry — envelope validation, owner scoping, live action
 * lookup — and then the real renderer sanitizer, which is the exact path a
 * published mode takes before the composer can render it as a button.
 */

const OWNER = "fixture.mode-ext";

const envelope = (over: Partial<ContributionEnvelope> = {}): ContributionEnvelope => ({
  version: 1,
  owner: { id: OWNER },
  sessionId: "session-a",
  epoch: 0,
  revision: 1,
  removed: [],
  contributions: [
    {
      id: "mode",
      kind: "mode",
      slot: "mode",
      label: "Plan",
      tone: "warning",
      order: 0,
      actionRef: "mode-cycle",
      actions: [],
    },
    {
      id: "mode-cycle",
      kind: "action",
      slot: "action",
      label: "Cycle mode",
      tone: "neutral",
      order: 20,
      command: { name: "fixture-cycle" },
      enabled: true,
    },
  ],
  ...over,
});

function harness() {
  const commands: string[] = [];
  const host = createContributionHost({
    emit: () => {},
    runCommand: async (name) => {
      if (name !== "fixture-cycle") return { ran: false, error: "unknown command" };
      commands.push(name);
      return { ran: true };
    },
    now: () => 1_000,
  });
  return { host, commands };
}

describe("mode action resolution at the host boundary", () => {
  it("preserves the same-owner reference through registry and sanitizer", () => {
    const h = harness();
    expect(h.host.receive(envelope()).accepted).toBe(true);

    const sanitized = sanitizeContributionSnapshot(h.host.snapshot());
    const mode = sanitized.contributions.find((entry) => entry.id === "mode");
    expect(mode?.actionRef).toBe("mode-cycle");

    const bar = buildContributionBar(sanitized);
    expect(bar.mode?.text).toBe("Plan");
    expect(bar.modeAction).toEqual({
      ownerId: OWNER,
      id: "mode-cycle",
      text: "Cycle mode",
      enabled: true,
    });
    // The referenced action is the corner control, not a second bar button.
    expect(bar.actions).toEqual([]);
  });

  it("runs only the action the owner still offers", async () => {
    const h = harness();
    h.host.receive(envelope());

    await expect(h.host.runAction(OWNER, "mode-cycle")).resolves.toEqual({ ran: true });
    expect(h.commands).toEqual(["fixture-cycle"]);

    // A different owner cannot borrow the id, and the mode label itself is not
    // executable (nested display actions stay refused).
    await expect(h.host.runAction("someone.else", "mode-cycle")).resolves.toEqual({
      ran: false,
      error: "action is no longer available",
    });
    await expect(h.host.runAction(OWNER, "mode")).resolves.toEqual({
      ran: false,
      error: 'nested display actions are not executable; publish a kind:"action" contribution',
    });
  });

  it("disables the resolved action when the publisher withdrew or disabled it", async () => {
    const h = harness();
    h.host.receive(envelope());
    h.host.receive(
      envelope({
        revision: 2,
        removed: ["mode-cycle"],
        contributions: [
          {
            id: "mode",
            kind: "mode",
            slot: "mode",
            label: "Plan",
            tone: "warning",
            order: 0,
            actionRef: "mode-cycle",
            actions: [],
          },
        ],
      }),
    );
    const sanitized = sanitizeContributionSnapshot(h.host.snapshot());
    // A dangling reference resolves to no control; the label remains informative.
    expect(buildContributionBar(sanitized).modeAction).toBeNull();
    await expect(h.host.runAction(OWNER, "mode-cycle")).resolves.toEqual({
      ran: false,
      error: "action is no longer available",
    });
  });

  it("keeps a disabled action visible but refuses it at run time", async () => {
    const h = harness();
    h.host.receive(
      envelope({
        contributions: [
          {
            id: "mode",
            kind: "mode",
            slot: "mode",
            label: "Review",
            tone: "accent",
            order: 0,
            actionRef: "mode-cycle",
            actions: [],
          },
          {
            id: "mode-cycle",
            kind: "action",
            slot: "action",
            label: "Cycle mode",
            tone: "neutral",
            order: 20,
            command: { name: "fixture-cycle" },
            enabled: false,
            disabledReason: "a review owns this turn",
          },
        ],
      }),
    );
    const bar = buildContributionBar(sanitizeContributionSnapshot(h.host.snapshot()));
    expect(bar.modeAction?.enabled).toBe(false);
    expect(bar.modeAction?.disabledReason).toBe("a review owns this turn");
    // A stale click cannot bypass the publisher's current state.
    await expect(h.host.runAction(OWNER, "mode-cycle")).resolves.toEqual({
      ran: false,
      error: "a review owns this turn",
    });
    expect(h.commands).toEqual([]);
  });

  it("drops a stale revision without losing the live mode or its action", async () => {
    const h = harness();
    h.host.receive(
      envelope({
        revision: 2,
        contributions: [
          {
            id: "mode",
            kind: "mode",
            slot: "mode",
            label: "Build",
            tone: "accent",
            order: 0,
            actionRef: "mode-cycle",
            actions: [],
          },
          {
            id: "mode-cycle",
            kind: "action",
            slot: "action",
            label: "Cycle mode",
            tone: "neutral",
            order: 20,
            command: { name: "fixture-cycle" },
            enabled: true,
          },
        ],
      }),
    );
    // An older publish (a delayed reconnect) must not resurrect "Plan".
    expect(h.host.receive(envelope({ revision: 1 })).accepted).toBe(false);

    const bar = buildContributionBar(sanitizeContributionSnapshot(h.host.snapshot()));
    expect(bar.mode?.text).toBe("Build");
    expect(bar.modeAction?.id).toBe("mode-cycle");
  });

  it("still carries input ownership through the same transport", () => {
    const h = harness();
    h.host.receive(
      envelope({
        contributions: [
          {
            id: "mode",
            kind: "mode",
            slot: "mode",
            label: "Review",
            tone: "accent",
            order: 0,
            actionRef: "mode-cycle",
            actions: [],
          },
          {
            id: "input",
            kind: "input",
            slot: "input",
            availability: "locked",
            tone: "warning",
            order: 40,
            reason: "A reviewer owns this turn",
          },
        ],
      }),
    );
    const sanitized = sanitizeContributionSnapshot(h.host.snapshot());
    // The sanitizer used to drop this field; a locked prose surface must survive
    // the real frame, not only a hand-built view model.
    expect(contributionInputLocked(sanitized)).toBe(true);
  });
});
