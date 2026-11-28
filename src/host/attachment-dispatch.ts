/**
 * Host-owned lifecycle fence for a Desktop-managed attachment turn.
 *
 * This module is deliberately pure: it holds no bytes, reads no SDK state and
 * imports neither Electron nor the Pi SDK. It answers one question for the rest
 * of the host — may another Desktop operation that changes the session, model
 * or conversation context proceed while an attachment dispatch is pending or
 * running?
 *
 * Trusted extensions and independent SDK callers are not governed here; this is
 * the Desktop composer/dispatch boundary, not a sandbox.
 */

export type AttachmentDispatchPhase = "idle" | "dispatching" | "accepted";

export interface AttachmentDispatchTurn {
  readonly turnId: string;
  readonly attemptId: string;
}

export interface AttachmentDispatchCoordinator {
  phase(): AttachmentDispatchPhase;
  /** The turn whose user entry may still receive attachment metadata. */
  current(): AttachmentDispatchTurn | null;
  /**
   * True while a managed dispatch is awaiting preflight. A second composer send,
   * staging transfer or attachment prompt must not start in that window.
   * Once accepted, ordinary text steering/follow-up stays native Pi behavior.
   */
  blocksConcurrentWork(): boolean;
  /**
   * True for the whole attachment turn (pending or accepted run). Model,
   * settings and session/context mutations are Desktop-serialized against it.
   */
  blocksContextMutation(): boolean;
  /**
   * Claim the single dispatch slot. Returns false when another turn is already
   * dispatching or an accepted turn has not settled yet.
   */
  beginDispatch(turn: AttachmentDispatchTurn): boolean;
  /** Preflight `started`: the turn is accepted and stays fenced until settle. */
  accept(turn: AttachmentDispatchTurn): boolean;
  /** Release a handled/blocked/uncertain attempt without waiting for settle. */
  release(turn: AttachmentDispatchTurn): void;
  /** The agent run settled (or the session was replaced); return to idle. */
  settle(): void;
}

function validTurn(turn: AttachmentDispatchTurn): boolean {
  return (
    !!turn &&
    typeof turn.turnId === "string" &&
    turn.turnId.length > 0 &&
    typeof turn.attemptId === "string" &&
    turn.attemptId.length > 0
  );
}

function sameTurn(left: AttachmentDispatchTurn | null, right: AttachmentDispatchTurn): boolean {
  return !!left && left.turnId === right.turnId && left.attemptId === right.attemptId;
}

export function createAttachmentDispatchCoordinator(): AttachmentDispatchCoordinator {
  let state: AttachmentDispatchPhase = "idle";
  let current: AttachmentDispatchTurn | null = null;

  const clear = (): void => {
    state = "idle";
    current = null;
  };

  return {
    phase: () => state,
    current: () => (current ? { ...current } : null),
    blocksConcurrentWork: () => state === "dispatching",
    blocksContextMutation: () => state !== "idle",
    beginDispatch(turn) {
      if (!validTurn(turn) || state !== "idle") return false;
      state = "dispatching";
      current = { turnId: turn.turnId, attemptId: turn.attemptId };
      return true;
    },
    accept(turn) {
      if (!sameTurn(current, turn) || state !== "dispatching") return false;
      state = "accepted";
      return true;
    },
    release(turn) {
      if (!sameTurn(current, turn)) return;
      clear();
    },
    settle() {
      clear();
    },
  };
}
