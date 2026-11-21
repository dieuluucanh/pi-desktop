import { describe, expect, it } from "vitest";

import {
  CONTRIBUTION_SNAPSHOT_VERSION,
  EMPTY_CONTRIBUTION_SNAPSHOT,
  buildContributionSnapshot,
  contributionViewsBySlot,
  sanitizeContributionSnapshot,
} from "../../src/shared/extension-contributions-view";
import type { Contribution } from "../../src/shared/extension-contributions";

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

const mode = (id: string, order: number): Contribution => ({
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
        { ownerId: "a.ext", epoch: 0, revision: 3, contributions: [mode("m", 10), status("t", -1)] },
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

  it("keeps an actionable command, and a disabled reason", () => {
    const snapshot = buildContributionSnapshot(
      [{ ownerId: "a.ext", epoch: 0, revision: 1, contributions: [action("go")] }],
      { supported: true, updatedAt: 1 },
    );
    expect(snapshot.contributions[0]?.command).toEqual({ name: "build", args: "--fast" });
    expect(snapshot.contributions[0]?.enabled).toBe(true);
  });

  it("omits owners with no contributions and reports unsupported", () => {
    const empty = buildContributionSnapshot([{ ownerId: "a.ext", epoch: 0, revision: 1, contributions: [] }], {
      supported: false,
      reason: "old host",
      updatedAt: 1,
    });
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
