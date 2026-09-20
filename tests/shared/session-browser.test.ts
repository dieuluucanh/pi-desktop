import { describe, expect, it } from "vitest";
import {
  filterSessions,
  flattenSessionTree,
  groupSessionsByProject,
  matchesSessionQuery,
  MAX_SESSION_SUMMARIES,
  mostRecentSessionForProject,
  sanitizeSessionList,
  sanitizeSessionSummary,
  sessionDisplayTitle,
  sortSessionsByRecency,
} from "../../src/shared/session-browser";

/**
 * The session browser's pure model (plan step 11): untrusted `SessionInfo`
 * payloads become typed rows, then group/search/sort deterministically.
 */

const iso = (value: string): string => value;

function rawSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "C:\\Users\\u\\.pi\\agent\\sessions\\--work--\\s1.jsonl",
    id: "s1",
    cwd: "C:\\work",
    name: "Fix host protocol",
    created: iso("2026-09-01T10:00:00.000Z"),
    modified: iso("2026-09-02T10:00:00.000Z"),
    messageCount: 12,
    firstMessage: "Fix the host protocol",
    allMessagesText: "Fix the host protocol",
    ...overrides,
  };
}

describe("sanitizeSessionSummary", () => {
  it("adapts Pi's ISO timestamps into epoch milliseconds", () => {
    const session = sanitizeSessionSummary(rawSession());
    expect(session?.created).toBe(Date.parse("2026-09-01T10:00:00.000Z"));
    expect(session?.modified).toBe(Date.parse("2026-09-02T10:00:00.000Z"));
  });

  it("keeps numeric timestamps and drops unusable ones", () => {
    expect(sanitizeSessionSummary(rawSession({ created: 1234 }))?.created).toBe(1234);
    expect(sanitizeSessionSummary(rawSession({ modified: "not-a-date" }))?.modified).toBe(0);
  });

  it("fills a missing id from the path and nulls a blank name", () => {
    const session = sanitizeSessionSummary(rawSession({ id: undefined, name: "   " }));
    expect(session?.id).toBe("C:\\Users\\u\\.pi\\agent\\sessions\\--work--\\s1.jsonl");
    expect(session?.name).toBeNull();
  });

  it("rejects anything without a path", () => {
    expect(sanitizeSessionSummary({ id: "s1" })).toBeNull();
    expect(sanitizeSessionSummary(null)).toBeNull();
    expect(sanitizeSessionSummary("s1")).toBeNull();
  });

  it("clamps message counts and long text", () => {
    const session = sanitizeSessionSummary(
      rawSession({ messageCount: -3, firstMessage: "x".repeat(9999) }),
    );
    expect(session?.messageCount).toBe(0);
    expect(session?.firstMessage.length).toBe(4000);
  });
});

describe("sanitizeSessionList", () => {
  it("drops duplicates and caps the list", () => {
    const many = Array.from({ length: MAX_SESSION_SUMMARIES + 10 }, (_, index) =>
      rawSession({ path: `/p/s${index}.jsonl`, id: `s${index}` }),
    );
    const list = sanitizeSessionList([...many, many[0]]);
    expect(list).toHaveLength(MAX_SESSION_SUMMARIES);
    expect(new Set(list.map((session) => session.path)).size).toBe(list.length);
  });

  it("returns an empty list for a non-array", () => {
    expect(sanitizeSessionList(undefined)).toEqual([]);
    expect(sanitizeSessionList({})).toEqual([]);
  });
});

describe("sessionDisplayTitle", () => {
  it("prefers the explicit name", () => {
    expect(sessionDisplayTitle(sanitizeSessionSummary(rawSession())!)).toBe("Fix host protocol");
  });

  it("falls back to the first line of the first message", () => {
    const session = sanitizeSessionSummary(
      rawSession({ name: undefined, firstMessage: "First line\nsecond line" }),
    )!;
    expect(sessionDisplayTitle(session)).toBe("First line");
  });

  it("truncates a long first message", () => {
    const session = sanitizeSessionSummary(
      rawSession({ name: undefined, firstMessage: "y".repeat(200) }),
    )!;
    expect(sessionDisplayTitle(session).length).toBe(90);
    expect(sessionDisplayTitle(session).endsWith("…")).toBe(true);
  });

  it("uses the project name and a short id when there is nothing else", () => {
    const session = sanitizeSessionSummary(
      rawSession({ name: undefined, firstMessage: "", cwd: "C:\\work\\pi-desktop" }),
    )!;
    expect(sessionDisplayTitle(session)).toBe("pi-desktop · s1");
  });
});

describe("search, sort and grouping", () => {
  const sessions = sanitizeSessionList([
    rawSession({
      path: "/p/a.jsonl",
      id: "a",
      cwd: "/work/alpha",
      modified: "2026-09-03T00:00:00Z",
    }),
    rawSession({
      path: "/p/b.jsonl",
      id: "b",
      cwd: "/work/alpha",
      name: "Beta task",
      modified: "2026-09-05T00:00:00Z",
    }),
    rawSession({
      path: "/p/c.jsonl",
      id: "c",
      cwd: "/work/beta",
      name: undefined,
      firstMessage: "gamma gamma",
      modified: "2026-09-01T00:00:00Z",
    }),
  ]);

  it("orders newest first", () => {
    expect(sortSessionsByRecency(sessions).map((session) => session.id)).toEqual(["b", "a", "c"]);
  });

  it("searches names, messages and paths case-insensitively", () => {
    expect(matchesSessionQuery(sessions[0]!, "FIX HOST")).toBe(true);
    expect(matchesSessionQuery(sessions[2]!, "GAMMA")).toBe(true);
    expect(matchesSessionQuery(sessions[2]!, "/work/beta")).toBe(true);
    expect(matchesSessionQuery(sessions[2]!, "nothing")).toBe(false);
    expect(matchesSessionQuery(sessions[2]!, "  ")).toBe(true);
  });

  it("filters and sorts together, keeping recency order", () => {
    expect(filterSessions(sessions, "gamma").map((session) => session.id)).toEqual(["c"]);
    // "beta" matches session b's name and session c's /work/beta cwd, newest first.
    expect(filterSessions(sessions, "beta").map((session) => session.id)).toEqual(["b", "c"]);
    expect(filterSessions(sessions, "Beta task").map((session) => session.id)).toEqual(["b"]);
  });

  it("groups by project, newest project first, with its latest session", () => {
    const groups = groupSessionsByProject(sessions);
    expect(groups.map((group) => group.name)).toEqual(["alpha", "beta"]);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["b", "a"]);
    expect(groups[0]?.latest?.id).toBe("b");
    expect(groups[1]?.latest?.id).toBe("c");
  });

  it("groups legacy sessions with no cwd under a readable heading", () => {
    const legacy = sanitizeSessionList([rawSession({ path: "/p/old.jsonl", cwd: "" })]);
    const groups = groupSessionsByProject(legacy);
    expect(groups[0]?.name).toBe("No project directory");
  });

  it("finds the most recent session for a project", () => {
    expect(mostRecentSessionForProject(sessions, "/work/alpha")?.id).toBe("b");
    expect(mostRecentSessionForProject(sessions, "/work/beta")?.id).toBe("c");
    expect(mostRecentSessionForProject(sessions, "/work/missing")).toBeNull();
  });
});

describe("flattenSessionTree", () => {
  const tree = [
    {
      entry: {
        id: "e1",
        type: "message",
        message: { role: "user", content: "hello there" },
        timestamp: 1000,
      },
      label: "start",
      children: [
        {
          entry: {
            id: "e2",
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
            timestamp: 2000,
          },
          children: [],
        },
        {
          entry: {
            id: "e3",
            type: "model_change",
            provider: "anthropic",
            modelId: "claude",
            timestamp: 3000,
          },
          children: [],
        },
      ],
    },
  ];

  it("walks the tree in document order with depth", () => {
    const rows = flattenSessionTree(tree, "e2");
    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      ["e1", 0],
      ["e2", 1],
      ["e3", 1],
    ]);
  });

  it("summarizes message, model-change and label entries", () => {
    const rows = flattenSessionTree(tree, null);
    expect(rows[0]?.text).toBe("hello there");
    expect(rows[0]?.label).toBe("start");
    expect(rows[1]?.text).toBe("hi back");
    expect(rows[2]?.text).toBe("anthropic/claude");
  });

  it("marks the leaf row", () => {
    expect(
      flattenSessionTree(tree, "e2")
        .filter((row) => row.leaf)
        .map((row) => row.id),
    ).toEqual(["e2"]);
    expect(flattenSessionTree(tree, null).some((row) => row.leaf)).toBe(false);
  });

  it("skips malformed nodes instead of crashing", () => {
    const rows = flattenSessionTree(
      [null, {}, "x", { entry: { id: "ok" }, children: "nope" }],
      null,
    );
    expect(rows.map((row) => row.id)).toEqual(["ok"]);
    expect(flattenSessionTree(undefined, null)).toEqual([]);
    expect(flattenSessionTree({}, null)).toEqual([]);
  });
});
