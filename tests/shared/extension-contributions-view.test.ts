import { describe, expect, it } from "vitest";

import {
  CONTRIBUTION_SNAPSHOT_VERSION,
  EMPTY_CONTRIBUTION_SNAPSHOT,
  buildContributionSnapshot,
  contributionViewsBySlot,
  resolveContributionAction,
  sanitizeContributionSnapshot,
  buildContributionBar,
  contributionInputLocked,
  contributionKey,
  MAX_INLINE_ACTIONS,
  type ContributionActionGroupView,
} from "../../src/shared/extension-contributions-view";
import type {
  ActionContribution,
  Contribution,
  ContributionActionGroup,
  ModeChoiceContribution,
  ModeContribution,
} from "../../src/shared/extension-contributions";

/**
 * Renderer-safe contribution view (step 8). The renderer must never need an
 * extension-specific branch, so everything it gets is a flat, sanitized view.
 */

const status = (id: string, order = 0): Contribution => ({
  id,
  kind: "status",
  slot: "status",
  text: `text ${id}`,
  tone: "neutral",
  order,
});

const mode = (id: string, order: number): ModeContribution => ({
  id,
  kind: "mode",
  slot: "mode",
  label: `mode ${id}`,
  tone: "accent",
  order,
  actions: [],
});

const action = (id: string): Contribution => ({
  id,
  kind: "action",
  slot: "action",
  label: `action ${id}`,
  tone: "info",
  order: 0,
  command: { name: "build", args: "--fast" },
  enabled: true,
});

describe("contribution view", () => {
  it("merges owners in a deterministic presentation order", () => {
    const snapshot = buildContributionSnapshot(
      [
        { ownerId: "b.ext", epoch: 0, revision: 2, contributions: [status("s", 0)] },
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 3,
          contributions: [mode("m", 10), status("t", -1)],
        },
      ],
      { supported: true, updatedAt: 5 },
    );
    expect(snapshot.contributions.map((entry) => `${entry.ownerId}:${entry.id}`)).toEqual([
      "a.ext:t",
      "b.ext:s",
      "a.ext:m",
    ]);
    expect(snapshot.owners.map((owner) => owner.ownerId)).toEqual(["a.ext", "b.ext"]);
    expect(snapshot.updatedAt).toBe(5);
  });

  it("keeps an actionable command name but never forwards command args", () => {
    const snapshot = buildContributionSnapshot(
      [{ ownerId: "a.ext", epoch: 0, revision: 1, contributions: [action("go")] }],
      { supported: true, updatedAt: 1 },
    );
    expect(snapshot.contributions[0]?.command).toEqual({ name: "build" });
    expect(snapshot.contributions[0]?.command).not.toHaveProperty("args");
    expect(snapshot.contributions[0]?.enabled).toBe(true);
  });

  it("omits owners with no contributions and reports unsupported", () => {
    const empty = buildContributionSnapshot(
      [{ ownerId: "a.ext", epoch: 0, revision: 1, contributions: [] }],
      {
        supported: false,
        reason: "old host",
        updatedAt: 1,
      },
    );
    expect(empty.owners).toEqual([]);
    expect(empty.contributions).toEqual([]);
    expect(empty.supported).toBe(false);
    expect(empty.reason).toBe("old host");
  });

  it("sanitizes an untrusted frame: unknown kinds dropped, no free-form command", () => {
    const snapshot = sanitizeContributionSnapshot({
      version: CONTRIBUTION_SNAPSHOT_VERSION,
      supported: true,
      owners: [{ ownerId: "a.ext", revision: 1, epoch: 0 }],
      contributions: [
        {
          ownerId: "a.ext",
          id: "go",
          kind: "action",
          slot: "action",
          tone: "accent",
          text: "Build",
          enabled: true,
          command: { name: "build", shell: "rm -rf /" },
        },
        { ownerId: "a.ext", id: "bad", kind: "hologram", text: "x" },
        { ownerId: "", id: "no-owner", kind: "status", text: "x" },
      ],
      updatedAt: 3,
    });
    expect(snapshot.contributions.map((entry) => entry.id)).toEqual(["go"]);
    expect(snapshot.contributions[0]?.command).toEqual({ name: "build" });
    expect(snapshot.updatedAt).toBe(3);
  });

  it("rejects a snapshot from another version and returns the empty default", () => {
    expect(sanitizeContributionSnapshot({ version: 99 })).toEqual(EMPTY_CONTRIBUTION_SNAPSHOT);
    expect(sanitizeContributionSnapshot(undefined)).toEqual(EMPTY_CONTRIBUTION_SNAPSHOT);
  });

  it("filters by slot for a composer badge", () => {
    const snapshot = buildContributionSnapshot(
      [{ ownerId: "a.ext", epoch: 0, revision: 1, contributions: [mode("m", 0), status("s", 0)] }],
      { supported: true, updatedAt: 1 },
    );
    expect(contributionViewsBySlot(snapshot, "mode").map((entry) => entry.id)).toEqual(["m"]);
    expect(contributionViewsBySlot(snapshot, "status").map((entry) => entry.id)).toEqual(["s"]);
  });
});

describe("contribution bar model", () => {
  it("uses a mode for identity and keeps unrelated progress/status rows", () => {
    const snapshot = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [mode("m", 0), status("s", 0), action("go")],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const bar = buildContributionBar(snapshot);
    expect(bar.mode?.id).toBe("m");
    expect(bar.modeAction).toBeNull();
    expect(bar.rows.map((entry) => entry.id)).toEqual(["s"]);
    expect(bar.actions.map((entry) => entry.id)).toEqual(["go"]);
    expect(bar.inputs).toEqual([]);
    expect(bar.sessions).toEqual([]);
    expect(contributionKey(bar.mode!)).toBe("a.ext:m");
  });

  it("never promotes progress or status into a mode identity", () => {
    const onlyStatus = buildContributionSnapshot(
      [{ ownerId: "x.ext", epoch: 0, revision: 1, contributions: [status("s")] }],
      { supported: true, updatedAt: 1 },
    );
    const bar = buildContributionBar(onlyStatus);
    expect(bar.mode).toBeNull();
    expect(bar.modeAction).toBeNull();
    // A status-only publisher still gets its row; it does not become a mode.
    expect(bar.rows.map((entry) => entry.id)).toEqual(["s"]);
    expect(buildContributionBar(EMPTY_CONTRIBUTION_SNAPSHOT).mode).toBeNull();
  });

  it("resolves a mode's same-owner action and does not duplicate it as a row", () => {
    const snapshot = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            { ...mode("m", 0), actionRef: "cycle" },
            {
              id: "cycle",
              kind: "action",
              slot: "action",
              label: "Cycle mode",
              tone: "neutral",
              order: 20,
              command: { name: "cycle" },
              enabled: false,
              disabledReason: "a review owns this turn",
            },
            action("other"),
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const bar = buildContributionBar(snapshot);
    expect(bar.modeAction).toEqual({
      ownerId: "a.ext",
      id: "cycle",
      text: "Cycle mode",
      enabled: false,
      disabledReason: "a review owns this turn",
    });
    // The referenced action is the corner control, not a second bar button.
    expect(bar.actions.map((entry) => entry.id)).toEqual(["other"]);
  });

  it("refuses a cross-owner, dangling or non-action reference", () => {
    const shared = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [{ ...mode("m", 0), actionRef: "cycle" }],
        },
        {
          ownerId: "b.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            {
              id: "cycle",
              kind: "action",
              slot: "action",
              label: "Cycle mode",
              tone: "neutral",
              order: 0,
              command: { name: "cycle" },
              enabled: true,
            },
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    expect(buildContributionBar(shared).modeAction).toBeNull();
    // The other owner's action is still an ordinary, visible action.
    expect(buildContributionBar(shared).actions.map((entry) => entry.id)).toEqual(["cycle"]);

    const dangling = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [{ ...mode("m", 0), actionRef: "gone" }],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    expect(buildContributionBar(dangling).modeAction).toBeNull();

    const wrongKind = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [{ ...mode("m", 0), actionRef: "s" }, status("s")],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    expect(buildContributionBar(wrongKind).modeAction).toBeNull();
  });

  it("keeps another publisher's mode visible as a secondary row", () => {
    const snapshot = buildContributionSnapshot(
      [
        { ownerId: "a.ext", epoch: 0, revision: 1, contributions: [mode("m", 0)] },
        { ownerId: "b.ext", epoch: 0, revision: 1, contributions: [mode("other", 0)] },
      ],
      { supported: true, updatedAt: 1 },
    );
    const bar = buildContributionBar(snapshot);
    expect(bar.mode?.ownerId).toBe("a.ext");
    expect(bar.rows.map((entry) => contributionKey(entry))).toEqual(["b.ext:other"]);
  });

  it("preserves mode identity, its reference and input ownership across transport", () => {
    const snapshot = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            { ...mode("m", 0), actionRef: "cycle" },
            {
              id: "cycle",
              kind: "action",
              slot: "action",
              label: "Cycle mode",
              tone: "neutral",
              order: 20,
              command: { name: "cycle" },
              enabled: true,
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
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const sanitized = sanitizeContributionSnapshot(snapshot);
    const reSanitized = sanitizeContributionSnapshot(sanitized);
    expect(reSanitized).toEqual(sanitized);

    const entry = sanitized.contributions.find((item) => item.id === "m");
    expect(entry?.actionRef).toBe("cycle");
    const input = sanitized.contributions.find((item) => item.id === "input");
    expect(input?.availability).toBe("locked");
    expect(contributionInputLocked(sanitized)).toBe(true);
    expect(buildContributionBar(sanitized).modeAction?.id).toBe("cycle");
  });
});

// ── Additive v1: action groups and mode choices ─────────────────────

const ownedAction = (id: string, over: Partial<ActionContribution> = {}): ActionContribution => ({
  id,
  kind: "action",
  slot: "action",
  label: `action ${id}`,
  tone: "info",
  order: 0,
  command: { name: "build", args: "--fast" },
  enabled: true,
  ...over,
});

const modeChoice = (
  id: string,
  order: number,
  over: Partial<ModeChoiceContribution> = {},
): ModeChoiceContribution => ({
  id,
  kind: "mode-choice",
  slot: "mode-choice",
  label: `choice ${id}`,
  tone: "neutral",
  order,
  actionRef: "cycle",
  ...over,
});

describe("contribution view: action groups", () => {
  it("preserves id, label, order and placement through view and sanitizer", () => {
    const snapshot = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            ownedAction("inline", {
              group: { id: "workflow.todos", label: "Todos", order: 10, placement: "inline" },
            }),
            ownedAction("menu", {
              group: {
                id: "workflow.orchestrator",
                label: "Orchestrator",
                order: 20,
                placement: "menu",
              },
            }),
            ownedAction("legacy"),
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const inline = snapshot.contributions.find((entry) => entry.id === "inline");
    expect(inline?.group).toEqual({
      id: "workflow.todos",
      label: "Todos",
      order: 10,
      placement: "inline",
    });
    const sanitized = sanitizeContributionSnapshot(snapshot);
    expect(sanitized).toEqual(snapshot);
    expect(sanitizeContributionSnapshot(sanitized)).toEqual(sanitized);
    expect(sanitized.contributions.find((entry) => entry.id === "menu")?.group?.placement).toBe(
      "menu",
    );
    // A legacy ungrouped action stays byte-identical to the old contract.
    expect(sanitized.contributions.find((entry) => entry.id === "legacy")).not.toHaveProperty(
      "group",
    );
  });

  it("drops a malformed group but keeps the action usable", () => {
    const sanitized = sanitizeContributionSnapshot({
      version: CONTRIBUTION_SNAPSHOT_VERSION,
      supported: true,
      owners: [{ ownerId: "a.ext", revision: 1, epoch: 0 }],
      contributions: [
        {
          ownerId: "a.ext",
          id: "go",
          kind: "action",
          slot: "action",
          tone: "accent",
          text: "Build",
          order: 0,
          enabled: true,
          command: { name: "build" },
          group: { id: "workflow.todos", label: "Todos", placement: "sidebar" },
        },
      ],
      updatedAt: 1,
    });
    expect(sanitized.contributions.map((entry) => entry.id)).toEqual(["go"]);
    expect(sanitized.contributions[0]?.group).toBeUndefined();
    expect(sanitized.contributions[0]?.command).toEqual({ name: "build" });
  });
});

describe("contribution view: mode-choice", () => {
  it("preserves label, detail, actionRef and checked through a round-trip", () => {
    const snapshot = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            mode("m", 0),
            ownedAction("cycle", { label: "Cycle mode", command: { name: "cycle" } }),
            ownedAction("plan", { label: "Plan", command: { name: "plan" } }),
            modeChoice("choice-plan", 10, {
              label: "Plan",
              description: "Read-only planning",
              actionRef: "plan",
              checked: true,
              tone: "warning",
            }),
            modeChoice("choice-cycle", 20, { actionRef: "cycle" }),
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const sanitized = sanitizeContributionSnapshot(snapshot);
    expect(sanitized).toEqual(snapshot);
    expect(sanitizeContributionSnapshot(sanitized)).toEqual(sanitized);

    const plan = sanitized.contributions.find((entry) => entry.id === "choice-plan");
    expect(plan).toMatchObject({
      kind: "mode-choice",
      slot: "mode-choice",
      text: "Plan",
      detail: "Read-only planning",
      actionRef: "plan",
      checked: true,
      enabled: true,
      tone: "warning",
      order: 10,
    });
    expect(plan?.command).toBeUndefined();
    expect(sanitized.contributions.find((entry) => entry.id === "choice-cycle")?.checked).toBe(
      false,
    );
  });

  it("drops a foreign slot or a missing reference from an untrusted frame", () => {
    const sanitized = sanitizeContributionSnapshot({
      version: CONTRIBUTION_SNAPSHOT_VERSION,
      supported: true,
      owners: [],
      contributions: [
        {
          ownerId: "a.ext",
          id: "claims-mode",
          kind: "mode-choice",
          slot: "mode",
          text: "Build",
          actionRef: "cycle",
          checked: true,
        },
        {
          ownerId: "a.ext",
          id: "no-ref",
          kind: "mode-choice",
          slot: "mode-choice",
          text: "Plan",
        },
        {
          ownerId: "a.ext",
          id: "sneaky",
          kind: "mode-choice",
          slot: "mode-choice",
          text: "Build",
          actionRef: "cycle",
          enabled: false,
          disabledReason: "current mode",
          command: { name: "rm" },
        },
      ],
      updatedAt: 1,
    });
    expect(sanitized.contributions.map((entry) => entry.id)).toEqual(["sneaky"]);
    const sneaky = sanitized.contributions[0];
    expect(sneaky?.command).toBeUndefined();
    // Execution state belongs to the referenced action, never to the choice.
    expect(sneaky?.enabled).toBe(true);
    expect(sneaky?.disabledReason).toBeUndefined();
    expect(sneaky?.actionRef).toBe("cycle");
  });

  it("resolves the referenced same-owner action, including its disabled state", () => {
    const snapshot = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            modeChoice("choice-plan", 0, { actionRef: "plan" }),
            ownedAction("plan", {
              label: "Plan",
              command: { name: "plan" },
              enabled: false,
              disabledReason: "a review owns this turn",
            }),
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const sanitized = sanitizeContributionSnapshot(snapshot);
    const choice = sanitized.contributions.find((entry) => entry.id === "choice-plan") ?? null;
    expect(resolveContributionAction(sanitized, choice)).toEqual({
      ownerId: "a.ext",
      id: "plan",
      text: "Plan",
      enabled: false,
      disabledReason: "a review owns this turn",
    });
  });

  it("refuses a dangling, cross-owner or wrong-kind reference", () => {
    const dangling = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [modeChoice("choice-plan", 0, { actionRef: "gone" })],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const danglingChoice = dangling.contributions[0] ?? null;
    expect(resolveContributionAction(dangling, danglingChoice)).toBeNull();

    const crossOwner = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [modeChoice("choice-plan", 0, { actionRef: "plan" })],
        },
        {
          ownerId: "b.ext",
          epoch: 0,
          revision: 1,
          contributions: [ownedAction("plan", { command: { name: "plan" } })],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const crossChoice =
      crossOwner.contributions.find((entry) => entry.id === "choice-plan") ?? null;
    expect(resolveContributionAction(crossOwner, crossChoice)).toBeNull();

    const wrongKind = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [status("plan"), modeChoice("choice-plan", 0, { actionRef: "plan" })],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const wrongChoice = wrongKind.contributions.find((entry) => entry.id === "choice-plan") ?? null;
    expect(resolveContributionAction(wrongKind, wrongChoice)).toBeNull();
    // Only a mode or mode-choice may supply a reference at all.
    expect(resolveContributionAction(wrongKind, wrongKind.contributions[0] ?? null)).toBeNull();
  });
});

describe("mode-choice never becomes the primary mode or an ordinary row", () => {
  const snapshot = buildContributionSnapshot(
    [
      {
        ownerId: "a.ext",
        epoch: 0,
        revision: 1,
        contributions: [
          mode("m", 50),
          modeChoice("aaa-choice", -100, { label: "Build" }),
          status("s", 0),
          ownedAction("cycle", { order: -10 }),
          ownedAction("unrelated", { order: 10 }),
        ],
      },
    ],
    { supported: true, updatedAt: 1 },
  );

  it("buildContributionBar().mode selects only kind/slot 'mode'", () => {
    const bar = buildContributionBar(snapshot);
    expect(bar.mode?.id).toBe("m");
    expect(bar.mode?.kind).toBe("mode");
    // Even a choice whose order/id would sort first never wins.
    expect(bar.mode?.id).not.toBe("aaa-choice");
  });

  it("contributionViewsBySlot(snapshot, 'mode') returns only the primary mode", () => {
    expect(contributionViewsBySlot(snapshot, "mode").map((entry) => entry.id)).toEqual(["m"]);
    expect(contributionViewsBySlot(snapshot, "mode-choice").map((entry) => entry.id)).toEqual([
      "aaa-choice",
    ]);
  });

  it("excludes a mode-choice from rows and actions", () => {
    const bar = buildContributionBar(snapshot);
    expect(bar.rows.map((entry) => entry.id)).toEqual(["s"]);
    // The choice view itself is never a row/action; the action it references
    // belongs to the menu, and an unrelated action stays in the bar.
    expect(bar.actions.map((entry) => entry.id)).toEqual(["unrelated"]);
    expect(bar.modeChoices.map((entry) => entry.choice.id)).toEqual(["aaa-choice"]);
  });

  it("a choice-only snapshot has no mode and no rows", () => {
    const choiceOnly = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [modeChoice("choice-plan", 0)],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const bar = buildContributionBar(choiceOnly);
    expect(bar.mode).toBeNull();
    expect(bar.modeAction).toBeNull();
    expect(bar.rows).toEqual([]);
    expect(bar.actions).toEqual([]);
    expect(contributionViewsBySlot(choiceOnly, "mode")).toEqual([]);
  });
});

describe("mode-choice actions are consumed by the mode menu, never the bar", () => {
  const snapshot = buildContributionSnapshot(
    [
      {
        ownerId: "a.ext",
        epoch: 0,
        revision: 1,
        contributions: [
          { ...mode("m", 0), actionRef: "cycle" },
          // The primary label consumes its own referenced action.
          ownedAction("cycle", { order: 1, label: "Cycle mode", command: { name: "cycle" } }),
          // Choice-owned actions, both in one menu group.
          ownedAction("plan", {
            order: 2,
            label: "Plan",
            command: { name: "plan" },
            group: groupMeta("modes", { label: "Modes", order: 1, placement: "menu" }),
          }),
          ownedAction("build", {
            order: 3,
            label: "Build",
            command: { name: "build" },
            group: groupMeta("modes", { label: "Modes", order: 1, placement: "menu" }),
          }),
          modeChoice("choice-plan", 10, { actionRef: "plan", checked: true }),
          modeChoice("choice-build", 11, { actionRef: "build" }),
          // Unrelated bar content that must survive untouched.
          ownedAction("run", { order: 20, label: "Run", command: { name: "run" } }),
        ],
      },
      {
        ownerId: "b.ext",
        epoch: 0,
        revision: 1,
        contributions: [
          // Same id as a consumed reference, different owner: NOT consumed.
          ownedAction("plan", { order: 0, label: "Other plan", command: { name: "other-plan" } }),
        ],
      },
    ],
    { supported: true, updatedAt: 1 },
  );
  const bar = buildContributionBar(sanitizeContributionSnapshot(snapshot));
  const renderedActionIds = [
    ...bar.inlineActions,
    ...bar.actionGroups.flatMap((group) => group.actions),
    ...bar.overflowActions,
  ].map((entry) => `${entry.ownerId}:${entry.id}`);

  it("never renders a choice's referenced action in the bar, dots or menu", () => {
    // Presentation order: slot, then order — b.ext's action is order 0.
    expect(bar.actions.map((entry) => `${entry.ownerId}:${entry.id}`)).toEqual([
      "b.ext:plan",
      "a.ext:run",
    ]);
    expect(renderedActionIds).not.toContain("a.ext:plan");
    expect(renderedActionIds).not.toContain("a.ext:build");
    // The choices still resolve those actions for the menu itself.
    expect(bar.modeChoices.map((entry) => entry.choice.id)).toEqual([
      "choice-plan",
      "choice-build",
    ]);
    expect(bar.modeChoices.map((entry) => entry.action?.id)).toEqual(["plan", "build"]);
    expect(bar.modeChoices.map((entry) => entry.choice.checked)).toEqual([true, false]);
  });

  it("keeps unrelated actions and other owners' actions", () => {
    expect(bar.inlineActions.map((entry) => `${entry.ownerId}:${entry.id}`)).toEqual([
      "b.ext:plan",
      "a.ext:run",
    ]);
    // The group that only held consumed actions is gone, not rendered empty.
    expect(bar.actionGroups).toEqual([]);
    expect(bar.overflowActions).toEqual([]);
  });

  it("leaves a dangling reference (and its intended target) untouched", () => {
    const dangling = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            mode("m", 0),
            modeChoice("choice-gone", 0, { actionRef: "gone" }),
            ownedAction("kept", { label: "Kept", command: { name: "kept" } }),
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const danglingBar = buildContributionBar(dangling);
    expect(danglingBar.modeChoices[0]?.action).toBeNull();
    // Nothing resolves, so nothing is consumed.
    expect(danglingBar.actions.map((entry) => entry.id)).toEqual(["kept"]);
    expect(danglingBar.inlineActions.map((entry) => entry.id)).toEqual(["kept"]);
  });

  it("keeps the mode-slot readers on the primary mode only", () => {
    expect(bar.mode?.id).toBe("m");
    expect(bar.mode?.kind).toBe("mode");
    expect(bar.rows).toEqual([]);
    expect(contributionViewsBySlot(snapshot, "mode").map((entry) => entry.id)).toEqual(["m"]);
    expect(contributionViewsBySlot(snapshot, "mode").every((entry) => entry.kind === "mode")).toBe(
      true,
    );
    expect(contributionViewsBySlot(snapshot, "mode-choice").map((entry) => entry.id)).toEqual([
      "choice-plan",
      "choice-build",
    ]);
  });

  it("still consumes the mode-cycle action for the primary label", () => {
    expect(bar.modeAction?.id).toBe("cycle");
    expect(bar.actions.map((entry) => entry.id)).not.toContain("cycle");
    expect(renderedActionIds).not.toContain("a.ext:cycle");
    // A choice reusing the same cycle action never resurfaces it either.
    const reused = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            { ...mode("m", 0), actionRef: "cycle" },
            ownedAction("cycle", { label: "Cycle mode", command: { name: "cycle" } }),
            modeChoice("choice-cycle", 0, { actionRef: "cycle" }),
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const reusedBar = buildContributionBar(reused);
    expect(reusedBar.modeAction?.id).toBe("cycle");
    expect(reusedBar.modeChoices[0]?.action?.id).toBe("cycle");
    expect(reusedBar.actions).toEqual([]);
    expect(reusedBar.inlineActions).toEqual([]);
    expect(reusedBar.actionGroups).toEqual([]);
    expect(reusedBar.overflowActions).toEqual([]);
  });
});

// ── One deterministic working-bar model ─────────────────────────────

const groupMeta = (
  id: string,
  over: Partial<ContributionActionGroup> = {},
): ContributionActionGroup => ({
  id,
  label: id,
  order: 0,
  placement: "inline",
  ...over,
});

const groupSummaries = (group: ContributionActionGroupView) => ({
  ownerId: group.ownerId,
  id: group.id,
  label: group.label,
  order: group.order,
  placement: group.placement,
  actions: group.actions.map((entry) => entry.id),
});

describe("working bar model: inline actions and groups", () => {
  it("caps inline actions and pushes grouped extras into their own group", () => {
    const snapshot = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            ownedAction("a1", { order: 1 }),
            ownedAction("a2", { order: 2 }),
            ownedAction("a3", { order: 3 }),
            ownedAction("a4", { order: 4 }),
            ownedAction("t1", { order: 5, group: groupMeta("workflow.todos") }),
            ownedAction("t2", { order: 6, group: groupMeta("workflow.todos") }),
            ownedAction("m1", { order: 7, group: groupMeta("workflow.more", { order: 20 }) }),
            ownedAction("o1", {
              order: 8,
              group: groupMeta("workflow.orch", { order: 30, placement: "menu" }),
            }),
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const bar = buildContributionBar(snapshot);

    expect(MAX_INLINE_ACTIONS).toBe(3);
    expect(bar.inlineActions.map((entry) => entry.id)).toEqual(["a1", "a2", "a3"]);
    // Ungrouped actions past the cap stay a flat overflow list…
    expect(bar.overflowActions.map((entry) => entry.id)).toEqual(["a4"]);
    // …while grouped ones join the group that owns their siblings, including a
    // menu group that goes entirely to the menu.
    expect(bar.actionGroups.map(groupSummaries)).toEqual([
      {
        ownerId: "a.ext",
        id: "workflow.todos",
        label: "workflow.todos",
        order: 0,
        placement: "inline",
        actions: ["t1", "t2"],
      },
      {
        ownerId: "a.ext",
        id: "workflow.more",
        label: "workflow.more",
        order: 20,
        placement: "inline",
        actions: ["m1"],
      },
      {
        ownerId: "a.ext",
        id: "workflow.orch",
        label: "workflow.orch",
        order: 30,
        placement: "menu",
        actions: ["o1"],
      },
    ]);
  });

  it("keeps the legacy flat-action fallback: first three inline, the rest overflow", () => {
    const snapshot = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: ["a1", "a2", "a3", "a4", "a5"].map((id, index) =>
            ownedAction(id, { order: index }),
          ),
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const bar = buildContributionBar(snapshot);
    expect(bar.inlineActions.map((entry) => entry.id)).toEqual(["a1", "a2", "a3"]);
    expect(bar.overflowActions.map((entry) => entry.id)).toEqual(["a4", "a5"]);
    expect(bar.actionGroups).toEqual([]);
    // `actions` stays the compatibility view of every bar action.
    expect(bar.actions.map((entry) => entry.id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("orders menu groups by order, owner then id and keeps group identity owner-namespaced", () => {
    const snapshot = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            { ...mode("m", 0), actionRef: "cycle" },
            ownedAction("cycle", { order: 5, label: "Cycle mode", command: { name: "cycle" } }),
            // The menu choice reuses the already-consumed cycle action, so the
            // group-order assertions below keep their unrelated group action.
            modeChoice("choice-plan", 10, { actionRef: "cycle" }),
            ownedAction("plan", {
              order: 1,
              label: "Plan",
              command: { name: "plan" },
              group: groupMeta("workflow.modes", { label: "Modes", order: 3, placement: "menu" }),
            }),
            ownedAction("pause", {
              order: 8,
              group: groupMeta("workflow.orch", {
                label: "Orchestrator",
                order: 10,
                placement: "menu",
              }),
            }),
            ownedAction("todo2", {
              order: 6,
              group: groupMeta("workflow.todos", { label: "Todos", order: 20, placement: "menu" }),
            }),
            ownedAction("todo1", {
              order: 7,
              group: groupMeta("workflow.todos", { label: "Todos", order: 20, placement: "menu" }),
            }),
          ],
        },
        {
          ownerId: "b.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            ownedAction("b-todo", {
              order: 1,
              group: groupMeta("workflow.todos", {
                label: "Other Todos",
                order: 5,
                placement: "menu",
              }),
            }),
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const bar = buildContributionBar(snapshot);
    expect(bar.actionGroups.map(groupSummaries)).toEqual([
      {
        ownerId: "a.ext",
        id: "workflow.modes",
        label: "Modes",
        order: 3,
        placement: "menu",
        actions: ["plan"],
      },
      {
        ownerId: "b.ext",
        id: "workflow.todos",
        label: "Other Todos",
        order: 5,
        placement: "menu",
        actions: ["b-todo"],
      },
      {
        ownerId: "a.ext",
        id: "workflow.orch",
        label: "Orchestrator",
        order: 10,
        placement: "menu",
        actions: ["pause"],
      },
      {
        ownerId: "a.ext",
        id: "workflow.todos",
        label: "Todos",
        order: 20,
        placement: "menu",
        actions: ["todo2", "todo1"],
      },
    ]);
    // The primary mode's referenced action is the corner control, not a group.
    expect(bar.actions.map((entry) => entry.id)).not.toContain("cycle");
    expect(bar.inlineActions).toEqual([]);
    expect(bar.modeChoices.map((entry) => entry.choice.id)).toEqual(["choice-plan"]);
  });

  it("resolves the first conflicting group declaration in presentation order, both input orders", () => {
    const conflicting: Contribution[] = [
      ownedAction("a-decl", {
        order: 0,
        group: groupMeta("workflow.todos", { label: "First", order: 50, placement: "inline" }),
      }),
      ownedAction("z-decl", {
        order: 1,
        group: groupMeta("workflow.todos", { label: "Second", order: 1, placement: "menu" }),
      }),
      ownedAction("t1", { order: 2, group: groupMeta("workflow.todos") }),
      ownedAction("t2", { order: 3, group: groupMeta("workflow.todos") }),
    ];
    const build = (contributions: Contribution[]) =>
      buildContributionBar(
        buildContributionSnapshot([{ ownerId: "a.ext", epoch: 0, revision: 1, contributions }], {
          supported: true,
          updatedAt: 1,
        }),
      );
    const forward = build(conflicting);
    const reversed = build([...conflicting].reverse());
    expect(reversed).toEqual(forward);
    // `a-decl` is first in presentation order, so its metadata wins: the group
    // stays inline and only the actions past the cap surface in the group.
    expect(forward.inlineActions.map((entry) => entry.id)).toEqual(["a-decl", "z-decl", "t1"]);
    expect(forward.actionGroups.map(groupSummaries)).toEqual([
      {
        ownerId: "a.ext",
        id: "workflow.todos",
        label: "First",
        order: 50,
        placement: "inline",
        actions: ["t2"],
      },
    ]);
  });

  it("treats a dropped malformed group as a legacy ungrouped action", () => {
    const sanitized = sanitizeContributionSnapshot({
      version: CONTRIBUTION_SNAPSHOT_VERSION,
      supported: true,
      owners: [{ ownerId: "a.ext", revision: 1, epoch: 0 }],
      contributions: [
        {
          ownerId: "a.ext",
          id: "go",
          kind: "action",
          slot: "action",
          tone: "accent",
          text: "Build",
          order: 0,
          enabled: true,
          command: { name: "build" },
          group: { id: "workflow.todos", label: "Todos", placement: "sidebar" },
        },
      ],
      updatedAt: 1,
    });
    const bar = buildContributionBar(sanitized);
    expect(bar.inlineActions.map((entry) => entry.id)).toEqual(["go"]);
    expect(bar.actionGroups).toEqual([]);
    expect(bar.overflowActions).toEqual([]);
  });
});

describe("working bar model: mode choices", () => {
  it("keeps same-owner choices in presentation order with their resolved action", () => {
    const snapshot = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            { ...mode("m", 0), actionRef: "cycle" },
            ownedAction("cycle", { label: "Cycle mode", command: { name: "cycle" } }),
            ownedAction("plan", {
              order: 1,
              label: "Plan",
              command: { name: "plan" },
              enabled: false,
              disabledReason: "current mode",
            }),
            status("note", 2),
            modeChoice("choice-build", 30, { label: "Build", actionRef: "plan" }),
            modeChoice("choice-plan", 20, {
              label: "Plan",
              description: "Read-only planning",
              actionRef: "plan",
              checked: true,
            }),
            modeChoice("choice-dangling", 40, { actionRef: "gone" }),
            modeChoice("choice-wrong-kind", 50, { actionRef: "note" }),
          ],
        },
        {
          ownerId: "b.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            modeChoice("b-choice", 0, { actionRef: "b-plan" }),
            ownedAction("b-plan", { label: "B Plan", command: { name: "b-plan" } }),
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const bar = buildContributionBar(snapshot);
    expect(bar.modeChoices.map((entry) => entry.choice.id)).toEqual([
      "choice-plan",
      "choice-build",
      "choice-dangling",
      "choice-wrong-kind",
    ]);
    const plan = bar.modeChoices[0];
    expect(plan?.choice).toMatchObject({
      ownerId: "a.ext",
      kind: "mode-choice",
      slot: "mode-choice",
      text: "Plan",
      detail: "Read-only planning",
      actionRef: "plan",
      checked: true,
    });
    expect(plan?.action).toEqual({
      ownerId: "a.ext",
      id: "plan",
      text: "Plan",
      enabled: false,
      disabledReason: "current mode",
    });
    // Dangling and wrong-kind references stay visible but non-actionable.
    expect(bar.modeChoices[2]?.action).toBeNull();
    expect(bar.modeChoices[3]?.action).toBeNull();
    // A choice from another owner never enters this owner's menu.
    expect(bar.modeChoices.map((entry) => entry.choice.ownerId)).not.toContain("b.ext");
    expect(bar.mode?.id).toBe("m");
    expect(bar.rows.map((entry) => entry.id)).toEqual(["note"]);
    expect(bar.actions.map((entry) => entry.id)).not.toContain("choice-plan");
  });

  it("has no menu entries without a primary mode or for another owner's choice", () => {
    const choiceOnly = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [modeChoice("choice-plan", 0)],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    expect(buildContributionBar(choiceOnly).modeChoices).toEqual([]);

    const otherOwner = buildContributionSnapshot(
      [
        { ownerId: "a.ext", epoch: 0, revision: 1, contributions: [mode("m", 0)] },
        {
          ownerId: "b.ext",
          epoch: 0,
          revision: 1,
          contributions: [modeChoice("b-choice", 0)],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    expect(buildContributionBar(otherOwner).modeChoices).toEqual([]);
  });
});

describe("working bar model: footer rows and compatibility", () => {
  it("splits progress and status rows by kind in presentation order", () => {
    const snapshot = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            status("s1", 5),
            status("s2", 1),
            {
              id: "p2",
              kind: "progress",
              slot: "progress",
              label: "Todos",
              tone: "neutral",
              order: 2,
              done: 1,
              total: 4,
              actions: [],
            },
            {
              id: "p1",
              kind: "progress",
              slot: "progress",
              label: "Steps",
              tone: "neutral",
              order: 3,
              done: 2,
              total: 5,
              actions: [],
            },
            modeChoice("choice", 0),
            { ...mode("m", -1), actionRef: "go" },
            ownedAction("go", { order: 10 }),
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const bar = buildContributionBar(snapshot);
    expect(bar.progressRows.map((entry) => entry.id)).toEqual(["p2", "p1"]);
    expect(bar.statusRows.map((entry) => entry.id)).toEqual(["s2", "s1"]);
    // Compatibility views keep the old shape and never include a mode-choice.
    expect(bar.rows.map((entry) => entry.id)).toEqual(["p2", "p1", "s2", "s1"]);
    expect(bar.rows.every((entry) => entry.kind !== "mode-choice")).toBe(true);
    expect(bar.mode?.id).toBe("m");
    expect(bar.actions.map((entry) => entry.id)).toEqual([]);
  });

  it("returns an empty model for an unsupported snapshot", () => {
    const bar = buildContributionBar(EMPTY_CONTRIBUTION_SNAPSHOT);
    expect(bar.mode).toBeNull();
    expect(bar.modeAction).toBeNull();
    expect(bar.rows).toEqual([]);
    expect(bar.actions).toEqual([]);
    expect(bar.modeChoices).toEqual([]);
    expect(bar.inlineActions).toEqual([]);
    expect(bar.actionGroups).toEqual([]);
    expect(bar.overflowActions).toEqual([]);
    expect(bar.progressRows).toEqual([]);
    expect(bar.statusRows).toEqual([]);
  });

  it("survives a sanitizer round-trip with groups, checked and actionRef intact", () => {
    const snapshot = buildContributionSnapshot(
      [
        {
          ownerId: "a.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            { ...mode("m", 0), actionRef: "cycle" },
            ownedAction("cycle", { label: "Cycle mode", command: { name: "cycle" } }),
            ownedAction("todos", {
              order: 10,
              label: "Todos",
              command: { name: "todos" },
              group: groupMeta("workflow.todos", { order: 20, placement: "menu" }),
            }),
            modeChoice("choice-plan", 30, {
              label: "Plan",
              description: "Read-only planning",
              actionRef: "cycle",
              checked: true,
            }),
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );
    const sanitized = sanitizeContributionSnapshot(snapshot);
    expect(sanitizeContributionSnapshot(sanitized)).toEqual(sanitized);
    const todos = sanitized.contributions.find((entry) => entry.id === "todos");
    expect(todos?.group).toEqual({
      id: "workflow.todos",
      label: "workflow.todos",
      order: 20,
      placement: "menu",
    });
    const choice = sanitized.contributions.find((entry) => entry.id === "choice-plan");
    expect(choice?.actionRef).toBe("cycle");
    expect(choice?.checked).toBe(true);
    // The model consumes the sanitized snapshot exactly like the live one.
    expect(buildContributionBar(sanitized)).toEqual(buildContributionBar(snapshot));
    expect(buildContributionBar(sanitized).modeChoices[0]?.choice.checked).toBe(true);
  });
});
