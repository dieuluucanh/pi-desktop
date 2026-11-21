/**
 * Host-side related-session bridge (orchestrator plan step 12).
 *
 * An extension can only speak to a host through the shared event bus. This
 * bridge turns one bounded, validated bus request into a host→main operation
 * and settles it with an idempotent result. It owns no tabs: main does.
 *
 * Trust boundary:
 *   - ownership is derived from a **registered command name**; the host looks
 *     up the command's SDK source info and forwards that key. A payload's own
 *     owner string is never authority and is not forwarded;
 *   - operation capability is checked before forwarding, so an unsupported
 *     host answers `unsupported` instead of starting work;
 *   - requests are bounded and time out; a duplicate `requestId` joins the
 *     pending operation (or replays the settled result) instead of creating a
 *     second child;
 *   - the bridge never infers a turn trigger. Bootstrap entries are data.
 */

import {
  RELATED_SESSION_CHANNELS,
  RELATED_SESSION_VERSION,
  validateRelatedSessionRequest,
  validateRelatedSessionResult,
  type RelatedSessionCapabilities,
  type RelatedSessionOperation,
  type RelatedSessionRequest,
  type RelatedSessionResult,
} from "../shared/related-sessions";
import type { HostMethod } from "../shared/host-protocol";
import type { ContributionBus } from "./contributions";
import type { HostHandler } from "./service";

export interface RelatedSessionOwner {
  /** Derived from the registered command's SDK source info. */
  key: string;
  /** Display-only source label (package or file), never authority. */
  label?: string;
}

/** Opaque timer handle: the bridge only passes it back to `clearTimeout`. */
export type RelatedSessionTimerHandle = number | object;

export interface RelatedSessionClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): RelatedSessionTimerHandle;
  clearTimeout(handle: RelatedSessionTimerHandle): void;
}

export interface SessionHostBridgeOptions {
  bus?: ContributionBus | null;
  /** Recomputed on every bind, because capabilities can change per session. */
  capabilities(): RelatedSessionCapabilities;
  clock: RelatedSessionClock;
  /** Source-bound owner resolution; null means the extension is not known. */
  resolveOwner(ownerCommand: string): RelatedSessionOwner | null;
  /** Emits the operation to the desktop main process (fire and forget). */
  forward(request: RelatedSessionRequest, owner: RelatedSessionOwner): void;
  /** Request timeout; a missing answer must not hang the extension forever. */
  timeoutMs?: number;
  onError?(error: unknown): void;
}

export interface SessionHostBridge {
  /** Broadcast host support; extensions answer/re-check their capabilities. */
  announce(): void;
  /** `sessionHost.result` answers main's settlement request. */
  settle(payload: unknown): { accepted: boolean; reason?: string };
  handlers(): Partial<Record<HostMethod, HostHandler>>;
  dispose(): void;
  capabilities(): RelatedSessionCapabilities;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const SETTLED_TTL_MS = 60_000;
const MAX_SETTLED = 100;

/** Which capability flag guards an operation. */
const OPERATION_FLAG: Record<RelatedSessionOperation, keyof RelatedSessionCapabilities> = {
  create: "create",
  open: "open",
  focus: "focus",
  inspect: "inspect",
  interrupt: "interrupt",
  close: "close",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createSessionHostBridge(options: SessionHostBridgeOptions): SessionHostBridge {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<
    string,
    {
      finish(result: RelatedSessionResult): void;
      handle: RelatedSessionTimerHandle;
      request: RelatedSessionRequest;
    }
  >();
  const settled = new Map<string, { at: number; result: RelatedSessionResult }>();
  const offs: Array<() => void> = [];

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      /* diagnostics must never break the bridge */
    }
  };

  const emitResult = (requestId: string, result: RelatedSessionResult): void => {
    try {
      options.bus?.emit(RELATED_SESSION_CHANNELS.result, { requestId, result });
    } catch (error) {
      report(error);
    }
  };

  const remember = (requestId: string, result: RelatedSessionResult): void => {
    const at = options.clock.now();
    settled.set(requestId, { at, result });
    if (settled.size > MAX_SETTLED) {
      for (const [key, entry] of settled) {
        if (at - entry.at > SETTLED_TTL_MS || settled.size > MAX_SETTLED) settled.delete(key);
        if (settled.size <= MAX_SETTLED) break;
      }
    }
  };

  const finish = (requestId: string, result: RelatedSessionResult): void => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    try {
      options.clock.clearTimeout(entry.handle);
    } catch {
      /* a fake clock may not need clearing */
    }
    remember(requestId, result);
    emitResult(requestId, result);
  };

  const reject = (
    requestId: string,
    code: "unsupported" | "rejected" | "failed",
    reason: string,
  ): void => {
    const result: RelatedSessionResult = { ok: false, code, reason };
    remember(requestId, result);
    emitResult(requestId, result);
  };

  const handleRequest = (payload: unknown): void => {
    const parsed = validateRelatedSessionRequest(payload);
    if (!parsed.ok) {
      // Without a valid request id there is no one to answer; the extension
      // sees no result and its own timeout applies. Never guess an id.
      report(new Error(`related-session request rejected: ${parsed.error}`));
      return;
    }
    const request = parsed.value;

    const previous = settled.get(request.requestId);
    if (previous && options.clock.now() - previous.at <= SETTLED_TTL_MS) {
      // A retry after a lost bus message: replay instead of creating twice.
      emitResult(request.requestId, previous.result);
      return;
    }
    if (pending.has(request.requestId)) return;

    const capabilities = options.capabilities();
    if (!capabilities.sourceBound) {
      reject(
        request.requestId,
        "unsupported",
        "this host cannot verify which extension owns the request",
      );
      return;
    }
    const flag = OPERATION_FLAG[request.operation];
    if (capabilities[flag] !== true) {
      reject(
        request.requestId,
        "unsupported",
        capabilities.reason ?? `this host cannot ${request.operation} a related session`,
      );
      return;
    }

    const owner = options.resolveOwner(request.ownerCommand);
    if (!owner) {
      reject(
        request.requestId,
        "rejected",
        `no registered command "${request.ownerCommand}" identifies the requesting extension`,
      );
      return;
    }

    try {
      options.forward(request, owner);
    } catch (error) {
      reject(request.requestId, "failed", error instanceof Error ? error.message : String(error));
      return;
    }

    pending.set(request.requestId, {
      request,
      handle: options.clock.setTimeout(() => {
        finish(request.requestId, {
          ok: false,
          code: "failed",
          reason: "the desktop did not answer the related-session request",
        });
      }, timeoutMs),
      finish: (result) => finish(request.requestId, result),
    });
  };

  if (options.bus) {
    try {
      offs.push(
        options.bus.on(RELATED_SESSION_CHANNELS.request, (payload) => {
          try {
            handleRequest(payload);
          } catch (error) {
            report(error);
          }
          return undefined;
        }),
      );
      offs.push(
        options.bus.on(RELATED_SESSION_CHANNELS.probe, () => {
          try {
            options.bus?.emit(RELATED_SESSION_CHANNELS.hello, options.capabilities());
          } catch (error) {
            report(error);
          }
          return undefined;
        }),
      );
    } catch (error) {
      report(error);
    }
  }

  const bridge: SessionHostBridge = {
    announce() {
      try {
        options.bus?.emit(RELATED_SESSION_CHANNELS.hello, options.capabilities());
      } catch (error) {
        report(error);
      }
    },

    settle(payload) {
      const record = asRecord(payload);
      const requestId = typeof record.requestId === "string" ? record.requestId : "";
      if (!requestId) return { accepted: false, reason: "missing requestId" };
      const parsed = validateRelatedSessionResult(record.result);
      if (!parsed.ok) return { accepted: false, reason: parsed.error };
      finish(requestId, parsed.value);
      return { accepted: true };
    },

    handlers: () => ({
      "sessionHost.result": (params) => bridge.settle(params),
    }),

    dispose() {
      for (const [requestId, entry] of pending) {
        try {
          options.clock.clearTimeout(entry.handle);
        } catch {
          /* ignore */
        }
        emitResult(requestId, {
          ok: false,
          code: "cancelled",
          reason: "the session was torn down before the host answered",
        });
      }
      pending.clear();
      settled.clear();
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch (error) {
          report(error);
        }
      }
    },

    capabilities: () => options.capabilities(),
  };

  return bridge;
}

/** True when the version/app flags allow this build to dispatch work at all. */
export function relatedSessionCapabilitiesSupported(
  capabilities: RelatedSessionCapabilities,
): boolean {
  return capabilities.version >= RELATED_SESSION_VERSION && capabilities.sourceBound;
}
