import { describe, expect, it } from "vitest";
import {
  filterSessionTreeRows,
  filterSessions,
  flattenSessionTree,
  formatSessionTime,
  formatSessionTimeTitle,
  listSessions,
  parseSessionQuery,
  groupSessionsByProject,
  matchesSessionQuery,
  MAX_SESSION_LIST_BYTES,
  MAX_SESSION_SUMMARIES,
  parseSessionListPage,
  parseSessionListQuery,
  projectSessionListEntry,
  projectSessionListPage,
  normalizeSessionListQuery,
  sameSessionListQuery,
  sanitizeSessionList,
  sanitizeSessionSummary,
  sessionDisplayTitle,
  sessionTreeHasChildren,
  sortSessionsByRecency,
  visibleSessionTreeRows,
} from "../../src/shared/session-browser";
import { BLOB_SPILL_THRESHOLD_BYTES } from "../../src/shared/host-protocol";

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

  it("converts the SDK's Date timestamps to epoch milliseconds", () => {
    const session = sanitizeSessionSummary(
      rawSession({
        created: new Date("2026-09-01T10:00:00.000Z"),
        modified: new Date("2026-09-02T10:00:00.000Z"),
      }),
    );
    expect(session?.created).toBe(Date.parse("2026-09-01T10:00:00.000Z"));
    expect(session?.modified).toBe(Date.parse("2026-09-02T10:00:00.000Z"));
  });

  it("keeps numeric timestamps and drops unusable ones", () => {
    expect(sanitizeSessionSummary(rawSession({ created: 1234 }))?.created).toBe(1234);
    expect(sanitizeSessionSummary(rawSession({ modified: "not-a-date" }))?.modified).toBe(0);
    expect(sanitizeSessionSummary(rawSession({ created: new Date("nope") }))?.created).toBe(0);
    expect(sanitizeSessionSummary(rawSession({ modified: -5 }))?.modified).toBe(0);
    expect(sanitizeSessionSummary(rawSession({ modified: Number.NaN }))?.modified).toBe(0);
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

describe("formatSessionTime", () => {
  const modified = Date.parse("2026-11-06T01:34:08.798Z");

  it("never renders an unknown timestamp as 1970", () => {
    expect(formatSessionTime(0)).toBe("—");
    expect(formatSessionTime(-1)).toBe("—");
    expect(formatSessionTime(Number.NaN)).toBe("—");
    expect(formatSessionTimeTitle(0)).toBe("");
  });

  it("renders a real timestamp in the requested locale", () => {
    const label = formatSessionTime(modified, "en-US");
    expect(label).toContain("2026");
    expect(label).not.toContain("1970");
    expect(formatSessionTimeTitle(modified)).toBe("2026-11-06T01:34:08.798Z");
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

  it("groups Windows separator/case variants as one project", () => {
    const rows = sanitizeSessionList([
      rawSession({ path: "/p/a.jsonl", id: "a", cwd: "C:\\work\\App", modified: 2 }),
      rawSession({ path: "/p/b.jsonl", id: "b", cwd: "c:/WORK/app/", modified: 3 }),
      rawSession({ path: "/p/c.jsonl", id: "c", cwd: "C:/work/other", modified: 1 }),
    ]);
    const groups = groupSessionsByProject(rows);
    expect(groups).toHaveLength(2);
    const app = groups.find((group) => group.name.toLowerCase() === "app");
    expect(app?.sessions.map((row) => row.id)).toEqual(["b", "a"]);
    // The heading keeps the first spelling Pi recorded, for copy/paste fidelity.
    expect(app?.cwd).toBe("C:\\work\\App");
  });
});

describe("normalizeSessionListQuery", () => {
  it("fills defaults and drops cwd for the all-sessions scope", () => {
    expect(normalizeSessionListQuery()).toEqual({
      query: "",
      scope: "all",
      cwd: null,
      sort: "recent",
      namedOnly: false,
    });
    expect(normalizeSessionListQuery({ scope: "all", cwd: "/work/a" }).cwd).toBeNull();
  });

  it("keeps the current-project cwd and clamps the limit", () => {
    expect(normalizeSessionListQuery({ scope: "current", cwd: "/work/a", limit: 0 })).toMatchObject(
      { scope: "current", cwd: "/work/a", limit: 1 },
    );
  });

  it("ignores refresh in comparisons", () => {
    const left = {
      query: "x",
      scope: "current" as const,
      cwd: "/w",
      sort: "recent" as const,
      namedOnly: false,
    };
    expect(sameSessionListQuery(left, { ...left, refresh: true })).toBe(true);
    expect(sameSessionListQuery(left, null)).toBe(false);
    expect(sameSessionListQuery(left, { ...left, scope: "all" })).toBe(false);
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

describe("session browser parity (plan step 16)", () => {
  function session(overrides: Record<string, unknown>): ReturnType<typeof sanitizeSessionSummary> {
    return sanitizeSessionSummary(
      rawSession({
        path: `C:/work/sessions/${String(overrides.id ?? "s1")}.jsonl`,
        ...overrides,
      }),
    );
  }

  it("keeps the parent session path so fork chains survive sanitizing", () => {
    const child = sanitizeSessionSummary(
      rawSession({ parentSessionPath: "C:/work/sessions/parent.jsonl" }),
    );
    expect(child?.parentSessionPath).toBe("C:/work/sessions/parent.jsonl");
    expect(sanitizeSessionSummary(rawSession())?.parentSessionPath).toBeNull();
  });

  it("parses phrases, plain words and regexes", () => {
    const phrase = parseSessionQuery('"host protocol" flaky');
    expect(phrase.phrase).toBe("host protocol");
    expect(phrase.terms).toEqual(["flaky"]);

    const words = parseSessionQuery("  fix   HOST  ");
    expect(words.terms).toEqual(["fix", "host"]);
    expect(words.phrase).toBeNull();

    const regex = parseSessionQuery("re:host");
    expect(regex.regex?.test("host")).toBe(true);

    // An unbalanced quote is not a phrase: it degrades to plain tokens.
    const unbalanced = parseSessionQuery('"host protocol');
    expect(unbalanced.phrase).toBeNull();
    expect(unbalanced.terms).toContain('"host');
  });

  it("reports an invalid regex instead of returning no rows", () => {
    const listing = listSessions([session({ id: "a" })!], { query: "re:(" });
    expect(listing.sessions).toEqual([]);
    expect(listing.error).toMatch(/group|parenth|unterminated/i);
  });

  it("scopes to the current project", () => {
    const rows = [session({ id: "a", cwd: "C:/work" })!, session({ id: "b", cwd: "C:/other" })!];
    expect(listSessions(rows, { scope: "current", cwd: "C:/work" }).sessions).toHaveLength(1);
    expect(listSessions(rows, { scope: "all" }).sessions).toHaveLength(2);
    expect(listSessions(rows, { scope: "current", cwd: null }).sessions).toHaveLength(0);
  });

  it("matches a Windows project across separator and case variants", () => {
    const rows = [
      session({ id: "a", cwd: "C:\\work\\App" })!,
      session({ id: "b", cwd: "c:/WORK/app/" })!,
      session({ id: "c", cwd: "C:/work/other" })!,
    ];
    expect(
      listSessions(rows, { scope: "current", cwd: "c:\\work\\app" }).sessions.map((row) => row.id),
    ).toEqual(["a", "b"]);
  });

  it("keeps POSIX project paths case-sensitive", () => {
    const rows = [session({ id: "a", cwd: "/work/App" })!, session({ id: "b", cwd: "/work/app" })!];
    expect(
      listSessions(rows, { scope: "current", cwd: "/work/App" }).sessions.map((row) => row.id),
    ).toEqual(["a"]);
    expect(groupSessionsByProject(rows)).toHaveLength(2);
  });

  it("filters to named sessions only", () => {
    const rows = [
      session({ id: "a", name: "Named" })!,
      session({ id: "b", name: null, firstMessage: "unnamed" })!,
    ];
    expect(listSessions(rows, { namedOnly: true }).sessions.map((row) => row.id)).toEqual(["a"]);
  });

  it("orders a fork chain together and parents first", () => {
    const parent = session({
      id: "parent",
      created: "2026-09-01T10:00:00.000Z",
      modified: "2026-09-05T10:00:00.000Z",
    })!;
    const child = session({
      id: "child",
      created: "2026-09-02T10:00:00.000Z",
      modified: "2026-09-02T10:00:00.000Z",
      parentSessionPath: parent.path,
    })!;
    const unrelated = session({
      id: "other",
      created: "2026-09-03T10:00:00.000Z",
      modified: "2026-09-03T10:00:00.000Z",
    })!;
    const threaded = listSessions([child, unrelated, parent], { sort: "threaded" }).sessions;
    expect(threaded.map((row) => row.id)).toEqual(["parent", "child", "other"]);
  });

  it("orders by relevance, then recency", () => {
    const strong = session({ id: "strong", name: "gizmo gizmo" })!;
    const weak = session({ id: "weak", firstMessage: "gizmo" })!;
    const rows = listSessions([weak, strong], { query: "gizmo", sort: "relevance" }).sessions;
    expect(rows.map((row) => row.id)).toEqual(["strong", "weak"]);
  });

  it("and-matches every plain word", () => {
    const row = session({ id: "a", firstMessage: "the host protocol is flaky" })!;
    expect(matchesSessionQuery(row, "host flaky")).toBe(true);
    expect(matchesSessionQuery(row, "host missing")).toBe(false);
  });

  it("stays fast over the 2k-session cap", () => {
    const rows = Array.from({ length: MAX_SESSION_SUMMARIES }, (_, index) =>
      session({ id: `s${index}`, allMessagesText: `session ${index} host` })!,
    );
    const started = performance.now();
    const listing = listSessions(rows, { query: "re:host", sort: "recent" });
    expect(listing.sessions).toHaveLength(MAX_SESSION_SUMMARIES);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});

describe("session tree view (plan step 17)", () => {
  const rows = flattenSessionTree(
    [
      {
        entry: { id: "u1", type: "message", message: { role: "user", content: "first" } },
        children: [
          {
            entry: {
              id: "a1",
              type: "message",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: "reading" },
                  { type: "toolCall", name: "read", arguments: { path: "a.txt" } },
                ],
              },
            },
            children: [
              {
                entry: {
                  id: "b1",
                  type: "message",
                  message: { role: "bashExecution", command: "ls", output: "a.txt" },
                },
                children: [],
              },
            ],
          },
        ],
      },
      {
        entry: { id: "c1", type: "message", message: { role: "user", content: "second" } },
        children: [],
      },
    ],
    "c1",
  );

  it("records each row's parent so a subtree can be folded", () => {
    expect(rows.map((row) => [row.id, row.parentId])).toEqual([
      ["u1", null],
      ["a1", "u1"],
      ["b1", "a1"],
      ["c1", null],
    ]);
  });

  it("includes tool names, args and bash output in the searchable text", () => {
    const assistant = rows.find((row) => row.id === "a1");
    expect(assistant?.text).toMatch(/read/);
    expect(assistant?.text).toMatch(/a\.txt/);
    const bash = rows.find((row) => row.id === "b1");
    expect(bash?.text).toMatch(/ls/);
  });

  it("applies each filter", () => {
    // default: the bash row is not the leaf, so it is hidden.
    expect(filterSessionTreeRows(rows, "default").map((row) => row.id)).toEqual(["u1", "a1", "c1"]);
    expect(filterSessionTreeRows(rows, "no-tools").map((row) => row.id)).toEqual([
      "u1",
      "a1",
      "c1",
    ]);
    expect(filterSessionTreeRows(rows, "user-only").map((row) => row.id)).toEqual(["u1", "c1"]);
    expect(filterSessionTreeRows(rows, "all").map((row) => row.id)).toEqual([
      "u1",
      "a1",
      "b1",
      "c1",
    ]);
  });

  it("keeps a labeled row even when it is the only match under labeled-only", () => {
    const labeled = rows.map((row) => (row.id === "b1" ? { ...row, label: "note" } : row));
    expect(filterSessionTreeRows(labeled, "labeled-only").map((row) => row.id)).toEqual(["b1"]);
  });

  it("hides the descendants of a folded entry", () => {
    const visible = visibleSessionTreeRows(rows, {
      filter: "all",
      folded: new Set(["a1"]),
    });
    expect(visible.map((row) => row.id)).toEqual(["u1", "a1", "c1"]);
    const foldedRoot = visibleSessionTreeRows(rows, {
      filter: "all",
      folded: new Set(["u1"]),
    });
    expect(foldedRoot.map((row) => row.id)).toEqual(["u1", "c1"]);
  });

  it("searches rows and reports whether a row has children", () => {
    expect(
      visibleSessionTreeRows(rows, { filter: "all", query: "ls" }).map((row) => row.id),
    ).toEqual(["b1"]);
    expect(sessionTreeHasChildren(rows, "u1")).toBe(true);
    expect(sessionTreeHasChildren(rows, "c1")).toBe(false);
  });
});

describe("projected session list (session.list wire shape)", () => {
  const projected = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    path: "/p/a.jsonl",
    id: "a",
    cwd: "/work/a",
    name: null,
    created: 1,
    modified: 2,
    messageCount: 3,
    title: "A title",
    ...overrides,
  });

  it("prefers a host-computed title over the name and first message", () => {
    const session = sanitizeSessionSummary(
      rawSession({ title: "Host title", name: "Name", firstMessage: "First" }),
    )!;
    expect(sessionDisplayTitle(session)).toBe("Host title");
  });

  it("sanitizes a projected row without transcript text", () => {
    const session = sanitizeSessionSummary(projected())!;
    expect(session).toMatchObject({
      path: "/p/a.jsonl",
      id: "a",
      cwd: "/work/a",
      messageCount: 3,
      title: "A title",
      firstMessage: "",
      allMessagesText: "",
      parentSessionPath: null,
    });
    expect(sessionDisplayTitle(session)).toBe("A title");
  });

  it("projects only the rendered fields and bounds a long name", () => {
    const session = sanitizeSessionSummary(
      rawSession({ name: "n".repeat(300), firstMessage: "first", allMessagesText: "deep text" }),
    )!;
    const entry = projectSessionListEntry(session);
    expect(entry.title.length).toBe(90);
    expect(entry.title.endsWith("…")).toBe(true);
    expect(entry).not.toHaveProperty("allMessagesText");
    expect(entry).not.toHaveProperty("firstMessage");
    expect(entry).not.toHaveProperty("parentSessionPath");
  });

  it("searches message text that is not on the wire", () => {
    const all = sanitizeSessionList([
      rawSession({ path: "/p/a.jsonl", id: "a", allMessagesText: "alpha hidden phrase" }),
      rawSession({ path: "/p/b.jsonl", id: "b", allMessagesText: "beta" }),
    ]);
    const page = projectSessionListPage(all, { query: "hidden" });
    expect(page.sessions.map((entry) => entry.id)).toEqual(["a"]);
    expect(JSON.stringify(page.sessions)).not.toContain("hidden phrase");
  });

  it("applies scope, named-only and sort before capping", () => {
    const all = sanitizeSessionList([
      rawSession({ path: "/p/a.jsonl", id: "a", cwd: "/work/a", modified: 1 }),
      rawSession({ path: "/p/b.jsonl", id: "b", cwd: "/work/a", modified: 3 }),
      rawSession({ path: "/p/c.jsonl", id: "c", cwd: "/work/b", modified: 2 }),
      rawSession({ path: "/p/d.jsonl", id: "d", name: undefined, cwd: "/work/a", modified: 0 }),
    ]);
    expect(
      projectSessionListPage(all, { scope: "current", cwd: "/work/a" }).sessions.map(
        (entry) => entry.id,
      ),
    ).toEqual(["b", "a", "d"]);
    expect(projectSessionListPage(all, { namedOnly: true }).sessions.map((e) => e.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(projectSessionListPage(all, { limit: 2 }).sessions.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("returns a query error instead of rows", () => {
    const all = sanitizeSessionList([rawSession()]);
    const page = projectSessionListPage(all, { query: "re:(" });
    expect(page.sessions).toEqual([]);
    expect(page.error).toMatch(/regular expression/i);
  });

  it("keeps the page under the spill threshold even with long names and 2000 rows", () => {
    const many = Array.from({ length: MAX_SESSION_SUMMARIES }, (_, index) =>
      sanitizeSessionSummary(
        rawSession({
          path: `/p/${index}/${"x".repeat(180)}.jsonl`,
          id: `${index}`.padStart(6, "0"),
          cwd: `/work/${"y".repeat(100)}`,
          name: "n".repeat(400),
          modified: 10_000 - index,
        }),
      )!,
    );
    const page = projectSessionListPage(many);
    expect(page.sessions.length).toBeGreaterThan(0);
    expect(page.sessions.length).toBeLessThan(many.length);
    expect(page.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(
      BLOB_SPILL_THRESHOLD_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      MAX_SESSION_LIST_BYTES + 4 * 1024,
    );
  });

  it("parses a page and rejects anything without a sessions array", () => {
    const page = parseSessionListPage({
      sessions: [projected(), { nope: true }],
      total: 9,
      matched: 1,
      truncated: true,
      error: null,
    });
    expect(page.sessions).toHaveLength(1);
    expect(page).toMatchObject({ total: 9, matched: 1, truncated: true, error: null });
    expect(() => parseSessionListPage({ $blob: "/blobs/1.json", bytes: 99 })).toThrow(
      /unreadable session list/i,
    );
    expect(() => parseSessionListPage(undefined)).toThrow(/unreadable session list/i);
  });

  it("parses and clamps the host query", () => {
    expect(parseSessionListQuery(undefined)).toMatchObject({
      scope: "all",
      sort: "recent",
      namedOnly: false,
      cwd: null,
    });
    expect(
      parseSessionListQuery({
        query: "q".repeat(9000),
        scope: "current",
        cwd: "/work",
        sort: "relevance",
        namedOnly: true,
        limit: 99_999,
        refresh: true,
      }),
    ).toMatchObject({
      query: "q".repeat(4000),
      scope: "current",
      cwd: "/work",
      sort: "relevance",
      namedOnly: true,
      limit: MAX_SESSION_SUMMARIES,
      refresh: true,
    });
    expect(parseSessionListQuery({ sort: "nonsense", limit: 0 })).toMatchObject({
      sort: "recent",
      limit: 1,
    });
  });
});
