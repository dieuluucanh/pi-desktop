/**
 * Bridge protocol view model shared by the main process and the renderer.
 *
 * The Office bridge (`@dieulc/pi-office-bridge`) is the only part of the app
 * that ships on its own release cadence: the add-in task panes and the Pi
 * extension are published separately from Pi Desktop, so a user can run an
 * older bridge against a newer app. This module turns a `/health` snapshot into
 * a decidable capability set instead of scattering version comparisons — the
 * same three questions the UI needs to answer:
 *
 *  1. Does the bridge connect at all? (`shape: "unsupported"` when it is too
 *     old to accept our handshake — the server rejects it with
 *     `protocol_mismatch`.)
 *  2. Does text stream while the agent works? (`supportsDeltas`)
 *  3. Can a run be stopped from the task pane? (`supportsAbort`)
 *
 * Protocol v3 (bridge 0.5.0) is additive over v2: v2 panes still connect and
 * receive a single `final` reply. Nothing here may assume deltas exist.
 */

import { PI_OFFICE_BRIDGE } from "./office";

/** Office host apps that can attach a pane. `null` = the bridge did not say. */
export type BridgeHost = "excel" | "word" | "powerpoint" | null;

/**
 * How the connected bridge relates to what this app targets.
 *
 * - `unknown` — no usable `/health` (nothing is listening yet, or the payload
 *   was unparseable). Not an error: the wizard may simply not have started a
 *   session.
 * - `unsupported` — older than protocol v2, so the handshake is rejected.
 * - `older` — connects, but without the v3 features (finals only, no pane-side
 *   Stop).
 * - `current` — exactly the targeted protocol version.
 * - `newer` — a newer protocol than this app knows. Additive changes keep old
 *   clients working, so this is informational, never an error.
 */
export type BridgeShape = "unknown" | "unsupported" | "older" | "current" | "newer";

export interface BridgeCompatibilityInput {
  /** Protocol version reported by `/health`, or `null` when absent. */
  protocolVersion: number | null;
  /**
   * Capabilities advertised by `/health`. A `null`/absent array means a bridge
   * that predates capability advertisement: fall back to the version.
   */
  capabilities: readonly string[] | null;
  serverVersion?: string | null;
  catalogVersion?: number | null;
}

export interface BridgeCompatibility {
  shape: BridgeShape;
  protocolVersion: number | null;
  /** The protocol version this app targets (`PI_OFFICE_BRIDGE.knownProtocolVersion`). */
  targetProtocolVersion: number;
  serverVersion: string | null;
  catalogVersion: number | null;
  /** Streamed `agent_message` deltas reach the pane while the agent works. */
  supportsDeltas: boolean;
  /**
   * A **pane** can stop its run by sending the protocol `abort` frame. This is
   * narrower than "a run can be stopped": the app itself aborts through the
   * session it owns, which works against every bridge version.
   */
  supportsAbort: boolean;
  /** One-line, user-facing explanation of the shape (empty when current). */
  summary: string;
}

/** Read a capability flag, treating an absent array as "not advertised". */
function advertises(input: BridgeCompatibilityInput, capability: string): boolean {
  return input.capabilities?.includes(capability) ?? false;
}

/**
 * Decide what the connected bridge can do. Pure: same input, same output — the
 * version-skew rules live here and nowhere else.
 */
export function projectBridgeCompatibility(input: BridgeCompatibilityInput): BridgeCompatibility {
  const target = PI_OFFICE_BRIDGE.knownProtocolVersion;
  const protocol = input.protocolVersion;
  const declaredCapabilities = Array.isArray(input.capabilities);

  const base = {
    protocolVersion: protocol,
    targetProtocolVersion: target,
    serverVersion: input.serverVersion ?? null,
    catalogVersion: input.catalogVersion ?? null,
  } as const;

  if (protocol === null || !Number.isFinite(protocol)) {
    return {
      ...base,
      shape: "unknown",
      supportsDeltas: false,
      supportsAbort: false,
      summary:
        "The bridge did not report a protocol version — no Office session is hosting it yet.",
    };
  }

  if (protocol < 2) {
    return {
      ...base,
      shape: "unsupported",
      supportsDeltas: false,
      supportsAbort: false,
      summary: `Bridge protocol v${protocol} is too old: this app speaks v2 or newer, so the add-in handshake is rejected.`,
    };
  }

  // v3 features. A v3 bridge that does not advertise the capability array is
  // still trusted by version (capabilities are additive and optional).
  const supportsDeltas =
    protocol >= 3 && (!declaredCapabilities || advertises(input, "agent-deltas"));
  const supportsAbort =
    protocol >= 3 && (!declaredCapabilities || advertises(input, "client-abort"));

  if (protocol < target || (!supportsDeltas && !supportsAbort && protocol < target)) {
    return {
      ...base,
      shape: "older",
      supportsDeltas,
      supportsAbort,
      summary:
        "Final replies only: the bridge connects, but no text streams while the agent works and the task pane has no Stop button.",
    };
  }

  if (protocol > target) {
    return {
      ...base,
      shape: "newer",
      supportsDeltas,
      supportsAbort,
      summary: `Bridge protocol v${protocol} is newer than this app targets (v${target}); additive changes stay compatible.`,
    };
  }

  return { ...base, shape: "current", supportsDeltas, supportsAbort, summary: "" };
}

export interface StreamBufferSnapshot {
  /** The best text known so far. Deltas are partial; the final replaces them. */
  text: string;
  /** True between the first delta of a run and its final message. */
  streaming: boolean;
  /** Correlation id of the run being streamed, when the bridge provided one. */
  promptId: string | null;
  /** Delta frames applied to this run (diagnostics and tests). */
  chunks: number;
  /** True when the buffered text hit the display cap and stopped growing. */
  truncated: boolean;
}

export interface StreamBuffer {
  /** Start a run. Binds later deltas to `promptId` so runs cannot interleave. */
  begin(promptId?: string | null): StreamBufferSnapshot;
  /**
   * Apply one delta. A delta carrying a different `promptId` than the bound run
   * is ignored (a late frame from a previous prompt must never append to the
   * current answer).
   */
  applyDelta(chunk: { text: string; promptId?: string | null }): StreamBufferSnapshot;
  /** Apply the authoritative final reply: it replaces the delta text. */
  applyFinal(text: string): StreamBufferSnapshot;
  /**
   * Mark the run as no longer streaming, keeping the text received so far. Used
   * when a run ends without a final reply (aborted, or settled after tool calls).
   */
  end(): StreamBufferSnapshot;
  /** Drop everything (run finished, aborted, or the stream was abandoned). */
  reset(): StreamBufferSnapshot;
  snapshot(): StreamBufferSnapshot;
}

/**
 * Display cap for streamed text. Deltas are a preview — the final message is
 * authoritative and is applied regardless of this cap — so the buffer only has
 * to stay bounded long enough for the answer to start rendering.
 */
export const MAX_STREAM_CHARS = 200_000;

export function createStreamBuffer(): StreamBuffer {
  let text = "";
  let streaming = false;
  let promptId: string | null = null;
  let chunks = 0;
  let truncated = false;

  const snapshot = (): StreamBufferSnapshot => ({
    text,
    streaming,
    promptId,
    chunks,
    truncated,
  });

  const clear = (): void => {
    text = "";
    streaming = false;
    promptId = null;
    chunks = 0;
    truncated = false;
  };

  return {
    begin(nextPromptId = null) {
      clear();
      promptId = nextPromptId;
      streaming = true;
      return snapshot();
    },
    applyDelta(chunk) {
      const incoming = chunk.promptId ?? null;
      if (promptId !== null && incoming !== null && incoming !== promptId) {
        // Stale frame from a superseded prompt: keep it out of the answer.
        return snapshot();
      }
      if (promptId === null && incoming !== null) promptId = incoming;
      streaming = true;
      chunks += 1;
      if (!truncated) {
        if (text.length + chunk.text.length > MAX_STREAM_CHARS) {
          text += chunk.text.slice(0, Math.max(0, MAX_STREAM_CHARS - text.length));
          truncated = true;
        } else {
          text += chunk.text;
        }
      }
      return snapshot();
    },
    applyFinal(finalText) {
      text = finalText;
      streaming = false;
      truncated = false;
      return snapshot();
    },
    end() {
      streaming = false;
      return snapshot();
    },
    reset() {
      clear();
      return snapshot();
    },
    snapshot,
  };
}

export interface PaneDocumentTag {
  host: BridgeHost;
  documentName: string | null;
  documentId: string | null;
}

export interface OfficeRunView {
  /** A run is in flight right now. */
  active: boolean;
  /** Text is still arriving (false once the final message lands). */
  streaming: boolean;
  /** Best-known assistant text: streamed deltas, replaced by the final reply. */
  text: string;
  /** Delta frames applied to this run. */
  chunks: number;
  /** The buffered text hit the display cap (the final message still replaces it). */
  truncated: boolean;
  /** The run came from a task pane rather than the app's own composer. */
  paneInitiated: boolean;
  /** Document the pane run belongs to, when the prompt carried a bridge tag. */
  document: PaneDocumentTag | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface OfficeStopResult {
  ok: boolean;
  reason?: "idle" | "failed";
  error?: string;
}

/** What the UI needs to render the Office run: nothing when no session runs it. */
export interface OfficeRunState {
  /** False until an Office session exists in this app process. */
  available: boolean;
  run: OfficeRunView | null;
  compatibility: BridgeCompatibility | null;
}

/**
 * Parse the document tag the bridge prefixes to a pane-typed prompt
 * (`[office:excel "Book1.xlsx" id=url_sha256:…]`). The app uses it to tell a
 * pane-initiated run from one typed in the app, and to label the run with the
 * document it came from.
 */
export function parsePaneDocumentTag(text: string): PaneDocumentTag | null {
  const match = /^\[office:([A-Za-z]+) "([^"]*)"(?:\s+id=([^\]]*))?\]/.exec(text);
  if (!match) return null;
  const rawHost = match[1]?.toLowerCase();
  const host: BridgeHost =
    rawHost === "excel" || rawHost === "word" || rawHost === "powerpoint" ? rawHost : null;
  const name = match[2];
  const id = match[3];
  return {
    host,
    documentName: name === undefined || name === "" || name === "untitled" ? null : name,
    documentId: id === undefined || id === "" ? null : id,
  };
}
