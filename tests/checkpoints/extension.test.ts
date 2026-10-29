import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import checkpointExtension, {
  CHECKPOINT_ENTRY_TYPE,
  MAX_TRACKED_CHECKPOINTS,
  parseCheckpointEntry,
  promptSnippet,
  relativeLabel,
  sweepOldShadowRepos,
  type CheckpointCommandContext,
  type CheckpointEntryData,
  type CheckpointExtensionApi,
  type CheckpointExtensionContext,
} from "../../src/extensions/pi-checkpoints";
import type { CheckpointStore, SnapshotRequest } from "../../src/checkpoints/store";
import {
  DEFAULT_CHECKPOINT_CONFIG,
  type Checkpoint,
  type CheckpointConfig,
} from "../../src/shared/checkpoints";

/**
 * The checkpoint extension (git-checkpoint plan step 23).
 *
 * The fake API below is the *whole* SDK this file may touch: the extension is a
 * structural consumer, so a test can drive the real event order (agent_start →
 * turn_start → turn_end) without starting an agent, and the architecture check in
 * `describe("import surface")` proves the artifact stays loadable with no
 * `node_modules`.
 */

const CWD = "/work/reports";
const PROFILE = "/profile";
const NOW = 1_700_000_000_000;

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: "a".repeat(40),
    ref: "a".repeat(40),
    createdAt: NOW,
    kind: "run",
    label: "Do the thing",
    entryId: null,
    sessionId: null,
    files: 1,
    bytes: 10,
    skipped: 0,
    note: null,
    ...overrides,
  };
}

interface Harness {
  api: CheckpointExtensionApi;
  store: CheckpointStore & { snapshots: SnapshotRequest[]; restores: string[] };
  appended: { customType: string; data: unknown }[];
  notifications: { message: string; type?: string }[];
  navigations: { targetId: string; options?: { summarize?: boolean } }[];
  editorTexts: string[];
  /** Fires one event the way Pi would. */
  fire(
    event: "session_start" | "agent_start" | "turn_start" | "turn_end",
    payload?: unknown,
  ): Promise<void>;
  fireFork(entryId: string): Promise<unknown>;
  /** Runs `/rewind` and answers its two pickers. */
  rewind(choices: { target?: string; mode?: string }): Promise<void>;
  /** The picker labels the extension offered, in order. */
  labels(): string[];
  contexts: { ctx: CheckpointExtensionContext; entries: unknown[]; sessionId: string };
}

function harness(
  options: {
    config?: Partial<CheckpointConfig>;
    entries?: unknown[];
    snapshot?: (request: SnapshotRequest) => Awaited<ReturnType<CheckpointStore["snapshot"]>>;
    restore?: () => Awaited<ReturnType<CheckpointStore["restore"]>>;
    navigationCancelled?: boolean;
  } = {},
): Harness {
  const snapshots: SnapshotRequest[] = [];
  const restores: string[] = [];
  const appended: { customType: string; data: unknown }[] = [];
  const notifications: { message: string; type?: string }[] = [];
  const navigations: { targetId: string; options?: { summarize?: boolean } }[] = [];
  const editorTexts: string[] = [];
  let picker: { title: string; options: string[] } | null = null;
  const offered: string[][] = [];

  const entries: unknown[] = options.entries ?? [];
  const contexts = {
    entries,
    sessionId: "session-1",
    ctx: {
      cwd: CWD,
      sessionManager: {
        getSessionId: () => "session-1",
        getEntries: () => entries as { type: string; customType?: string; data?: unknown }[],
      },
    } satisfies CheckpointExtensionContext,
  };

  const store = {
    snapshots,
    restores,
    async ensure() {
      return { ok: true, shadowDir: "/profile/checkpoints/reports" };
    },
    async snapshot(_cwd: string, request: SnapshotRequest) {
      snapshots.push(request);
      if (options.snapshot) return options.snapshot(request);
      return { ok: true, checkpoint: checkpoint({ kind: request.kind, label: request.label }) };
    },
    async list() {
      return [];
    },
    async usage() {
      return { checkpoints: 0, bytes: 0 };
    },
    async preview() {
      return { restore: [], remove: [], unchanged: 0 };
    },
    async restore(_cwd: string, ref: string) {
      restores.push(ref);
      return options.restore?.() ?? { ok: true, restored: 1, removed: 0, failed: [] };
    },
    async prune() {
      return { dropped: 0 };
    },
  } as unknown as Harness["store"];

  /** The options of the most recent *rewind* picker (not the mode picker). */
  let rewindOptions: string[] = [];

  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<
    string,
    (args: string, ctx: CheckpointCommandContext) => Promise<void>
  >();

  const api: CheckpointExtensionApi = {
    on(event, handler) {
      handlers.set(event, handler as (event: unknown, ctx: unknown) => unknown);
      return () => handlers.delete(event);
    },
    appendEntry(customType, data) {
      appended.push({ customType, data });
      // Pi persists the entry immediately; the context must reflect it, or a
      // `rehydrate` inside `/rewind` would not see what this turn just appended.
      entries.push({ type: "custom", customType, data });
    },
    registerCommand(name, options) {
      commands.set(name, options.handler);
    },
  };

  checkpointExtension(api, {
    profileDir: PROFILE,
    store,
    config: async () => ({ ...DEFAULT_CHECKPOINT_CONFIG, ...options.config }),
    now: () => NOW,
  });

  const ctxWithUi: CheckpointCommandContext = {
    ...contexts.ctx,
    ui: {
      async select(title, choices) {
        picker = { title, options: choices };
        offered.push(choices);
        if (title.includes("Rewind")) rewindOptions = choices;
        const wanted = title.includes("Rewind") ? choices[0] : availableMode(choices);
        return wanted;
      },
      notify(message, type) {
        notifications.push({ message, ...(type ? { type } : {}) });
      },
      setEditorText(text) {
        editorTexts.push(text);
      },
    },
    navigateTree: async (targetId, navOptions) => {
      navigations.push({ targetId, ...(navOptions ? { options: navOptions } : {}) });
      return { cancelled: options.navigationCancelled ?? false };
    },
  };

  // The mode picker answers with whatever the test asked for.
  let wantedMode: string | undefined;
  const availableMode = (choices: string[]): string | undefined => {
    if (wantedMode && choices.includes(wantedMode)) return wantedMode;
    return choices[0];
  };

  return {
    api,
    store,
    appended,
    notifications,
    navigations,
    editorTexts,
    contexts,
    async fire(event, payload = {}) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler for ${event}`);
      // Real Pi hands every handler the UI-capable context, which is how the
      // extension reports a failed snapshot.
      await handler(payload, ctxWithUi);
    },
    async fireFork(entryId) {
      const handler = handlers.get("session_before_fork");
      if (!handler) return undefined;
      return handler({ entryId }, ctxWithUi);
    },
    async rewind(choices) {
      wantedMode = choices.mode;
      const handler = commands.get("rewind");
      if (!handler) throw new Error("rewind was not registered");
      await handler("", ctxWithUi);
      // The first select's answer is driven by `choices.target`, so re-run with
      // the wanted label when one was named.
      if (choices.target) {
        const first = offered[0] ?? [];
        const index = first.findIndex((label) => label.includes(choices.target ?? ""));
        if (index >= 0) {
          // Rewrite the picker's first answer and re-run.
          const chosen = first[index] as string;
          const retry: CheckpointCommandContext = {
            ...ctxWithUi,
            ui: {
              ...ctxWithUi.ui,
              async select(title, options2) {
                if (title.includes("Rewind")) return chosen;
                return wantedMode && options2.includes(wantedMode) ? wantedMode : options2[0];
              },
            },
          };
          await handler("", retry);
        }
      }
    },
    labels() {
      // The rewind picker, not the mode picker that immediately follows it.
      return rewindOptions.length > 0 ? rewindOptions : (picker?.options ?? []);
    },
  };
}

/** A `message` entry carrying a user prompt, as Pi writes it. */
function userMessage(text: string): { type: string; data?: unknown } {
  return {
    type: "message",
    data: { role: "user", content: [{ type: "text", text }] },
  };
}

function customEntry(entryId: string, ref: string): unknown {
  const data: CheckpointEntryData = {
    entryId,
    ref,
    prompt: "earlier",
    createdAt: NOW - 1000,
    kind: "run",
  };
  return { type: "custom", customType: CHECKPOINT_ENTRY_TYPE, data };
}

describe("session_start", () => {
  it("rehydrates the checkpoints this session already has", async () => {
    const h = harness({ entries: [customEntry("e1", "a".repeat(40))] });
    await h.fire("session_start", { reason: "resume" });
    // The rehydrated entry is what `/rewind` lists, with no new snapshot taken.
    await h.rewind({});
    expect(h.labels()[0]).toContain("earlier");
    // No *run* snapshot was taken: the only snapshot here is the rewind's own
    // safety net, which is a different kind.
    expect(h.store.snapshots.filter((request) => request.kind === "run")).toEqual([]);
  });

  it("ignores a malformed custom entry instead of failing the session", async () => {
    const h = harness({
      entries: [
        { type: "custom", customType: CHECKPOINT_ENTRY_TYPE, data: { ref: "not-a-sha" } },
        { type: "custom", customType: CHECKPOINT_ENTRY_TYPE },
        { type: "custom", customType: CHECKPOINT_ENTRY_TYPE, data: "nonsense" },
      ],
    });
    await expect(h.fire("session_start", { reason: "startup" })).resolves.toBeUndefined();
    await h.rewind({});
    // Nothing to offer, and the message says so rather than an empty picker.
    expect(h.notifications.at(-1)?.message).toMatch(/no checkpoints/i);
  });

  it("warns once when git is missing", async () => {
    const h = harness();
    (h.store as unknown as { ensure: () => Promise<unknown> }).ensure = async () => ({
      ok: false,
      shadowDir: "/x",
      reason: "git_missing",
    });
    await h.fire("session_start", { reason: "startup" });
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]?.message).toMatch(/need git/i);
    // A reload must not repeat the warning.
    await h.fire("session_start", { reason: "reload" });
    expect(h.notifications).toHaveLength(1);
  });

  it("survives a store that throws", async () => {
    const h = harness();
    (h.store as unknown as { ensure: () => Promise<unknown> }).ensure = async () => {
      throw new Error("boom");
    };
    await expect(h.fire("session_start", { reason: "startup" })).resolves.toBeUndefined();
  });
});

describe("the run snapshot", () => {
  it("takes exactly one snapshot for a two-turn run", async () => {
    const h = harness({ entries: [userMessage("add a chart to the report")] });
    await h.fire("session_start", { reason: "new" });
    await h.fire("agent_start");
    await h.fire("turn_start");
    await h.fire("turn_end", { messageEntryId: "e1" });
    // A second turn in the same run: no second snapshot.
    await h.fire("turn_start");
    await h.fire("turn_end", { messageEntryId: "e2" });

    expect(h.store.snapshots).toHaveLength(1);
    expect(h.store.snapshots[0]).toMatchObject({ kind: "run" });
    // The prompt is the label, so the timeline row says what the run was for.
    expect(h.store.snapshots[0]?.label).toBe("add a chart to the report");
  });

  it("does not duplicate the entry when a retry re-fires agent_start", async () => {
    const h = harness({ entries: [userMessage("do it")] });
    await h.fire("session_start", { reason: "new" });
    await h.fire("agent_start");
    await h.fire("turn_start");
    await h.fire("turn_end", { messageEntryId: "e1" });

    // Retry: the same message entry comes back.
    await h.fire("agent_start");
    await h.fire("turn_start");
    await h.fire("turn_end", { messageEntryId: "e1" });

    expect(h.appended).toHaveLength(1);
  });

  it("appends the durable entry under the documented custom type", async () => {
    const h = harness({ entries: [userMessage("ship it")] });
    await h.fire("session_start", { reason: "new" });
    await h.fire("agent_start");
    await h.fire("turn_start");
    await h.fire("turn_end", { messageEntryId: "e9" });

    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]?.customType).toBe("pi.checkpoint");
    expect(h.appended[0]?.data).toMatchObject({
      entryId: "e9",
      ref: "a".repeat(40),
      kind: "run",
      createdAt: NOW,
      prompt: "ship it",
    });
  });

  it("respects the disabled switch and never touches the store", async () => {
    const h = harness({ config: { enabled: false }, entries: [userMessage("x")] });
    await h.fire("session_start", { reason: "new" });
    await h.fire("agent_start");
    await h.fire("turn_start");
    await h.fire("turn_end", { messageEntryId: "e1" });
    expect(h.store.snapshots).toEqual([]);
    expect(h.appended).toEqual([]);
  });

  it("treats same_tree as normal (nothing to record)", async () => {
    const h = harness({
      entries: [userMessage("x")],
      snapshot: () => ({ ok: false, reason: "same_tree" }),
    });
    await h.fire("session_start", { reason: "new" });
    await h.fire("agent_start");
    await h.fire("turn_start");
    await h.fire("turn_end", { messageEntryId: "e1" });
    expect(h.appended).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it("warns about a real failure instead of throwing", async () => {
    const h = harness({
      entries: [userMessage("x")],
      snapshot: () => ({ ok: false, reason: "git_failed", detail: "index.lock" }),
    });
    await h.fire("session_start", { reason: "new" });
    await h.fire("agent_start");
    await h.fire("turn_start");
    expect(h.notifications.at(-1)?.message).toContain("index.lock");
  });

  it("does nothing when a turn starts without an armed run", async () => {
    const h = harness({ entries: [userMessage("x")] });
    await h.fire("session_start", { reason: "new" });
    await h.fire("turn_start");
    await h.fire("turn_end", { messageEntryId: "e1" });
    expect(h.store.snapshots).toEqual([]);
  });

  it("keeps the in-memory list bounded", async () => {
    const entries: unknown[] = [];
    for (let index = 0; index < MAX_TRACKED_CHECKPOINTS + 5; index += 1) {
      entries.push(customEntry(`e${index}`, String(index % 10).repeat(40)));
    }
    const h = harness({ entries });
    await h.fire("session_start", { reason: "resume" });
    await h.rewind({});
    expect(h.labels().length).toBeLessThanOrEqual(MAX_TRACKED_CHECKPOINTS);
  });
});

describe("session_before_fork", () => {
  it("names the fork point's checkpoint without blocking the fork", async () => {
    const h = harness({ entries: [customEntry("e1", "b".repeat(40))] });
    await h.fire("session_start", { reason: "resume" });
    const result = await h.fireFork("e1");
    expect(result).toBeUndefined();
    expect(h.notifications.at(-1)?.message).toContain("bbbbbbbb");
  });

  it("stays silent when the fork point has no checkpoint", async () => {
    const h = harness();
    await h.fire("session_start", { reason: "resume" });
    expect(await h.fireFork("nope")).toBeUndefined();
    expect(h.notifications).toEqual([]);
  });
});

describe("/rewind", () => {
  it("restores files, then navigates the tree, then refills the editor", async () => {
    const h = harness({ entries: [customEntry("e1", "c".repeat(40))] });
    await h.fire("session_start", { reason: "resume" });
    await h.rewind({ mode: "Files and conversation" });

    // A pre-restore snapshot strictly precedes the restore (D10).
    expect(h.store.snapshots[0]).toMatchObject({ kind: "pre-restore" });
    expect(h.store.restores).toEqual(["c".repeat(40)]);
    expect(h.navigations[0]).toMatchObject({ targetId: "e1", options: { summarize: false } });
    expect(h.editorTexts).toEqual(["earlier"]);
  });

  it("Files only leaves the conversation alone", async () => {
    const h = harness({ entries: [customEntry("e1", "d".repeat(40))] });
    await h.fire("session_start", { reason: "resume" });
    await h.rewind({ mode: "Files only" });
    expect(h.store.restores).toHaveLength(1);
    expect(h.navigations).toEqual([]);
  });

  it("Conversation only leaves the files alone", async () => {
    const h = harness({ entries: [customEntry("e1", "e".repeat(40))] });
    await h.fire("session_start", { reason: "resume" });
    await h.rewind({ mode: "Conversation only" });
    expect(h.store.snapshots).toEqual([]);
    expect(h.store.restores).toEqual([]);
    expect(h.navigations).toHaveLength(1);
  });

  it("aborts the rewind when the safety snapshot fails", async () => {
    const h = harness({
      entries: [customEntry("e1", "f".repeat(40))],
      snapshot: () => ({ ok: false, reason: "git_failed", detail: "disk full" }),
    });
    await h.fire("session_start", { reason: "resume" });
    await h.rewind({ mode: "Files only" });
    expect(h.store.restores).toEqual([]);
    expect(h.notifications.at(-1)?.message).toContain("disk full");
  });

  it("aborts when the restore itself fails", async () => {
    const h = harness({
      entries: [customEntry("e1", "1".repeat(40))],
      restore: () => ({ ok: false, restored: 0, removed: 0, failed: [], detail: "locked" }),
    });
    await h.fire("session_start", { reason: "resume" });
    await h.rewind({ mode: "Files only" });
    expect(h.notifications.at(-1)?.message).toContain("locked");
    // The conversation was not rewound either: a half-rewind would be worse.
    expect(h.navigations).toEqual([]);
  });

  it("says so when the conversation rewind was cancelled", async () => {
    const h = harness({ entries: [customEntry("e1", "2".repeat(40))], navigationCancelled: true });
    await h.fire("session_start", { reason: "resume" });
    await h.rewind({ mode: "Conversation only" });
    // `navigateTree` reported `cancelled`, so the editor is left alone and the
    // user is told the conversation did not move.
    expect(h.navigations).toHaveLength(1);
    expect(h.notifications.at(-1)?.message).toMatch(/not rewound/i);
    expect(h.editorTexts).toEqual([]);
  });

  it("rehydrates before listing, so an entry appended this turn is offered", async () => {
    const h = harness({ entries: [userMessage("go")] });
    await h.fire("session_start", { reason: "new" });
    await h.fire("agent_start");
    await h.fire("turn_start");
    await h.fire("turn_end", { messageEntryId: "e1" });
    await h.rewind({});
    expect(h.labels()[0]).toContain("aaaaaaa");
  });
});

describe("pure helpers", () => {
  it("reads the newest user prompt as the run's label", () => {
    expect(promptSnippet([userMessage("first"), userMessage("second")])).toBe("second");
    expect(promptSnippet([])).toBe("");
    // Assistant messages and tool results are not prompts.
    expect(promptSnippet([{ type: "message", data: { role: "assistant", content: "hi" } }])).toBe(
      "",
    );
  });

  it("collapses whitespace so a multi-line prompt fits one row", () => {
    expect(promptSnippet([userMessage("  add a\n chart  ")])).toBe("add a chart");
  });

  it("parses a well-formed entry and rejects everything else", () => {
    expect(
      parseCheckpointEntry({
        entryId: "e1",
        ref: "a".repeat(40),
        prompt: "p",
        createdAt: NOW,
        kind: "run",
      }),
    ).toMatchObject({ entryId: "e1", kind: "run" });
    expect(parseCheckpointEntry(null)).toBeNull();
    expect(parseCheckpointEntry({ entryId: "e1", ref: "short" })).toBeNull();
    expect(parseCheckpointEntry({ ref: "a".repeat(40) })).toBeNull();
  });

  it("defaults an unknown kind instead of dropping the entry", () => {
    const parsed = parseCheckpointEntry({
      entryId: "e1",
      ref: "a".repeat(40),
      kind: "bogus",
    });
    expect(parsed?.kind).toBe("pre-restore");
  });

  it("formats a relative label", () => {
    expect(relativeLabel(NOW - 5_000, NOW)).toBe("just now");
    expect(relativeLabel(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(relativeLabel(0, NOW)).toBe("unknown");
  });
});

describe("the 30-day sweep", () => {
  const dirs = new Map<string, string>();
  const removed: string[] = [];
  const fs = {
    async pathKind() {
      return "directory" as const;
    },
    async readTextFile(target: string) {
      return dirs.get(target) ?? null;
    },
    async writeTextFile() {
      /* unused */
    },
    async ensureDir() {
      /* unused */
    },
    async size() {
      return 0;
    },
    async directorySize() {
      return 0;
    },
    async removeTree(target: string) {
      removed.push(target);
      return true;
    },
    async listDirs() {
      return [...dirs.keys()]
        .filter((target) => target.endsWith("/pi-work-tree"))
        .map((target) => target.split("/").slice(-2, -1)[0] ?? "");
    },
  };
  const store = {
    async list(_cwd: string) {
      return [{ createdAt: NOW - 40 * 24 * 3_600_000 }];
    },
  } as unknown as CheckpointStore;

  it("drops a repo whose newest checkpoint is past retention", async () => {
    dirs.set(`${PROFILE}/checkpoints/old-1234/pi-work-tree`, "/work/old");
    removed.length = 0;
    const count = await sweepOldShadowRepos(fs, PROFILE, store, NOW, 30);
    expect(count).toBe(1);
    expect(removed[0]).toContain("old-1234");
  });

  it("keeps a repo with a recent checkpoint", async () => {
    dirs.clear();
    removed.length = 0;
    dirs.set(`${PROFILE}/checkpoints/new-1234/pi-work-tree`, "/work/new");
    const recent = {
      async list() {
        return [{ createdAt: NOW - 1000 }];
      },
    } as unknown as CheckpointStore;
    expect(await sweepOldShadowRepos(fs, PROFILE, recent, NOW, 30)).toBe(0);
    expect(removed).toEqual([]);
  });

  it("does nothing when the port cannot list directories", async () => {
    const bare = { ...fs, listDirs: undefined } as never;
    expect(await sweepOldShadowRepos(bare, PROFILE, store, NOW, 30)).toBe(0);
  });
});

describe("import surface", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

  it("imports neither the SDK nor electron nor node:fs", async () => {
    const source = await readFile(join(repoRoot, "src/extensions/pi-checkpoints.ts"), "utf8");
    // The artifact must load with no `node_modules` next to it, and AGENTS rule 4
    // keeps SDK contact in `src/host/sdk/*`. Only import specifiers count: the
    // module's own doc comment *names* the SDK it refuses to depend on.
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((id) => id?.startsWith("@earendil-works"))).toEqual([]);
    expect(specifiers.filter((id) => id === "electron")).toEqual([]);
    expect(specifiers.filter((id) => id?.startsWith("node:fs"))).toEqual([]);
    // Everything it does import is relative: the bundler inlines those.
    expect(specifiers.every((id) => id?.startsWith("."))).toBe(true);
  });
});
