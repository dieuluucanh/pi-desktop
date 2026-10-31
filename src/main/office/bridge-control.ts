/**
 * On-demand Office bridge control (bridge 0.6+).
 *
 * The bridge extension owns the server; this service owns the *orchestration*
 * that Pi Desktop needs: close the bridge in another tab, wait for the port to
 * free, connect the requested tab, and report a stable reason when it cannot.
 *
 * It is deliberately Electron-free (AGENTS rule 1). The process operations
 * (`releasePort`, the session RPC, the `/health` probe and the clock) are all
 * injected, so the whole state machine is unit-testable.
 */

import type {
  OfficeBridgeControlReason,
  OfficeBridgeControlResult,
} from "../../shared/office-bridge";
import type { OfficeBridgeOwner, OfficeDocumentsView } from "../../shared/office-documents";
import { PI_OFFICE_BRIDGE } from "../../shared/office";
import type { TabRecord } from "../../shared/session-ipc";

export type { OfficeBridgeControlReason, OfficeBridgeControlResult };

export interface OfficeBridgeControlDeps {
  /** The tab table (read at call time; the service never caches it). */
  tabs(): readonly Pick<TabRecord, "id" | "kind" | "status">[];
  /** Probes `/health` and updates the shared documents view. */
  probe(): Promise<OfficeDocumentsView>;
  /**
   * Runs `commands.run` on a tab's host: `{ name: "office", args }`.
   * The host returns `{ ran, error? }`; the same shape as the SDK command runner.
   */
  request(tabId: string, method: "commands.run", params: unknown): Promise<unknown>;
  /** Frees port 38617 for an explicit takeover (main's port-owner service). */
  releasePort?(input: {
    port: number;
    ownPids: readonly number[];
  }): Promise<{ ok: boolean; detail?: string }>;
  /** PIDs this app owns; never passed to the reclaimer as a victim. */
  ownPids?(): readonly number[];
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** Total wait after a command before reporting a timeout. */
  timeoutMs?: number;
  /** Poll interval while waiting for `/health` to change. */
  pollMs?: number;
  /** Bridge port; defaults to 38617. */
  port?: number;
}

export interface OfficeBridgeControl {
  connect(tabId: string, options?: { takeover?: boolean }): Promise<OfficeBridgeControlResult>;
  close(tabId: string): Promise<OfficeBridgeControlResult>;
  restart(tabId: string, options?: { takeover?: boolean }): Promise<OfficeBridgeControlResult>;
}

export const DEFAULT_CONTROL_TIMEOUT_MS = 12_000;
export const DEFAULT_CONTROL_POLL_MS = 250;

interface CommandOutcome {
  ok: boolean;
  reason?: OfficeBridgeControlReason;
  message?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function describeOwner(owner: OfficeBridgeOwner | null, port: number): string {
  if (!owner) return `Port ${port} is owned by another program.`;
  const where = owner.cwd ? `, ${owner.cwd}` : "";
  if (owner.client === "desktop") {
    return `The bridge on port ${port} belongs to another Pi Desktop session (PID ${owner.pid ?? "?"}${where}).`;
  }
  return `A terminal Pi session owns the bridge on port ${port} (PID ${owner.pid ?? "?"}${where}). Run /office close there, or take over.`;
}

function legacyMessage(): string {
  return (
    "This bridge starts automatically (0.5.x). Update it from Extensions → Integrations " +
    "to connect and disconnect on demand."
  );
}

function sameTab(owner: OfficeBridgeOwner | null, tabId: string): boolean {
  return owner?.sessionId === tabId;
}

export function createOfficeBridgeControl(deps: OfficeBridgeControlDeps): OfficeBridgeControl {
  const port = deps.port ?? PI_OFFICE_BRIDGE.defaultPort;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_CONTROL_POLL_MS;
  const now = deps.now ?? ((): number => Date.now());
  const sleep =
    deps.sleep ??
    (async (ms: number): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

  function findTab(tabId: string): Pick<TabRecord, "id" | "kind" | "status"> | null {
    return deps.tabs().find((tab) => tab.id === tabId) ?? null;
  }

  function requireConnectableTab(tabId: string): OfficeBridgeControlResult | null {
    const tab = findTab(tabId);
    if (!tab) {
      return { ok: false, reason: "bad-tab", message: "That session tab no longer exists." };
    }
    if (tab.kind === "web") {
      return {
        ok: false,
        reason: "bad-tab",
        message: "A web tab cannot host the Office bridge.",
      };
    }
    return null;
  }

  function parseCommand(value: unknown): CommandOutcome {
    const record = asRecord(value);
    if (record.ran !== true) {
      return {
        ok: false,
        reason: "command-missing",
        message: legacyMessage(),
      };
    }
    if (typeof record.error === "string" && record.error.length > 0) {
      return { ok: false, reason: "failed", message: record.error };
    }
    return { ok: true };
  }

  async function runOffice(tabId: string, args: string): Promise<CommandOutcome> {
    try {
      const response = await deps.request(tabId, "commands.run", {
        name: "office",
        args,
      });
      return parseCommand(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: "host-unavailable", message };
    }
  }

  /**
   * Poll `/health` until `done(view)` or the deadline. The final view is always
   * returned so a failed wait can report the real state.
   */
  async function waitFor(
    done: (view: OfficeDocumentsView) => boolean,
  ): Promise<{ view: OfficeDocumentsView; timedOut: boolean }> {
    const deadline = now() + timeoutMs;
    let view = await deps.probe();
    while (!done(view)) {
      if (now() >= deadline) return { view, timedOut: true };
      await sleep(pollMs);
      view = await deps.probe();
    }
    return { view, timedOut: false };
  }

  async function closeOwned(ownerTabId: string): Promise<OfficeBridgeControlResult> {
    const outcome = await runOffice(ownerTabId, "close");
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.reason ?? "failed",
        message: outcome.message,
      };
    }
    const { view, timedOut } = await waitFor((next) => !next.available);
    if (timedOut) {
      return {
        ok: false,
        reason: "timeout",
        owner: view.owner,
        message: `The bridge did not release port ${port} in time.`,
      };
    }
    return { ok: true, reason: "closed" };
  }

  async function connect(
    tabId: string,
    options: { takeover?: boolean } = {},
  ): Promise<OfficeBridgeControlResult> {
    const invalid = requireConnectableTab(tabId);
    if (invalid) return invalid;

    const view = await deps.probe();
    if (view.available) {
      const owner = view.owner;
      if (sameTab(owner, tabId)) {
        return { ok: true, reason: "already-connected", owner };
      }
      if (!view.manualLifecycle) {
        return { ok: false, reason: "legacy-bridge", owner, message: legacyMessage() };
      }

      const ownerTabId = owner?.sessionId ?? null;
      const ownerTab = ownerTabId ? findTab(ownerTabId) : null;
      if (ownerTabId && ownerTab) {
        // An app-owned bridge: close it cleanly instead of killing the process.
        const closed = await closeOwned(ownerTabId);
        if (!closed.ok) return closed;
      } else {
        // A terminal Pi or another program: never kill it without consent.
        if (options.takeover !== true) {
          return {
            ok: false,
            reason: "port-busy",
            owner,
            canTakeover: deps.releasePort !== undefined,
            message: describeOwner(owner, port),
          };
        }
        if (!deps.releasePort) {
          return {
            ok: false,
            reason: "port-busy",
            owner,
            canTakeover: false,
            message: describeOwner(owner, port),
          };
        }
        const released = await deps.releasePort({
          port,
          ownPids: deps.ownPids?.() ?? [],
        });
        if (!released.ok) {
          return {
            ok: false,
            reason: "port-busy",
            owner,
            canTakeover: true,
            message: released.detail ?? describeOwner(owner, port),
          };
        }
        const freed = await waitFor((next) => !next.available);
        if (freed.timedOut) {
          return {
            ok: false,
            reason: "port-busy",
            owner: freed.view.owner,
            canTakeover: true,
            message: `Port ${port} is still answering after the takeover.`,
          };
        }
      }
    }

    const outcome = await runOffice(tabId, `connect ${port}`);
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.reason ?? "failed",
        message: outcome.message,
      };
    }

    const waited = await waitFor(
      (next) =>
        next.available &&
        (sameTab(next.owner, tabId) || (!next.manualLifecycle && next.owner === null)),
    );
    if (waited.timedOut) {
      return {
        ok: false,
        reason: "timeout",
        owner: waited.view.owner,
        message:
          `The bridge did not answer on port ${port}. ` +
          "If this profile still has a bridge older than 0.6, update it from Extensions → Integrations.",
      };
    }
    if (!waited.view.manualLifecycle) {
      return {
        ok: false,
        reason: "legacy-bridge",
        owner: waited.view.owner,
        message: legacyMessage(),
      };
    }
    return {
      ok: true,
      reason: "connected",
      owner: waited.view.owner,
    };
  }

  async function close(tabId: string): Promise<OfficeBridgeControlResult> {
    const invalid = requireConnectableTab(tabId);
    if (invalid) return invalid;

    const view = await deps.probe();
    if (!view.available) {
      return { ok: true, reason: "not-connected" };
    }
    if (!view.manualLifecycle) {
      return { ok: false, reason: "legacy-bridge", owner: view.owner, message: legacyMessage() };
    }
    if (!sameTab(view.owner, tabId)) {
      return {
        ok: false,
        reason: "wrong-owner",
        owner: view.owner,
        message: `The bridge is not hosted by this session. ${describeOwner(view.owner, port)}`,
      };
    }

    const closed = await closeOwned(tabId);
    return closed.ok ? { ...closed, owner: null } : closed;
  }

  async function restart(
    tabId: string,
    options: { takeover?: boolean } = {},
  ): Promise<OfficeBridgeControlResult> {
    const closed = await close(tabId);
    if (!closed.ok && closed.reason !== "not-connected") return closed;
    return connect(tabId, options);
  }

  return { connect, close, restart };
}
