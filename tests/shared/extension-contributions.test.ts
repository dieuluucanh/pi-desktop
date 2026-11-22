import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  HOST_CONTRIBUTION_LIMITS,
  HOST_CONTRIBUTION_VERSION,
  applyEnvelope,
  negotiateContributionVersion,
  parseContributionEnvelope,
  sortContributions,
  type Contribution,
  type ContributionEnvelope,
} from "../../src/shared/extension-contributions";

/**
 * Conformance for the generic extension→host contribution contract (step 2).
 *
 * `tests/shared/fixtures/host-contract.conformance.json` is a verbatim copy of
 * the Workflow package's publisher fixture. Both sides run it: the publisher
 * proves it emits these shapes, Desktop proves it accepts exactly the same ones.
 * If the two implementations ever disagree, one of these suites fails.
 */

interface Conformance {
  version: number;
  envelopes: Array<{ name: string; expect: "ok" | "error"; input: unknown }>;
  negotiation: Array<{ name: string; hostVersion: number | null; expect: "ok" | "error" }>;
  apply: Array<{
    name: string;
    current: { epoch: number; revision: number; ids: string[] };
    next: { epoch: number; revision: number; ids: string[] };
    expect: "ok" | "error";
    resultIds?: string[];
  }>;
  sessionHost: Array<{ name: string; expect: "ok" | "error" }>;
}

const FIXTURE = join(__dirname, "fixtures", "host-contract.conformance.json");

function readFixture(): Conformance {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Conformance;
}

function statusEnvelope(ids: string[], epoch: number, revision: number): ContributionEnvelope {
  return {
    version: HOST_CONTRIBUTION_VERSION,
    owner: { id: "dieulc.example" },
    sessionId: "session-a",
    epoch,
    revision,
    removed: [],
    contributions: ids.map((id) => ({
      id,
      kind: "status" as const,
      slot: "status" as const,
      text: `status ${id}`,
      tone: "neutral" as const,
      order: 0,
    })),
  };
}

describe("extension contributions: conformance with the publisher", () => {
  it("agrees on every envelope verdict", () => {
    const fixture = readFixture();
    expect(fixture.version).toBe(1);
    for (const entry of fixture.envelopes) {
      const result = parseContributionEnvelope(entry.input);
      expect(result.ok, `${entry.name}: ${result.ok ? "" : result.error}`).toBe(
        entry.expect === "ok",
      );
    }
  });

  it("negotiates versions exactly", () => {
    const fixture = readFixture();
    for (const entry of fixture.negotiation) {
      const result = negotiateContributionVersion({
        contractVersion: entry.hostVersion as number,
        kinds: [],
        slots: [],
      });
      expect(result.ok, entry.name).toBe(entry.expect === "ok");
    }
  });

  it("applies envelopes with the same revision rules", () => {
    const fixture = readFixture();
    for (const entry of fixture.apply) {
      const current = {
        epoch: entry.current.epoch,
        revision: entry.current.revision,
        contributions: new Map<string, Contribution>(
          entry.current.ids.map((id) => [
            id,
            {
              id,
              kind: "status",
              slot: "status",
              text: `status ${id}`,
              tone: "neutral",
              order: 0,
            },
          ]),
        ),
      };
      const result = applyEnvelope(
        current,
        statusEnvelope(entry.next.ids, entry.next.epoch, entry.next.revision),
      );
      expect(result.ok, entry.name).toBe(entry.expect === "ok");
      if (result.ok && entry.resultIds) {
        expect([...result.value.contributions.keys()].sort()).toEqual([...entry.resultIds].sort());
      }
    }
  });

  it("keeps the fixture's session-host section for the launcher contract", () => {
    // Desktop reads this file too, so a truncated copy is caught here rather
    // than in the Workflow suite alone.
    expect(readFixture().sessionHost.length).toBeGreaterThanOrEqual(3);
  });
});

describe("extension contributions: Desktop-side limits and safety", () => {
  it("rejects an oversized payload instead of truncating it", () => {
    const result = parseContributionEnvelope({
      version: 1,
      owner: { id: "o" },
      sessionId: "s",
      epoch: 0,
      revision: 1,
      contributions: [
        { kind: "mode", id: "m", label: "x".repeat(HOST_CONTRIBUTION_LIMITS.maxLabelChars + 1) },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a control character in a rendered string", () => {
    const result = parseContributionEnvelope({
      version: 1,
      owner: { id: "o" },
      sessionId: "s",
      epoch: 0,
      revision: 1,
      contributions: [{ kind: "status", id: "s", text: "safe\u001b[31mred" }],
    });
    expect(result.ok).toBe(false);
  });

  it("preserves a mode actionRef and never turns it into a command", () => {
    const parsed = parseContributionEnvelope({
      version: 1,
      owner: { id: "o" },
      sessionId: "s",
      epoch: 0,
      revision: 1,
      contributions: [
        { kind: "mode", id: "mode", label: "Plan", actionRef: "mode-cycle" },
        { kind: "action", id: "mode-cycle", label: "Cycle mode", command: { name: "cycle" } },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const [mode, action] = parsed.value.envelope.contributions;
      expect(mode?.kind === "mode" ? mode.actionRef : undefined).toBe("mode-cycle");
      expect(action?.kind === "action" ? action.command.name : undefined).toBe("cycle");
      // The reference itself carries no executable field.
      expect(JSON.stringify(mode)).not.toMatch(/command/);
    }

    // A dangling reference is valid: the host refuses it at run time rather
    // than failing the whole envelope (contributions can update separately).
    const dangling = parseContributionEnvelope({
      version: 1,
      owner: { id: "o" },
      sessionId: "s",
      epoch: 0,
      revision: 2,
      contributions: [{ kind: "mode", id: "mode", label: "Plan", actionRef: "missing" }],
    });
    expect(dangling.ok).toBe(true);
  });

  it("rejects a malformed mode actionRef instead of ignoring it", () => {
    for (const badRef of ["../../bin/sh", "has space", 7, null, "x".repeat(97)]) {
      const result = parseContributionEnvelope({
        version: 1,
        owner: { id: "o" },
        sessionId: "s",
        epoch: 0,
        revision: 1,
        contributions: [{ kind: "mode", id: "m", label: "Plan", actionRef: badRef }],
      });
      expect(result.ok, JSON.stringify(badRef)).toBe(false);
    }
  });

  it("drops an unknown kind and keeps the known siblings", () => {
    const result = parseContributionEnvelope({
      version: 1,
      owner: { id: "o" },
      sessionId: "s",
      epoch: 0,
      revision: 1,
      contributions: [
        { kind: "hologram", id: "h" },
        { kind: "status", id: "s1", text: "today" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ignoredKinds).toEqual(["hologram"]);
      expect(result.value.envelope.contributions.map((entry) => entry.id)).toEqual(["s1"]);
    }
  });

  it("orders contributions deterministically across owners", () => {
    const contribution = (id: string, order: number): Contribution => ({
      id,
      kind: "status",
      slot: "status",
      text: id,
      tone: "neutral",
      order,
    });
    const sorted = sortContributions([
      { ownerId: "b", contribution: contribution("z", 0) },
      { ownerId: "a", contribution: contribution("y", 0) },
      { ownerId: "c", contribution: contribution("first", -1) },
    ]);
    expect(sorted.map((entry) => `${entry.ownerId}:${entry.contribution.id}`)).toEqual([
      "c:first",
      "a:y",
      "b:z",
    ]);
  });

  it("a newer epoch starts a clean registry", () => {
    const current = {
      epoch: 1,
      revision: 9,
      contributions: new Map<string, Contribution>([
        ["a", { id: "a", kind: "status", slot: "status", text: "old", tone: "neutral", order: 0 }],
      ]),
    };
    const result = applyEnvelope(current, statusEnvelope(["b"], 2, 1));
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.value.contributions.keys()]).toEqual(["b"]);
  });
});
