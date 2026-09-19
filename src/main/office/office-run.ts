/**
 * Tracks the Office session's current run so a surface can render it exactly the
 * way the task pane experiences it, and stop it.
 *
 * Where deltas come from: the office session runs inside a Pi host process that
 * loads the bridge extension. A pane-typed prompt is injected into that session
 * as a user message (prefixed with the bridge's document tag), so the assistant
 * text streams through the ordinary session event stream — `message_update`
 * frames already mirrored to main by `src/host/events.ts`. The same frames are
 * what the bridge forwards to the pane as protocol v3 `agent_message` deltas, so
 * the app never needs a second WebSocket client to see pane traffic.
 *
 * Where Stop goes: through the session. The run belongs to the pane, but the app
 * owns the session that is executing it, so `session.abort` stops it for every
 * bridge version. (Protocol v3 additionally lets a *pane* stop its own run by
 * sending the `abort` frame; that path lives in the bridge extension.)
 *
 * The buffer itself (`createStreamBuffer`) owns the v2/v3 rendering rules: a
 * bridge without deltas simply never calls `applyDelta`, and the final message
 * still lands — so an older bridge degrades without a branch in the UI.
 */

import {
  createStreamBuffer,
  parsePaneDocumentTag,
  type OfficeRunView,
  type OfficeStopResult,
  type PaneDocumentTag,
} from "../../shared/office-bridge";

export type { OfficeRunView, OfficeStopResult };

/** One mirrored host event (`src/host/events.ts` `eventToFrame`). */
export interface OfficeRunEvent {
  event: string;
  payload?: unknown;
}

export interface OfficeRunDeps {
  /** Subscribe to office-session host events. Returns an unsubscribe function. */
  subscribe: (listener: (event: OfficeRunEvent) => void) => () => void;
  /** Abort the office session's current run. */
  abort: () => Promise<void>;
  /** Injectable clock (tests use a fixed one). */
  now?: () => number;
}

export interface OfficeRunTracker {
  view(): OfficeRunView;
  stop(): Promise<OfficeStopResult>;
  /** Unsubscribe from host events. */
  dispose(): void;
}

/** Flatten SDK message content (string, or text parts) into plain text. */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const text = (part as { text?: unknown } | null | undefined)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function roleOf(message: unknown): string | null {
  const role = (message as { role?: unknown } | null | undefined)?.role;
  return typeof role === "string" ? role : null;
}

/**
 * Partial assistant text carried by a `message_update`. Mirrors the bridge's
 * reader: only `text_delta` is user-visible prose, and an unknown shape degrades
 * to "no deltas" rather than throwing mid-stream.
 */
function deltaText(payload: unknown): string | null {
  const update = (payload as { assistantMessageEvent?: unknown } | null | undefined)
    ?.assistantMessageEvent as { type?: unknown; delta?: unknown } | null | undefined;
  if (!update || typeof update !== "object") return null;
  if (update.type !== "text_delta") return null;
  return typeof update.delta === "string" && update.delta.length > 0 ? update.delta : null;
}

export function createOfficeRunTracker(deps: OfficeRunDeps): OfficeRunTracker {
  const now = deps.now ?? (() => Date.now());
  const buffer = createStreamBuffer();

  let active = false;
  let paneInitiated = false;
  let document: PaneDocumentTag | null = null;
  let startedAt: number | null = null;
  let endedAt: number | null = null;

  const view = (): OfficeRunView => {
    const current = buffer.snapshot();
    return {
      active,
      streaming: current.streaming,
      text: current.text,
      chunks: current.chunks,
      truncated: current.truncated,
      paneInitiated,
      document,
      startedAt,
      endedAt,
    };
  };

  const beginRun = (paneTag: PaneDocumentTag | null): void => {
    buffer.begin(null);
    active = true;
    paneInitiated = paneTag !== null;
    document = paneTag;
    startedAt = now();
    endedAt = null;
  };

  const settle = (): void => {
    if (!active) return;
    active = false;
    // Keep the partial text visible, but stop claiming it is still arriving.
    buffer.end();
    endedAt = now();
  };

  const handle = (frame: OfficeRunEvent): void => {
    const payload = frame.payload;
    switch (frame.event) {
      case "message_start": {
        const message = (payload as { message?: unknown } | null | undefined)?.message;
        if (roleOf(message) !== "user") return;
        beginRun(parsePaneDocumentTag(textOf(message)));
        return;
      }
      case "message_update": {
        if (!active) return;
        const text = deltaText(payload);
        if (text === null) return;
        buffer.applyDelta({ text });
        return;
      }
      case "message_end": {
        if (!active) return;
        const message = (payload as { message?: unknown } | null | undefined)?.message;
        if (roleOf(message) !== "assistant") return;
        buffer.applyFinal(textOf(message));
        return;
      }
      case "agent_settled":
      case "agent_end": {
        settle();
        return;
      }
      default:
        return;
    }
  };

  const unsubscribe = deps.subscribe(handle);

  return {
    view,
    async stop(): Promise<OfficeStopResult> {
      if (!active) return { ok: false, reason: "idle" };
      try {
        await deps.abort();
        settle();
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    dispose() {
      unsubscribe();
    },
  };
}
