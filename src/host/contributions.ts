/**
 * Desktop host contribution registry (orchestrator plan step 8).
 *
 * One registry per session host. It accepts validated envelopes from any
 * extension, applies revision/epoch rules, and exposes a renderer-safe
 * snapshot. It deliberately knows nothing about Workflow: the same code serves
 * any extension that publishes the generic contract.
 *
 * Trust boundary:
 *   - envelopes are re-validated here (never trusted from the bus payload);
 *   - an action runs only a command the host can resolve, with the extension's
 *     own registered command name — never a shell fragment or free-form URL;
 *   - a stale epoch or an equal/older revision is dropped, so a reload or a
 *     detached tab cannot re-enable an old button;
 *   - `reset()` clears every registration on teardown/rebind.
 */

import {
  HOST_CONTRIBUTION_LIMITS,
  HOST_CONTRIBUTION_VERSION,
  applyEnvelope,
  parseContributionEnvelope,
  type Contribution,
  type ContributionEnvelope,
  type HostContributionCapabilities,
} from "../shared/extension-contributions";
import {
  buildContributionSnapshot,
  EMPTY_CONTRIBUTION_SNAPSHOT,
  type ContributionSnapshot,
} from "../shared/extension-contributions-view";
import type { HostMethod } from "../shared/host-protocol";
import type { HostHandler } from "./service";

/** Bus channels — must match the Workflow publisher constants. */
export const CONTRIBUTION_EVENTS = {
  hello: "host-contributions:hello",
  probe: "host-contributions:probe",
  update: "host-contributions:update",
} as const;

export const CONTRIBUTION_METHODS = [
  "contributions.state",
  "contributions.run",
] as const satisfies readonly HostMethod[];

/**
 * Structural `pi.events` bus (Pi's `createEventBus()` result). The composition
 * root supplies the same instance to the resource loader, so an extension's
 * `pi.events.emit` lands here. SDK-free: the adapter lives in `src/host/sdk`.
 */
export interface ContributionBus {
  on(channel: string, handler: (payload: unknown) => unknown): () => void;
  emit(channel: string, payload?: unknown): void;
}

export interface ContributionBridge {
  /** Broadcast host support; extensions answer by publishing their set. */
  announce(): void;
  /** Stop listening (session teardown / rebind). */
  dispose(): void;
}

interface RegistryEntry {
  ownerId: string;
  epoch: number;
  revision: number;
  contributions: Map<string, Contribution>;
}

export interface ContributionHostOptions {
  /** Pushes the host protocol event (`oi.*` style) to the renderer. */
  emit(event: string, payload?: unknown): void;
  /** Runs one registered extension command; returns false when unknown. */
  runCommand(name: string, args: string): Promise<{ ran: boolean; error?: string }>;
  now?: () => number;
  capabilities?: Partial<HostContributionCapabilities>;
}

export interface ContributionHost {
  /** Payload the host broadcasts so extensions start publishing. */
  hello(): HostContributionCapabilities;
  /** Handles one bus envelope (already routed by the bridge). */
  receive(payload: unknown): { accepted: boolean; reason?: string };
  /** Merged snapshot for the current session. */
  snapshot(): ContributionSnapshot;
  /**
   * Raw owner state for host-internal resolvers (never sent to the renderer).
   * Used by the composer-transform host to re-check same-owner references and
   * the published revision without trusting a renderer-supplied owner.
   */
  entry(
    ownerId: string,
  ): { revision: number; epoch: number; contributions: Contribution[] } | undefined;
  /** Runs an action after re-validating that the host still offers it. */
  runAction(ownerId: string, contributionId: string): Promise<{ ran: boolean; error?: string }>;
  reset(): void;
  handlers(): Partial<Record<HostMethod, HostHandler>>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createContributionHost(options: ContributionHostOptions): ContributionHost {
  const registry = new Map<string, RegistryEntry>();
  const now = options.now ?? (() => Date.now());
  let updatedAt = 0;

  const capabilities: HostContributionCapabilities = {
    contractVersion: HOST_CONTRIBUTION_VERSION,
    kinds: ["mode", "mode-choice", "progress", "status", "action", "input", "related-session"],
    slots: ["mode", "mode-choice", "progress", "status", "action", "input", "sessions"],
    maxContributions: HOST_CONTRIBUTION_LIMITS.maxContributions,
    ...options.capabilities,
  };

  const entries = (): Array<{
    ownerId: string;
    epoch: number;
    revision: number;
    contributions: Contribution[];
  }> =>
    [...registry.values()]
      .filter((entry) => entry.contributions.size > 0)
      .map((entry) => ({
        ownerId: entry.ownerId,
        epoch: entry.epoch,
        revision: entry.revision,
        contributions: [...entry.contributions.values()],
      }));

  const snapshot = (): ContributionSnapshot => {
    const current = entries();
    if (registry.size === 0) {
      return { ...EMPTY_CONTRIBUTION_SNAPSHOT, supported: true, updatedAt };
    }
    return buildContributionSnapshot(current, {
      supported: true,
      updatedAt,
    });
  };

  const publish = (): void => {
    try {
      options.emit("contributions.state", snapshot());
    } catch {
      /* a renderer that is gone must not break the host loop */
    }
  };

  const host: ContributionHost = {
    hello: () => ({ ...capabilities }),

    receive(payload) {
      const envelope: ContributionEnvelope | undefined = (() => {
        const parsed = parseContributionEnvelope(payload);
        return parsed.ok ? parsed.value.envelope : undefined;
      })();
      if (!envelope) {
        const parsed = parseContributionEnvelope(payload);
        return { accepted: false, reason: parsed.ok ? "no envelope" : parsed.error };
      }
      const current = registry.get(envelope.owner.id);
      const applied = applyEnvelope(
        current
          ? {
              epoch: current.epoch,
              revision: current.revision,
              contributions: current.contributions,
            }
          : undefined,
        envelope,
      );
      if (!applied.ok) {
        // A stale/duplicate publish is normal after a reconnect: drop quietly.
        return { accepted: false, reason: applied.error };
      }
      registry.set(envelope.owner.id, {
        ownerId: envelope.owner.id,
        epoch: applied.value.epoch,
        revision: applied.value.revision,
        contributions: applied.value.contributions,
      });
      updatedAt = now();
      publish();
      return { accepted: true };
    },

    snapshot,

    entry(ownerId) {
      const entry = registry.get(ownerId);
      if (!entry) return undefined;
      return {
        revision: entry.revision,
        epoch: entry.epoch,
        contributions: [...entry.contributions.values()],
      };
    },

    async runAction(ownerId, contributionId) {
      const entry = registry.get(ownerId);
      const contribution = entry?.contributions.get(contributionId);
      if (!contribution) return { ran: false, error: "action is no longer available" };
      if (contribution.kind === "action") {
        if (!contribution.enabled) {
          return {
            ran: false,
            error: contribution.disabledReason ?? "action is disabled",
          };
        }
        const args = contribution.command.args ?? "";
        return options.runCommand(contribution.command.name, args);
      }
      // Mode/progress actions are nested presentation rows. The v1 contract
      // gives them no command name (only id/label/args), so the host cannot
      // invent one: an executable action must be published as `kind:"action"`.
      // Refusing here keeps a host from guessing a command from an id.
      if (contribution.kind === "mode" || contribution.kind === "progress") {
        return {
          ran: false,
          error: 'nested display actions are not executable; publish a kind:"action" contribution',
        };
      }
      return { ran: false, error: "contribution is not actionable" };
    },

    reset() {
      registry.clear();
      updatedAt = now();
      publish();
    },

    handlers: () => ({
      "contributions.state": async () => snapshot(),
      "contributions.run": async (params) => {
        const record = asRecord(params);
        const ownerId = typeof record.ownerId === "string" ? record.ownerId : "";
        const contributionId = typeof record.id === "string" ? record.id : "";
        if (!ownerId || !contributionId) {
          throw new Error("contributions.run requires { ownerId, id }");
        }
        return host.runAction(ownerId, contributionId);
      },
    }),
  };

  return host;
}
