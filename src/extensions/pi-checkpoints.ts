/**
 * The checkpoint extension: run-scoped snapshots and `/rewind` (git-checkpoint
 * plan step 23).
 *
 * Pi Desktop takes *manual* and *pre-op* checkpoints from main, but a snapshot
 * "before the agent touches anything" has to come from inside the agent loop:
 * only the extension API sees `agent_start`, `turn_start` and the durable entry
 * id a turn produces. So this file is a normal Pi extension, loaded two ways:
 *
 *  - **Automatically** by the app's host through `additionalExtensionPaths`
 *    (step 24; hard-disabled in safe mode).
 *  - **Manually** in terminal Pi, from the artifact `scripts/build-extension.mjs`
 *    produces under `dist/pi-checkpoints/`.
 *
 * Both loads matter, and they are the same code: the shadow repo is keyed by the
 * *folder*, so a checkpoint taken by the app shows up in terminal `/rewind` and
 * vice versa.
 *
 * ## Why the types are structural
 *
 * This module imports **neither** `@earendil-works/*` nor `electron`. AGENTS rule
 * 4 keeps SDK contact inside `src/host/sdk/*`, and an artifact that imported the
 * SDK would need a `node_modules` tree next to it to load at all. The narrow
 * `CheckpointExtensionApi` below mirrors only the members actually used, exactly
 * as `src/renderer/src/completion/types.ts` and `src/shared/model-scope.ts`
 * mirror theirs.
 */

import { createNodeGitRunner } from "../git/runner";
import { createCheckpointStore, type CheckpointStore } from "../checkpoints/store";
import type { CheckpointFs } from "../checkpoints/store";
import { createNodeCheckpointFs } from "../checkpoints/fs";
import { checkpointConfigPath, readConfig, CheckpointConfigError } from "../checkpoints/config";
import {
  DEFAULT_CHECKPOINT_CONFIG,
  checkpointsRoot,
  projectKeyFor,
  shadowDirFor,
  type Checkpoint,
  type CheckpointConfig,
  type CheckpointKind,
} from "../shared/checkpoints";

/* ------------------------------------------------ the structural SDK shape */

/** The custom-entry type every checkpoint is recorded under in the session log. */
export const CHECKPOINT_ENTRY_TYPE = "pi.checkpoint";

/** How many checkpoints the extension keeps in memory (matches D14's cap). */
export const MAX_TRACKED_CHECKPOINTS = 100;

/** The session-entry payload a `pi.checkpoint` entry carries. */
export interface CheckpointEntryData {
  entryId: string;
  ref: string;
  prompt: string;
  createdAt: number;
  kind: CheckpointKind;
}

/** A minimal `ExtensionContext`: the members this extension reads. */
export interface CheckpointExtensionContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getEntries(): readonly { type: string; customType?: string; data?: unknown }[];
  };
}

/** A minimal `ExtensionCommandContext`: adds the tree navigation `/rewind` needs. */
export interface CheckpointCommandContext extends CheckpointExtensionContext {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setEditorText(text: string): void;
  };
  navigateTree(
    targetId: string,
    options?: { summarize?: boolean },
  ): Promise<{ cancelled: boolean }>;
}

export interface CheckpointExtensionApi {
  on(
    event: "session_start",
    handler: (event: { reason: string }, ctx: CheckpointExtensionContext) => Promise<void> | void,
  ): () => void;
  on(
    event: "agent_start",
    handler: (event: unknown, ctx: CheckpointExtensionContext) => Promise<void> | void,
  ): () => void;
  on(
    event: "turn_start",
    handler: (event: unknown, ctx: CheckpointExtensionContext) => Promise<void> | void,
  ): () => void;
  on(
    event: "turn_end",
    handler: (
      event: { messageEntryId: string },
      ctx: CheckpointExtensionContext,
    ) => Promise<void> | void,
  ): () => void;
  on(
    event: "session_before_fork",
    handler: (
      event: { entryId: string },
      ctx: CheckpointExtensionContext,
    ) => Promise<{ cancel?: boolean } | void> | { cancel?: boolean } | void,
  ): () => void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: CheckpointCommandContext) => Promise<void>;
    },
  ): void;
}

/** The config the extension reads; injected so a test needs no filesystem. */
export interface CheckpointExtensionDeps {
  /** Where `checkpoints/` lives (from `PI_CODING_AGENT_DIR`). */
  profileDir: string;
  /** Test seam: the shadow-repo engine. Defaults to the Node one. */
  store?: CheckpointStore;
  /** Test seam: the config reader. Defaults to `<profile>/checkpoints/config.json`. */
  config?: () => Promise<CheckpointConfig>;
  now?: () => number;
}

/* ---------------------------------------------------------------- helpers */

/** The prompt text a turn was answering, trimmed for a timeline row. */
export function promptSnippet(entries: readonly { type: string; data?: unknown }[]): string {
  // Walk backwards: the newest user message is the prompt this run is for.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.type !== "message") continue;
    const data = entry.data as { role?: unknown; content?: unknown } | undefined;
    if (data?.role !== "user") continue;
    const text = textOf(data.content);
    if (text) return text.replace(/\s+/g, " ").trim().slice(0, 120);
  }
  return "";
}

/** Extracts plain text from a message's content (a string or a block array). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join(" ");
}

/** Parses a `pi.checkpoint` entry's payload, tolerating anything malformed. */
export function parseCheckpointEntry(data: unknown): CheckpointEntryData | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.entryId !== "string" || record.entryId.length === 0) return null;
  if (typeof record.ref !== "string" || !/^[0-9a-f]{40}$/.test(record.ref)) return null;
  return {
    entryId: record.entryId,
    ref: record.ref,
    prompt: typeof record.prompt === "string" ? record.prompt.slice(0, 300) : "",
    createdAt:
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
        ? record.createdAt
        : 0,
    kind:
      record.kind === "run" || record.kind === "manual" || record.kind === "pre-op"
        ? record.kind
        : "pre-restore",
  };
}

/** The shadow-repo layout for a folder, from the profile root. */
export function shadowDirForProfile(profileDir: string, cwd: string): string {
  return shadowDirFor(profileDir, cwd);
}

/**
 * Deletes shadow repos nothing has written to for `retentionDays` (D14's 30-day
 * sweep, run once at `session_start`).
 *
 * A repo is "untouched" when its newest commit is older than the cut-off. The
 * walk is best-effort: a permission error on one directory must not stop the
 * others or fail the session.
 */
export async function sweepOldShadowRepos(
  fs: CheckpointFs & { listDirs?(target: string): Promise<string[]> },
  profileDir: string,
  store: CheckpointStore,
  now: number,
  retentionDays: number,
): Promise<number> {
  if (!fs.listDirs) return 0;
  const root = checkpointsRoot(profileDir);
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of await fs.listDirs(root)) {
    const dir = `${root}/${name}`;
    const marker = await fs.readTextFile(`${dir}/pi-work-tree`);
    if (!marker?.trim()) continue;
    // The sidecar stores the work tree, not a counter; the commit log is the
    // only place the age of the newest snapshot exists.
    const checkpoints = await store.list(marker.trim(), { limit: 1 }).catch(() => []);
    const newest = checkpoints[0];
    if (!newest) continue;
    if (newest.createdAt >= cutoff) continue;
    if (await fs.removeTree(dir)) removed += 1;
  }
  return removed;
}

/* ------------------------------------------------------------- the factory */

/**
 * Builds the extension. A default export is what Pi's loader calls, and it takes
 * the API object as its only argument.
 */
export default function checkpointExtension(
  pi: CheckpointExtensionApi,
  deps: CheckpointExtensionDeps,
): void {
  const now = deps.now ?? ((): number => Date.now());
  const store =
    deps.store ??
    createCheckpointStore({
      runner: createNodeGitRunner(),
      fs: createNodeCheckpointFs(),
      profileDir: deps.profileDir,
    });
  const readConfigFor =
    deps.config ?? ((): Promise<CheckpointConfig> => readConfigOrDefault(deps.profileDir));

  /** This session's checkpoints, newest first (mirrors the durable entries). */
  let tracked: CheckpointEntryData[] = [];
  /** Armed by `agent_start`, consumed by the first `turn_start` of the run. */
  let runNeedsSnapshot = false;
  /** The ref the current run produced, waiting for its durable entry id. */
  let pendingRef: string | null = null;
  let pendingPrompt = "";
  /** The session id, kept for the entry payload and for Diagnostics. */
  let sessionId = "";

  const notify = (ctx: CheckpointExtensionContext, message: string): void => {
    const ui = (ctx as { ui?: { notify?: (m: string, t?: string) => void } }).ui;
    // RPC/print modes have no dialog UI; a missing notify is not an error.
    ui?.notify?.(message, "warning");
  };

  /** Reads the projected config, degrading on a malformed file (AGENTS rule 5). */
  const config = async (): Promise<CheckpointConfig> => {
    try {
      return await readConfigFor();
    } catch {
      // The file is reported by main (the only writer); this process must not
      // repair it, and a failed read must not stop a snapshot the user asked for.
      return DEFAULT_CHECKPOINT_CONFIG;
    }
  };

  const remember = (entry: CheckpointEntryData): void => {
    // The durable entry wins; keep the in-memory list bounded and de-duplicated
    // so a replay of `session_start` does not double-count.
    tracked = [entry, ...tracked.filter((known) => known.entryId !== entry.entryId)].slice(
      0,
      MAX_TRACKED_CHECKPOINTS,
    );
  };

  /** Rehydrates from the session log (a resume or a fork inherits its ancestors'). */
  const rehydrate = (ctx: CheckpointExtensionContext): void => {
    tracked = [];
    for (const raw of ctx.sessionManager.getEntries()) {
      if (raw.type !== "custom" || raw.customType !== CHECKPOINT_ENTRY_TYPE) continue;
      const parsed = parseCheckpointEntry(raw.data);
      if (parsed) remember(parsed);
    }
  };

  pi.on("session_start", async (event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    rehydrate(ctx);
    const settings = await config();
    // A reload must not re-run the sweep: it is a 30-day maintenance pass, not a
    // per-event cost.
    if (event.reason === "reload") return;
    const fs = createNodeCheckpointFs();
    await sweepOldShadowRepos(fs, deps.profileDir, store, now(), settings.retentionDays).catch(
      () => 0,
    );
    const probe = await store.ensure(ctx.cwd).catch(() => null);
    if (probe && !probe.ok && probe.reason === "git_missing") {
      notify(ctx, "Folder checkpoints need git; /rewind is unavailable in this folder.");
    }
  });

  pi.on("agent_start", () => {
    // Fires again for a retry or a follow-up; the duplicate is discarded at
    // `turn_end` when the entry id is already known.
    runNeedsSnapshot = true;
    pendingRef = null;
    pendingPrompt = "";
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!runNeedsSnapshot) return;
    runNeedsSnapshot = false;
    const settings = await config();
    if (!settings.enabled) return;
    const prompt = promptSnippet(ctx.sessionManager.getEntries());
    const result = await store.snapshot(ctx.cwd, {
      kind: "run",
      label: prompt || "Before the agent's turn",
      sessionId,
      maxFileBytes: settings.maxFileBytes,
      exclude: settings.exclude,
    });
    if (result.ok && result.checkpoint) {
      pendingRef = result.checkpoint.ref;
      pendingPrompt = prompt;
      return;
    }
    pendingRef = null;
    if (result.reason && result.reason !== "same_tree") {
      // git missing is reported once at session_start; anything else is worth a
      // line the first time it happens in this run.
      notify(ctx, `Checkpoint not taken: ${result.detail ?? result.reason}`);
    }
  });

  pi.on("turn_end", (event) => {
    const ref = pendingRef;
    pendingRef = null;
    if (!ref) return;
    const entryId = event.messageEntryId;
    if (!entryId) return;
    // A retry lands on the same message entry; it must not append a second entry
    // for one turn.
    if (tracked.some((known) => known.entryId === entryId)) return;
    const data: CheckpointEntryData = {
      entryId,
      ref,
      prompt: pendingPrompt,
      createdAt: now(),
      kind: "run",
    };
    pi.appendEntry(CHECKPOINT_ENTRY_TYPE, data);
    remember(data);
    pendingPrompt = "";
  });

  pi.on("session_before_fork", (event, ctx) => {
    // A fork point usually has a checkpoint. Restoring it *here* would be a modal
    // in front of every fork, so the extension only says where it is: the new
    // session inherits these entries, and `/rewind` in it reaches the same ref.
    // The hook still exists because a fork with no checkpoint is silent, and a
    // user who expected one should learn that before the fork happens.
    const found = tracked.find((entry) => entry.entryId === event.entryId);
    if (!found) return undefined;
    const ui = (ctx as { ui?: { notify?: (m: string, t?: string) => void } }).ui;
    ui?.notify?.(
      `This fork point has a checkpoint (${found.ref.slice(0, 8)}); /rewind in the new session restores it.`,
      "info",
    );
    return undefined;
  });

  pi.registerCommand("rewind", {
    description: "Restore the folder (and optionally the conversation) to an earlier checkpoint",
    async handler(_args, ctx) {
      rehydrate(ctx);
      if (tracked.length === 0) {
        ctx.ui.notify("No checkpoints for this session yet.", "info");
        return;
      }
      const labels = tracked.map(
        (entry, index) =>
          `${relativeLabel(entry.createdAt, now())} · ${entry.prompt || "Before the agent's turn"}` +
          ` · ${entry.ref.slice(0, 8)}${index === 0 ? " (newest)" : ""}`,
      );
      const chosen = await ctx.ui.select("Rewind to which checkpoint?", labels);
      if (!chosen) return;
      const index = labels.indexOf(chosen);
      const target = tracked[index];
      if (!target) return;

      const mode = await ctx.ui.select("What should be restored?", [
        "Files and conversation",
        "Files only",
        "Conversation only",
      ]);
      if (!mode) return;

      let filesRestored = false;
      if (mode !== "Conversation only") {
        // A pre-restore snapshot keeps the rewind undoable, exactly as the rail's
        // restore does (D10).
        const safety = await store.snapshot(ctx.cwd, {
          kind: "pre-restore",
          label: `Before rewinding to ${target.ref.slice(0, 8)}`,
          sessionId,
        });
        if (!safety.ok && safety.reason !== "same_tree") {
          ctx.ui.notify(
            `A safety snapshot is required before rewinding, and it failed: ${
              safety.detail ?? safety.reason ?? "unknown error"
            }`,
            "warning",
          );
          return;
        }
        const restored = await store.restore(ctx.cwd, target.ref);
        if (!restored.ok) {
          ctx.ui.notify(
            `The files could not be restored: ${restored.detail ?? "unknown error"}`,
            "warning",
          );
          return;
        }
        filesRestored = true;
      }

      let conversationRewound = false;
      if (mode !== "Files only") {
        const navigation = await ctx.navigateTree(target.entryId, { summarize: false });
        if (navigation.cancelled) {
          ctx.ui.notify("The conversation was not rewound.", "info");
        } else {
          conversationRewound = true;
          // Put the prompt back in the editor so the user can edit and resend it
          // rather than retyping it.
          ctx.ui.setEditorText(target.prompt);
        }
      }

      // Report what actually happened: a cancelled navigation after a successful
      // file restore must not read as "the rewind worked".
      if (filesRestored && conversationRewound) {
        ctx.ui.notify(`Rewound to ${target.ref.slice(0, 8)}: files and conversation.`, "info");
      } else if (filesRestored) {
        ctx.ui.notify(
          `Files restored to ${target.ref.slice(0, 8)}; the conversation was left alone.`,
          "info",
        );
      } else if (conversationRewound) {
        ctx.ui.notify(
          `Conversation rewound to ${target.ref.slice(0, 8)}; the files were left alone.`,
          "info",
        );
      }
    },
  });
}

/** `2h ago`, or `just now`, for the picker's rows. */
export function relativeLabel(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return "unknown";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/** The config reader, exported so the artifact and tests share one rule. */
async function readConfigOrDefault(profileDir: string): Promise<CheckpointConfig> {
  const fs = createNodeCheckpointFs();
  try {
    return (await readConfig({ fs, profileDir })).config;
  } catch (error) {
    if (error instanceof CheckpointConfigError) throw error;
    return DEFAULT_CHECKPOINT_CONFIG;
  }
}

/** Re-exported so a test (and step 25's rail) can name the file it reads. */
export { checkpointConfigPath, projectKeyFor };

/** The exported surface a caller may use without loading the default factory. */
export type { Checkpoint, CheckpointConfig };
