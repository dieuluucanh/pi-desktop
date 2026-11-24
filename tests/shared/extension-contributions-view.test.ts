import { describe, expect, it } from "vitest";

import {
  CONTRIBUTION_SNAPSHOT_VERSION,
  EMPTY_CONTRIBUTION_SNAPSHOT,
  buildContributionSnapshot,
  contributionViewsBySlot,
  sanitizeContributionSnapshot,
  buildContributionBar,
  contributionInputLocked,
  contributionKey,
} from "../../src/shared/extension-contributions-view";
import type { Contribution, ModeContribution } from "../../src/shared/extension-contributions";

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
