/**
 * Which host processes must survive the idle reaper.
 *
 * The policy is pure so the three protections — the control host, the tab the
 * user is looking at, and the session that owns the on-demand Office bridge —
 * are unit tested instead of hiding in a closure in `index.ts`.
 */
import { CONTROL_TAB_ID } from "../shared/session-ipc";

export interface HostProtectionState {
  /** The tab currently selected in the renderer, if any. */
  activeSessionId: string | null;
  /** The session hosting the `/health` bridge, if any. */
  bridgeOwnerSessionId: string | null;
}

/** True when `sessionId` must not be stopped, parked or idle-recycled. */
export function keepHostAlive(sessionId: string, state: HostProtectionState): boolean {
  return (
    sessionId === CONTROL_TAB_ID ||
    sessionId === state.activeSessionId ||
    sessionId === state.bridgeOwnerSessionId
  );
}
