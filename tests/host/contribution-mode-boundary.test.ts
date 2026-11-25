import { describe, expect, it } from "vitest";

import { createContributionHost } from "../../src/host/contributions";
import type { HostRequestContext } from "../../src/host/service";
import type { ContributionEnvelope } from "../../src/shared/extension-contributions";
import {
  buildContributionBar,
  contributionInputLocked,
  contributionViewsBySlot,
  resolveContributionAction,
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

describe("mode-choice at the host boundary", () => {
  const choiceEnvelope = (over: Partial<ContributionEnvelope> = {}): ContributionEnvelope =>
    envelope({
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
          id: "choice-build",
          kind: "mode-choice",
          slot: "mode-choice",
          label: "Build",
          tone: "accent",
          order: 10,
          actionRef: "mode-cycle",
          checked: false,
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

  it("runs only through the referenced same-owner action", async () => {
    const h = harness();
    h.host.receive(choiceEnvelope());
    const sanitized = sanitizeContributionSnapshot(h.host.snapshot());
    const choice = sanitized.contributions.find((entry) => entry.id === "choice-build") ?? null;
    expect(resolveContributionAction(sanitized, choice)?.id).toBe("mode-cycle");
    // The choice never becomes the primary mode or an ordinary mode row.
    expect(buildContributionBar(sanitized).mode?.id).toBe("mode");
    expect(contributionViewsBySlot(sanitized, "mode").map((entry) => entry.id)).toEqual(["mode"]);

    await expect(h.host.runAction(OWNER, "mode-cycle")).resolves.toEqual({ ran: true });
    expect(h.commands).toEqual(["fixture-cycle"]);
    // A choice has no command of its own: it is presentation data.
    await expect(h.host.runAction(OWNER, "choice-build")).resolves.toEqual({
      ran: false,
      error: "contribution is not actionable",
    });
  });

  it("refuses a disabled referenced action with its own reason", async () => {
    const h = harness();
    h.host.receive(
      choiceEnvelope({
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
            id: "choice-build",
            kind: "mode-choice",
            slot: "mode-choice",
            label: "Build",
            tone: "accent",
            order: 10,
            actionRef: "mode-cycle",
            checked: false,
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
    const sanitized = sanitizeContributionSnapshot(h.host.snapshot());
    const choice = sanitized.contributions.find((entry) => entry.id === "choice-build") ?? null;
    expect(resolveContributionAction(sanitized, choice)?.enabled).toBe(false);
    expect(resolveContributionAction(sanitized, choice)?.disabledReason).toBe(
      "a review owns this turn",
    );
    await expect(h.host.runAction(OWNER, "mode-cycle")).resolves.toEqual({
      ran: false,
      error: "a review owns this turn",
    });
    expect(h.commands).toEqual([]);
  });
});

/**
 * Cross-repo compatibility (2026-11-25 session run bar plan, step 12).
 *
 * The publisher is synthetic: an arbitrary owner, no Workflow ids, labels or
 * commands. It still goes through the only real path — envelope validation, the
 * registry's owner scoping, the `contributions.state` handler, and the renderer
 * sanitizer — so this proves the Desktop reader/writer pair is generic.
 * `tests/renderer/session-view.test.tsx` renders the same snapshot shape; the
 * renderer project cannot import these host modules.
 */
describe("cross-repo ingestion: synthetic publisher through the real registry", () => {
  const SYNTHETIC = "fixture.synthetic";

  const context = (): HostRequestContext => ({
    method: "contributions.state",
    requestId: 1,
    emit: () => {},
    readBlob: async () => null,
  });

  function registryHarness(): {
    host: ReturnType<typeof createContributionHost>;
    emitted: unknown[];
    commands: string[];
    state: () => Promise<unknown>;
  } {
    const emitted: unknown[] = [];
    const commands: string[] = [];
    const host = createContributionHost({
      emit: (event, payload) => {
        if (event === "contributions.state") emitted.push(payload);
      },
      runCommand: async (name) => {
        commands.push(name);
        return { ran: true };
      },
      now: () => 1_000,
    });
    const state = async (): Promise<unknown> => {
      const handler = host.handlers()["contributions.state"];
      if (!handler) throw new Error("contributions.state is not registered");
      return handler({}, context());
    };
    return { host, emitted, commands, state };
  }

  const synthetic = (over: Partial<ContributionEnvelope> = {}): ContributionEnvelope => ({
    version: 1,
    owner: { id: SYNTHETIC },
    sessionId: "session-a",
    epoch: 0,
    revision: 1,
    removed: [],
    contributions: [
      {
        id: "mode",
        kind: "mode",
        slot: "mode",
        label: "Focus",
        tone: "accent",
        order: 0,
        actionRef: "cycle",
        actions: [],
      },
      {
        id: "cycle",
        kind: "action",
        slot: "action",
        label: "Cycle focus",
        tone: "neutral",
        order: 1,
        command: { name: "fixture-cycle" },
        enabled: true,
      },
      {
        id: "plan",
        kind: "action",
        slot: "action",
        label: "Plan",
        tone: "info",
        order: 2,
        command: { name: "fixture-plan" },
        enabled: true,
      },
      {
        id: "build",
        kind: "action",
        slot: "action",
        label: "Build",
        tone: "info",
        order: 3,
        command: { name: "fixture-build" },
        enabled: true,
      },
      {
        id: "choice-plan",
        kind: "mode-choice",
        slot: "mode-choice",
        label: "Plan",
        tone: "neutral",
        order: 10,
        actionRef: "plan",
        checked: true,
      },
      {
        id: "choice-build",
        kind: "mode-choice",
        slot: "mode-choice",
        label: "Build",
        tone: "neutral",
        order: 11,
        actionRef: "build",
      },
      {
        id: "pause",
        kind: "action",
        slot: "action",
        label: "Pause work",
        tone: "neutral",
        order: 5,
        command: { name: "fixture-pause" },
        enabled: true,
        group: { id: "run-controls", label: "Run controls", order: 1, placement: "inline" },
      },
      {
        id: "resume",
        kind: "action",
        slot: "action",
        label: "Resume work",
        tone: "neutral",
        order: 6,
        command: { name: "fixture-resume" },
        enabled: false,
        disabledReason: "not paused",
        group: { id: "run-controls", label: "Run controls", order: 1, placement: "inline" },
      },
      {
        id: "hide",
        kind: "action",
        slot: "action",
        label: "Hide list",
        tone: "neutral",
        order: 8,
        command: { name: "fixture-hide" },
        enabled: true,
        group: { id: "list", label: "List", order: 2, placement: "menu" },
      },
      {
        id: "telemetry",
        kind: "status",
        slot: "status",
        text: "SYNTH 1/4 · alpha/beta · ctx 12% · local list",
        tone: "neutral",
        order: 30,
      },
    ],
    ...over,
  });

  it("publishes one bar model, the inline/menu groups, the mode chevron data and footer rows", async () => {
    const h = registryHarness();
    expect(h.host.receive(synthetic()).accepted).toBe(true);

    const state = await h.state();
    // The pushed event and the RPC answer are the same document.
    expect(h.emitted.at(-1)).toEqual(state);

    const sanitized = sanitizeContributionSnapshot(state);
    // Sanitizing twice is byte-stable: nothing lost or invented on the frame.
    expect(sanitizeContributionSnapshot(sanitized)).toEqual(sanitized);

    // Mode-slot regression at the ingestion boundary.
    expect(contributionViewsBySlot(sanitized, "mode").map((entry) => entry.id)).toEqual(["mode"]);
    expect(contributionViewsBySlot(sanitized, "mode").every((entry) => entry.kind === "mode")).toBe(
      true,
    );
    expect(contributionViewsBySlot(sanitized, "mode-choice").map((entry) => entry.id)).toEqual([
      "choice-plan",
      "choice-build",
    ]);

    const bar = buildContributionBar(sanitized);
    expect(bar.mode?.id).toBe("mode");
    expect(bar.mode?.kind).toBe("mode");
    expect(bar.modeAction?.id).toBe("cycle");
    expect(bar.rows.map((entry) => entry.id)).toEqual(["telemetry"]);
    expect(bar.inlineActions.map((entry) => entry.id)).toEqual(["pause", "resume"]);
    expect(
      bar.actionGroups.map((group) => `${group.id}:${group.actions.map((a) => a.id)}`),
    ).toEqual(["list:hide"]);
    expect(bar.modeChoices.map((entry) => entry.choice.id)).toEqual([
      "choice-plan",
      "choice-build",
    ]);
    expect(bar.modeChoices.map((entry) => entry.action?.id)).toEqual(["plan", "build"]);
    // The choice-owned actions and the label's cycle action never reach the bar.
    expect(bar.actions.map((entry) => entry.id)).toEqual(["pause", "resume", "hide"]);
    expect(bar.overflowActions).toEqual([]);
    expect(bar.statusRows.map((entry) => entry.id)).toEqual(["telemetry"]);
    expect(bar.progressRows).toEqual([]);

    // The registry still resolves and runs the same-owner action behind a choice.
    await expect(h.host.runAction(SYNTHETIC, "build")).resolves.toEqual({ ran: true });
    expect(h.commands).toEqual(["fixture-build"]);
    // A mode-choice is presentation data, never executable.
    await expect(h.host.runAction(SYNTHETIC, "choice-build")).resolves.toEqual({
      ran: false,
      error: "contribution is not actionable",
    });
  });

  it("keeps the legacy publisher fallback: no choices and the flat action partition", async () => {
    const h = registryHarness();
    expect(
      h.host.receive(
        synthetic({
          owner: { id: "fixture.legacy" },
          contributions: [
            {
              id: "mode",
              kind: "mode",
              slot: "mode",
              label: "Focus",
              tone: "accent",
              order: 0,
              actionRef: "cycle",
              actions: [],
            },
            {
              id: "cycle",
              kind: "action",
              slot: "action",
              label: "Cycle focus",
              tone: "neutral",
              order: 1,
              command: { name: "fixture-cycle" },
              enabled: true,
            },
            ...["One", "Two", "Three", "Four", "Five"].map((label, index) => ({
              id: `legacy-${label.toLowerCase()}`,
              kind: "action" as const,
              slot: "action" as const,
              label,
              tone: "info" as const,
              order: 10 + index,
              command: { name: "fixture-legacy" },
              enabled: true,
            })),
            {
              id: "orchestrator-child",
              kind: "status" as const,
              slot: "status" as const,
              text: "CHILD 2/7 · provider/id · ctx 43% · local todos",
              tone: "neutral" as const,
              order: 20,
            },
            {
              id: "orchestrator-run",
              kind: "status" as const,
              slot: "status" as const,
              text: "RUN 3/7 · parent panel",
              tone: "neutral" as const,
              order: 21,
            },
          ],
        }),
      ).accepted,
    ).toBe(true);

    const sanitized = sanitizeContributionSnapshot(await h.state());
    const bar = buildContributionBar(sanitized);
    expect(contributionViewsBySlot(sanitized, "mode").map((entry) => entry.id)).toEqual(["mode"]);
    expect(contributionViewsBySlot(sanitized, "mode-choice")).toEqual([]);
    expect(bar.mode?.id).toBe("mode");
    expect(bar.modeAction?.id).toBe("cycle");
    expect(bar.modeChoices).toEqual([]);
    // No groups: the first three stay inline, the rest are a flat overflow.
    expect(bar.inlineActions.map((entry) => entry.id)).toEqual([
      "legacy-one",
      "legacy-two",
      "legacy-three",
    ]);
    expect(bar.actionGroups).toEqual([]);
    expect(bar.overflowActions.map((entry) => entry.id)).toEqual(["legacy-four", "legacy-five"]);
    // Old-Workflow-shaped rows are footer data, never bar controls.
    expect(bar.statusRows.map((entry) => entry.id)).toEqual([
      "orchestrator-child",
      "orchestrator-run",
    ]);
    expect(bar.actions.map((entry) => entry.id)).not.toContain("cycle");
  });

  it("keeps both publishers independent in one snapshot", async () => {
    const h = registryHarness();
    expect(h.host.receive(synthetic()).accepted).toBe(true);
    expect(
      h.host.receive(
        synthetic({
          owner: { id: "fixture.legacy" },
          revision: 2,
          contributions: [
            {
              id: "status",
              kind: "status" as const,
              slot: "status" as const,
              text: "LEGACY · footer only",
              tone: "neutral" as const,
              order: 40,
            },
          ],
        }),
      ).accepted,
    ).toBe(true);

    const bar = buildContributionBar(sanitizeContributionSnapshot(await h.state()));
    expect(bar.mode?.ownerId).toBe(SYNTHETIC);
    // Only the primary mode's owner supplies choices.
    expect(bar.modeChoices.map((entry) => entry.choice.ownerId)).toEqual([SYNTHETIC, SYNTHETIC]);
    expect(bar.statusRows.map((entry) => `${entry.ownerId}:${entry.id}`)).toEqual([
      `${SYNTHETIC}:telemetry`,
      "fixture.legacy:status",
    ]);
  });
});
