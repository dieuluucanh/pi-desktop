/**
 * Which host processes must survive the idle reaper.
 *
 * The policy is pure so the protections — the control host, the tab the user is
 * looking at, every tab a grid pane is showing, and the session that owns the
 * on-demand Office bridge — are unit tested instead of hiding in a closure in
 * `index.ts`.
 *
 * The visible set exists because of the session view grid (2026-11-03 plan): the
 * user can watch four sessions at once, and parking one of them would make a
 * pane go blank under them. It is a **parking** protection only — the per-host
 * RSS watchdog still stops a visible host that grows past its threshold, so the
 * memory bound added by the OOM plan is not weakened.
 */
import { CONTROL_TAB_ID } from "../shared/session-ipc";

export interface HostProtectionState {
  /** The tab currently selected in the renderer, if any (the focused pane). */
  activeSessionId: string | null;
  /**
   * Tabs mounted in a grid pane or the solo view. A `Set` is used by the service
   * (membership is the only question) and an array by tests and callers that
   * build one on the spot.
   */
  visibleSessionIds?: ReadonlySet<string> | readonly string[];
  /** The session hosting the `/health` bridge, if any. */
  bridgeOwnerSessionId: string | null;
}

function isVisible(sessionId: string, state: HostProtectionState): boolean {
  const visible = state.visibleSessionIds;
  if (!visible) return false;
  if (typeof (visible as ReadonlySet<string>).has === "function") {
    return (visible as ReadonlySet<string>).has(sessionId);
  }
  return (visible as readonly string[]).includes(sessionId);
}

/** True when `sessionId` must not be stopped, parked or idle-recycled. */
export function keepHostAlive(sessionId: string, state: HostProtectionState): boolean {
  return (
    sessionId === CONTROL_TAB_ID ||
    sessionId === state.activeSessionId ||
    sessionId === state.bridgeOwnerSessionId ||
    isVisible(sessionId, state)
  );
}
