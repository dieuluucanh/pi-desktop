import type { AttachmentStore } from "../attachments/store";
import {
  ATTACHMENT_LIMITS,
  isAttachmentId,
  type AttachmentDraftGrant,
  type AttachmentDeliveryScope,
} from "../shared/attachments";
import type { AttachmentService, AttachmentDraftAuthority } from "./attachment-service";
import type { SessionService, SessionHostPin } from "./session-service";
import {
  openDirectDeliveryReader,
  type ConversionApprovalPort,
  type DirectDeliveryReader,
} from "./attachment-delivery-assets";

export const DELIVERY_LEASE_LIMITS = {
  slots: ATTACHMENT_LIMITS.deliverySlots,
  // Reserve conservatively for full-read verification copies plus chunk output.
  bytesPerSlot: ATTACHMENT_LIMITS.estimatedRequestBytes * 4,
  setupMs: ATTACHMENT_LIMITS.deliverySetupMs,
  operationMs: ATTACHMENT_LIMITS.deliveryOperationMs,
  lifetimeMs: ATTACHMENT_LIMITS.deliveryLifetimeMs,
  cleanupRetryMs: ATTACHMENT_LIMITS.deliveryCleanupRetryMs,
} as const;

/** Created by trusted main/host context plumbing, NEVER decoded from renderer IPC. */
export interface DeliveryContextFence {
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly branchId: string | null;
  readonly revision: string;
  isCurrent(): boolean;
}

export type DeliveryLeaseScope = AttachmentDeliveryScope;

export interface AttachmentDeliveryLease extends DirectDeliveryReader {
  /** Main-only pin used by the private transfer adapter; never serialize this lease. */
  readonly hostPin: SessionHostPin;
  readonly id: string;
  readonly scope: DeliveryLeaseScope;
  readonly expiresAt: number;
  readonly signal: AbortSignal;
  /** Synchronous authorization check, not a substitute for manifest verification. */
  authorized(): boolean;
}

export interface DeliveryLeaseStats {
  readonly slots: number;
  readonly reservedBytes: number;
  readonly draining: number;
  readonly cleanupFailed: number;
}

export interface DeliveryLeaseDeps {
  readonly profileKey: string;
  readonly drafts: Pick<AttachmentService, "authorizeDeliveryDraft">;
  readonly sessions: Pick<SessionService, "pinSessionHost">;
  readonly store: AttachmentStore;
  /** Approved converted-text lookup; omitted means only direct assets work. */
  readonly conversions?: ConversionApprovalPort;
  /** One cryptographic UUID per authority lifetime, not per request. */
  newAuthorityId(): string;
  profileCurrent(): boolean;
  now(): number;
  /** Returns an idempotent cancellation function. All timers are injected. */
  schedule(delayMs: number, callback: () => void): () => void;
  sha256(bytes: Uint8Array): Promise<string>;
  /** Generic bounded incident, never source paths/content or native errors. */
  onCleanupFailure?(): void;
}

export interface AttachmentDeliveryLeases {
  open(input: {
    senderId: number;
    draft: AttachmentDraftGrant;
    representationIds: readonly string[];
    context: DeliveryContextFence;
  }): Promise<AttachmentDeliveryLease>;
  stats(): DeliveryLeaseStats;
  /** Retry failed cleanup if the timer port itself was unavailable. */
  retryCleanup(): void;
  /** Revokes immediately; hung operations retain capacity/pins until they drain. */
  dispose(): void;
}

export class DeliveryLeaseError extends Error {
  constructor(readonly code: "unavailable" | "busy" | "capacity") {
    super(`attachment delivery lease: ${code}`);
    this.name = "DeliveryLeaseError";
  }
}

type Phase = "opening" | "active" | "closing" | "closed";
interface Entry {
  readonly id: string;
  readonly draft: AttachmentDraftAuthority;
  readonly context: DeliveryContextFence;
  readonly controller: AbortController;
  readonly expiresAt: number;
  pin: SessionHostPin | null;
  scope: DeliveryLeaseScope | null;
  reader: DirectDeliveryReader | null;
  phase: Phase;
  pending: number;
  cleanupFailed: boolean;
  reported: boolean;
  cancelExpiry: (() => void) | null;
  cancelRetry: (() => void) | null;
}

function fail(code: DeliveryLeaseError["code"] = "unavailable"): never {
  throw new DeliveryLeaseError(code);
}

function validContext(context: DeliveryContextFence): boolean {
  return (
    !!context &&
    typeof context.sessionId === "string" &&
    context.sessionId.length > 0 &&
    context.sessionId.length <= 512 &&
    Number.isSafeInteger(context.sessionEpoch) &&
    context.sessionEpoch > 0 &&
    (context.branchId === null ||
      (typeof context.branchId === "string" &&
        context.branchId.length > 0 &&
        context.branchId.length <= 512)) &&
    typeof context.revision === "string" &&
    context.revision.length > 0 &&
    context.revision.length <= 512 &&
    typeof context.isCurrent === "function"
  );
}

/**
 * Main-only bounded authority. No ID is a bearer permission: callers hold a
 * private handle bound to authenticated draft, profile, process and context.
 * This engine must not be renderer-exposed; trusted context fences and the
 * private transport/commit boundary must be supplied by the composition root.
 */
export function createAttachmentDeliveryLeases(deps: DeliveryLeaseDeps): AttachmentDeliveryLeases {
  if (!/^[0-9a-f]{64}$/.test(deps.profileKey)) return fail();
  const authorityId = deps.newAuthorityId();
  if (!isAttachmentId(authorityId)) return fail();
  // Non-repeating UUID-v4 tail within this random authority namespace. Unlike
  // a lifetime Set of UUIDs this cannot grow without bound or deny all future
  // issuance after a small tombstone cap. The full authorityId is scope-bound.
  const prefix = authorityId.slice(0, 24);
  const seed = BigInt(`0x${authorityId.slice(24)}`);
  let sequence = 0n;
  const entries = new Map<string, Entry>();
  let disposed = false;
  let lastTime = 0;

  function time(): number {
    const value = deps.now();
    if (
      !Number.isSafeInteger(value) ||
      value < lastTime ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER - DELIVERY_LEASE_LIMITS.lifetimeMs
    )
      return fail();
    lastTime = value;
    return value;
  }

  function report(entry: Entry): void {
    if (entry.reported) return;
    entry.reported = true;
    try {
      deps.onCleanupFailure?.();
    } catch {
      /* Reporting cannot free capacity. */
    }
  }

  function cancelTimer(entry: Entry, cancel: (() => void) | null): void {
    try {
      cancel?.();
    } catch {
      report(entry);
    }
  }

  function cleanup(entry: Entry): void {
    if (entry.phase !== "closing" || entry.pending !== 0 || entry.cancelRetry) return;
    try {
      entry.reader?.close();
      entry.pin?.release();
      entry.phase = "closed";
      entry.cleanupFailed = false;
      entries.delete(entry.id);
    } catch {
      entry.cleanupFailed = true;
      report(entry);
      // Fail closed: keep the slot, byte reservation and pin on cleanup failure.
      try {
        entry.cancelRetry = deps.schedule(DELIVERY_LEASE_LIMITS.cleanupRetryMs, () => {
          entry.cancelRetry = null;
          cleanup(entry);
        });
      } catch {
        // Still retained/reported; retryCleanup supplies recovery when timers fail.
        entry.cancelRetry = null;
      }
    }
  }

  function revoke(entry: Entry): void {
    if (entry.phase === "closed") return;
    entry.phase = "closing";
    const cancelExpiry = entry.cancelExpiry;
    entry.cancelExpiry = null;
    cancelTimer(entry, cancelExpiry);
    entry.controller.abort();
    // Close cached bytes immediately, but never release a pin/capacity while
    // store/hash work can still allocate or complete in the background.
    try {
      entry.reader?.close();
    } catch {
      /* Retried/reported by cleanup after draining. */
    }
    cleanup(entry);
  }

  function authorized(entry: Entry): boolean {
    if (entry.phase === "closing" || entry.phase === "closed") return false;
    try {
      if (
        !disposed &&
        time() < entry.expiresAt &&
        deps.profileCurrent() === true &&
        entry.draft.isCurrent() === true &&
        entry.pin?.isCurrent() === true &&
        entry.context.isCurrent() === true
      )
        return true;
    } catch {
      /* Any uncertain authority is revoked permanently. */
    }
    revoke(entry);
    return false;
  }

  async function operation<T>(
    entry: Entry,
    run: () => Promise<T>,
    milliseconds: number,
  ): Promise<T> {
    if (!authorized(entry)) return fail();
    if (entry.pending !== 0) return fail("busy");
    entry.pending++;
    let cancelDeadline: () => void;
    let finished = false;
    try {
      cancelDeadline = deps.schedule(milliseconds, () => {
        if (!finished) revoke(entry);
      });
    } catch {
      entry.pending--;
      report(entry);
      revoke(entry);
      return fail();
    }
    const signal = entry.controller.signal;
    if (signal.aborted) {
      finished = true;
      cancelTimer(entry, cancelDeadline);
      entry.pending--;
      cleanup(entry);
      return fail();
    }
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new DeliveryLeaseError("unavailable"));
      signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const work = (async (): Promise<T> => {
      try {
        const result = await run();
        if (!authorized(entry)) {
          if (result instanceof Uint8Array) result.fill(0);
          return fail();
        }
        return result;
      } catch {
        revoke(entry);
        return fail();
      } finally {
        finished = true;
        cancelTimer(entry, cancelDeadline);
        entry.pending--;
        cleanup(entry);
      }
    })();
    try {
      return await Promise.race([work, aborted]);
    } finally {
      signal.removeEventListener("abort", rejectAbort);
    }
  }

  return {
    async open(input) {
      if (disposed || deps.profileCurrent() !== true) return fail();
      if (
        !validContext(input.context) ||
        !Array.isArray(input.representationIds) ||
        input.representationIds.length === 0 ||
        input.representationIds.length > ATTACHMENT_LIMITS.filesPerDraft ||
        input.representationIds.some((id) => !isAttachmentId(id)) ||
        new Set(input.representationIds).size !== input.representationIds.length
      )
        return fail();
      // Snapshot selectors and context fields before any asynchronous work.
      const ids = [...input.representationIds];
      const sourceContext = input.context;
      const sessionId = sourceContext.sessionId;
      const sessionEpoch = sourceContext.sessionEpoch;
      const branchId = sourceContext.branchId;
      const revision = sourceContext.revision;
      const checkContext = sourceContext.isCurrent.bind(sourceContext);
      const context = Object.freeze({
        sessionId,
        sessionEpoch,
        branchId,
        revision,
        isCurrent: () =>
          sourceContext.sessionId === sessionId &&
          sourceContext.sessionEpoch === sessionEpoch &&
          sourceContext.branchId === branchId &&
          sourceContext.revision === revision &&
          checkContext() === true,
      });
      const draft = deps.drafts.authorizeDeliveryDraft(input.senderId, input.draft);
      if (entries.size >= DELIVERY_LEASE_LIMITS.slots) return fail("capacity");
      if (sequence >= 0x1000000000000n) return fail("capacity");
      const id = prefix + (seed ^ sequence++).toString(16).padStart(12, "0");
      const entry: Entry = {
        id,
        draft,
        context,
        controller: new AbortController(),
        expiresAt: time() + DELIVERY_LEASE_LIMITS.lifetimeMs,
        pin: null,
        scope: null,
        reader: null,
        phase: "opening",
        pending: 0,
        cleanupFailed: false,
        reported: false,
        cancelExpiry: null,
        cancelRetry: null,
      };
      entries.set(id, entry);
      try {
        // Real pin acquisition is synchronous: no untracked hanging pin setup.
        entry.pin = deps.sessions.pinSessionHost(draft.tabId);
        const pin = entry.pin;
        if (pin.sessionId !== context.sessionId || pin.sessionEpoch !== context.sessionEpoch)
          return fail();
        entry.scope = Object.freeze({
          authorityId,
          leaseId: id,
          profileKey: deps.profileKey,
          tabId: draft.tabId,
          draftId: draft.owner.id,
          hostGeneration: pin.generation,
          processGeneration: pin.processGeneration,
          sessionId: pin.sessionId,
          sessionEpoch: pin.sessionEpoch,
          branchId: context.branchId,
          revision: context.revision,
        });
        entry.cancelExpiry = deps.schedule(DELIVERY_LEASE_LIMITS.lifetimeMs, () => revoke(entry));
        await operation(
          entry,
          async () => {
            const reader = await openDirectDeliveryReader({
              store: deps.store,
              ...(deps.conversions ? { approvals: deps.conversions } : {}),
              owner: draft.owner,
              representationIds: ids,
              leaseCurrent: async () => authorized(entry),
              sha256: deps.sha256,
            });
            // Publish inside the tracked operation, before its drain/cleanup runs.
            entry.reader = reader;
            if (!authorized(entry)) {
              reader.close();
              return fail();
            }
            entry.phase = "active";
          },
          DELIVERY_LEASE_LIMITS.setupMs,
        );
        if (!authorized(entry) || !entry.reader || !entry.scope) return fail();
        const reader = entry.reader;
        const scope = entry.scope;
        return Object.freeze({
          hostPin: pin,
          id,
          scope,
          expiresAt: entry.expiresAt,
          signal: entry.controller.signal,
          get assets() {
            if (!authorized(entry)) return fail();
            return reader.assets;
          },
          authorized: () => authorized(entry),
          isCurrent: async () => {
            try {
              return await operation(
                entry,
                async () => {
                  if (!(await reader.isCurrent())) return fail();
                  return true;
                },
                DELIVERY_LEASE_LIMITS.operationMs,
              );
            } catch {
              return false;
            }
          },
          readChunk: (representationId: string, offset: number, length: number) =>
            operation(
              entry,
              () => reader.readChunk(representationId, offset, length),
              DELIVERY_LEASE_LIMITS.operationMs,
            ),
          close: () => revoke(entry),
        });
      } catch {
        revoke(entry);
        return fail();
      }
    },
    stats: () => ({
      slots: entries.size,
      reservedBytes: entries.size * DELIVERY_LEASE_LIMITS.bytesPerSlot,
      draining: [...entries.values()].filter(
        (entry) => entry.phase === "closing" && entry.pending > 0,
      ).length,
      cleanupFailed: [...entries.values()].filter((entry) => entry.cleanupFailed).length,
    }),
    retryCleanup() {
      for (const entry of entries.values()) cleanup(entry);
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) revoke(entry);
    },
  };
}
