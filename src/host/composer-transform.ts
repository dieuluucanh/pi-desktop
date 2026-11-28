/**
 * Host-side composer-transform operation registry (prompt-refinement row 14).
 *
 * This is the source-bound, SDK-free half of `composer-transform-v1`. It owns
 * one operation per request and never transports a draft, image or model choice
 * through a command string, contribution row or OS argv.
 *
 * Trust boundary:
 *   - ownership is resolved from the host registry (an owner's published
 *     `composer-control`) and from live registered command provenance. A
 *     self-declared bus owner or a matching command name is not authority.
 *   - the public input command and the grant-only bootstrap companion must come
 *     from the same extension source (`resolveComposerOperationCommands`).
 *   - grants are minted from an injected CSPRNG, scoped to the exact request
 *     (owner/source/purpose/session/epoch) and expire. There is no fallback
 *     random source.
 *   - the single-use rendezvous is armed *before* the companion's string
 *     handler runs. The companion receives only the grant bootstrap; the typed
 *     operation port is handed over in-process through the private callback.
 *   - a duplicate `requestId` joins/replays an existing operation; a conflicting
 *     body is refused. Nothing is retried or resent automatically.
 *   - diagnostics contain bounded ids/counts only. Draft text, expanded paste
 *     text, attachment ids/digests, image bytes, grants and model/context are
 *     never logged.
 *
 * The SDK adapter (`src/host/sdk/composer-transform.ts`) supplies the injected
 * ports; this module never imports `@earendil-works/*`.
 */

import {
  COMPOSER_CONTROL_ICONS,
  COMPOSER_CONTROL_KIND,
  COMPOSER_CONTROL_SLOT,
  COMPOSER_TRANSFORM_CONTRACT,
  COMPOSER_TRANSFORM_EVENTS,
  COMPOSER_TRANSFORM_LIMITS,
  COMPOSER_TRANSFORM_VERSION,
  armComposerRendezvous,
  composerTransformDiagnostics,
  formatComposerBootstrapArgs,
  formatComposerGrant,
  isComposerTransformTerminal,
  mintComposerGrant,
  parseComposerTransformApplyReceipt,
  parseComposerTransformCancelReceipt,
  parseComposerTransformCancelRequest,
  parseComposerTransformCurrentRequest,
  parseComposerTransformCurrentStatus,
  parseComposerTransformFailure,
  parseComposerTransformStartedReceipt,
  parseComposerTransformStartRequest,
  parseComposerTransformStatus,
  parseComposerTransformStatusRequest,
  resolveComposerControlTargets,
  resolveComposerOperationCommands,
  type ComposerCommandRegistration,
  type ComposerControlContribution,
  type ComposerProjectedAction,
  type ComposerTransformApplyReceipt,
  type ComposerTransformCancelReceipt,
  type ComposerTransformCandidate,
  type ComposerTransformCurrentStatus,
  type ComposerTransformError,
  type ComposerTransformErrorCode,
  type ComposerTransformFailure,
  type ComposerTransformOperation,
  type ComposerTransformProgress,
  type ComposerTransformResult,
  type ComposerTransformStartRequest,
  type ComposerTransformStartedReceipt,
  type ComposerTransformState,
  type ComposerTransformStatus,
  type ComposerRendezvousHost,
} from "../shared/composer-transform";
import type { HostMethod } from "../shared/host-protocol";
import type { HostHandler } from "./service";

/** Methods this registry answers; the allowlist lives in `host-protocol.ts`. */
export const COMPOSER_TRANSFORM_METHODS = [
  "composer.transform",
  "composer.status",
  "composer.cancel",
  "composer.applied",
  "composer.current",
] as const satisfies readonly HostMethod[];

export interface ComposerTransformClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ComposerTransformBus {
  on(channel: string, handler: (payload: unknown) => unknown): () => void;
  emit(channel: string, payload?: unknown): void;
}

/**
 * Resolves a renderer request's owner/control/revision against the host's
 * contribution registry. Returning the raw control plus the owner's projected
 * actions lets this module re-check same-owner references itself.
 */
export interface ComposerTransformControlPort {
  resolve(input: { ownerId: string; controlId: string; contributionRevision: number }):
    | {
        ok: true;
        control: ComposerControlContribution;
        actions: readonly ComposerProjectedAction[];
      }
    | { ok: false; error: ComposerTransformError };
}

/** Live command registrations with SDK source provenance. */
export interface ComposerTransformCommandSource {
  list(): readonly ComposerCommandRegistration[];
}

/**
 * The resolved companion's existing string handler, invoked with only the
 * grant-only bootstrap args and a real SDK command context.
 */
export interface ComposerTransformCompanionInvoker {
  invoke(name: string, args: string): Promise<{ ran: boolean; error?: string }>;
}

export interface ComposerTransformHostOptions {
  controls: ComposerTransformControlPort;
  commands: ComposerTransformCommandSource;
  companion: ComposerTransformCompanionInvoker;
  /** The live tab/session binding this host serves. */
  binding(): { sessionId: string | null; epoch: number };
  /** The shared extension event bus behind `pi.events`. */
  bus?: ComposerTransformBus | null;
  clock?: ComposerTransformClock;
  /** Injected CSPRNG; absent means no grants are minted (fail closed). */
  randomBytes?: (size: number) => Uint8Array;
  /** Host protocol event sink; `sessionId` fences the event to its tab. */
  emit?(event: string, payload?: unknown, sessionId?: string): void;
  /** Injected diagnostic sink. Receives bounded ids only, never drafts/grants. */
  log?(line: string): void;
  onError?(error: unknown): void;
  /** Rendezvous claim window. */
  ttlMs?: number;
  /** How long a settled request id can replay after completion. */
  receiptTtlMs?: number;
  /** Bounded request-id retention. */
  maxRetained?: number;
}

export interface ComposerTransformHost {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
  start(raw: unknown): ComposerTransformResult<ComposerTransformStartedReceipt>;
  status(raw: unknown): ComposerTransformResult<ComposerTransformStatus>;
  /** Reads the one live operation bound to the caller's tab (plan step 23). */
  current(raw: unknown): ComposerTransformResult<ComposerTransformCurrentStatus>;
  cancel(raw: unknown): ComposerTransformResult<ComposerTransformCancelReceipt>;
  applied(raw: unknown): ComposerTransformResult<ComposerTransformApplyReceipt>;
  capabilities(): {
    contractVersion: typeof COMPOSER_TRANSFORM_VERSION;
    kinds: readonly string[];
    slots: readonly string[];
    maxFrameBytes: number;
    icons: readonly string[];
  };
  announce(): void;
  /**
   * Cancels every live operation/grant without dropping the bounded settled
   * receipts. A host crash/restart, a session rebind, a publisher disable and
   * a policy/trust revocation all use this: the renderer keeps its draft text
   * and in-memory attachments, but no old job can deliver a cached result.
   */
  invalidate(reason: string): void;
  /** Drops every live operation/grant/listener without emitting a result. */
  reset(): void;
  dispose(): void;
  /** Bounded diagnostics projection for one operation (no draft/grant). */
  diagnostics(requestId: string): Record<string, unknown> | undefined;
}

/** A host refusal; the service forwards `code` as the protocol error code. */
export class ComposerTransformHostError extends Error {
  readonly code: ComposerTransformErrorCode;

  constructor(code: ComposerTransformErrorCode, message: string) {
    super(message);
    this.name = "ComposerTransformHostError";
    this.code = code;
  }
}

const DEFAULT_CLOCK: ComposerTransformClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    if (handle !== undefined && handle !== null) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  },
};

const DEFAULT_TTL_MS = COMPOSER_TRANSFORM_LIMITS.grantTtlMs;
const DEFAULT_RECEIPT_TTL_MS = 60_000;

interface Job {
  request: ComposerTransformStartRequest;
  fingerprint: string;
  operationId: string;
  operation: ComposerTransformOperation;
  receipt: ComposerTransformStartedReceipt;
  state: ComposerTransformState;
  /** Monotonic status revision, never the draft revision. */
  revision: number;
  updatedAt: number;
  claimed: boolean;
  disposed: boolean;
  abort: AbortController;
  expiryHandle?: unknown;
  rendezvous?: ComposerRendezvousHost;
  candidate?: ComposerTransformCandidate;
  applied?: ComposerTransformApplyReceipt;
  failure?: ComposerTransformFailure;
  /** True once the companion handler was invoked for this operation. */
  companionInvoked: boolean;
}

interface SettledJob {
  at: number;
  fingerprint: string;
  receipt: ComposerTransformStartedReceipt;
  status: ComposerTransformStatus;
  applied?: ComposerTransformApplyReceipt;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Deterministic request identity for duplicate/conflict detection. */
function fingerprintOf(request: ComposerTransformStartRequest): string {
  return JSON.stringify(request);
}

function statusOf(job: Job): ComposerTransformStatus {
  const parsed = parseComposerTransformStatus({
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: job.request.requestId,
    operationId: job.operationId,
    state: job.state,
    revision: job.revision,
    updatedAt: job.updatedAt,
    terminal: isComposerTransformTerminal(job.state),
  });
  // The values are built from validated fields; a failure here is a bug, so
  // surface the parser's message instead of emitting an invalid frame.
  if (!parsed.ok) throw new ComposerTransformHostError(parsed.error.code, parsed.error.message);
  return parsed.value;
}

function failureOf(
  job: Job,
  code: ComposerTransformErrorCode,
  message: string,
  retryable: boolean,
  at: number,
): ComposerTransformFailure {
  const parsed = parseComposerTransformFailure({
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: job.request.requestId,
    operationId: job.operationId,
    code,
    message,
    retryable,
    at,
  });
  if (!parsed.ok) throw new ComposerTransformHostError(parsed.error.code, parsed.error.message);
  return parsed.value;
}

function operationIdOf(randomBytes: (size: number) => Uint8Array): string | undefined {
  let bytes: Uint8Array;
  try {
    bytes = randomBytes(16);
  } catch {
    return undefined;
  }
  if (bytes.length !== 16) return undefined;
  // Independent from the grant id: an operation id is safe to log, a grant id
  // is not. 128 bits of the same injected CSPRNG keep ids unguessable.
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `op-${hex}`;
}

export function createComposerTransformHost(
  options: ComposerTransformHostOptions,
): ComposerTransformHost {
  const clock = options.clock ?? DEFAULT_CLOCK;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const receiptTtlMs = options.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS;
  const maxRetained = Math.max(
    1,
    options.maxRetained ?? COMPOSER_TRANSFORM_LIMITS.maxRetainedReceipts,
  );

  /** Live operations, including terminal ones until reset/eviction. */
  const jobs = new Map<string, Job>();
  const byOperation = new Map<string, Job>();
  /** Bounded idempotent replay of settled request ids. */
  const settled = new Map<string, SettledJob>();
  const offs: Array<() => void> = [];
  let disposed = false;

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      /* diagnostics must never break the host loop */
    }
  };

  const log = (line: string): void => {
    try {
      options.log?.(line);
    } catch {
      /* a broken logger must not break an operation */
    }
  };

  const emit = (event: string, payload: unknown, job: Job): void => {
    try {
      options.emit?.(event, payload, job.request.binding.sessionId);
    } catch (error) {
      report(error);
    }
  };

  const remember = (job: Job): void => {
    settled.set(job.request.requestId, {
      at: clock.now(),
      fingerprint: job.fingerprint,
      receipt: job.receipt,
      status: statusOf(job),
      ...(job.applied === undefined ? {} : { applied: job.applied }),
    });
    // A terminal operation is retained only in the bounded settled map; the
    // live maps stop growing with historical request ids.
    jobs.delete(job.request.requestId);
    byOperation.delete(job.operationId);
    while (settled.size > maxRetained) {
      const oldest = settled.keys().next();
      if (oldest.done) break;
      settled.delete(oldest.value);
    }
  };

  const pruneSettled = (): void => {
    const at = clock.now();
    for (const [requestId, entry] of settled) {
      if (at - entry.at > receiptTtlMs) settled.delete(requestId);
    }
  };

  const clearExpiry = (job: Job): void => {
    if (job.expiryHandle === undefined) return;
    try {
      clock.clearTimeout(job.expiryHandle);
    } catch {
      /* a fake clock may not need clearing */
    }
    job.expiryHandle = undefined;
  };

  const markClaimed = (job: Job): void => {
    if (job.claimed) return;
    job.claimed = true;
    clearExpiry(job);
  };

  const teardown = (job: Job, reason: string): void => {
    job.disposed = true;
    clearExpiry(job);
    try {
      job.rendezvous?.dispose();
    } catch (error) {
      report(error);
    }
    job.rendezvous = undefined;
    if (!job.abort.signal.aborted) {
      try {
        job.abort.abort(reason);
      } catch {
        /* an abort listener must not prevent teardown */
      }
    }
  };

  const failJob = (
    job: Job,
    code: ComposerTransformErrorCode,
    message: string,
    retryable: boolean,
  ): void => {
    if (job.disposed || isComposerTransformTerminal(job.state)) return;
    const at = clock.now();
    job.state = "failed";
    job.revision += 1;
    job.updatedAt = at;
    job.failure = failureOf(job, code, message, retryable, at);
    clearExpiry(job);
    try {
      job.rendezvous?.dispose();
    } catch (error) {
      report(error);
    }
    emit(COMPOSER_TRANSFORM_EVENTS.result, job.failure, job);
    remember(job);
    log(`composer-transform ${job.request.requestId} ${job.operationId} failed ${code}`);
  };

  const expire = (job: Job): void => {
    if (job.disposed || job.claimed || isComposerTransformTerminal(job.state)) return;
    const at = clock.now();
    job.state = "expired";
    job.revision += 1;
    job.updatedAt = at;
    job.failure = failureOf(
      job,
      "expired",
      "the companion did not claim the bootstrap before the grant expired",
      true,
      at,
    );
    try {
      job.rendezvous?.dispose();
    } catch (error) {
      report(error);
    }
    emit(COMPOSER_TRANSFORM_EVENTS.result, job.failure, job);
    remember(job);
    log(`composer-transform ${job.request.requestId} ${job.operationId} expired`);
  };

  const fence = (
    binding: ComposerTransformStartRequest["binding"],
  ): ComposerTransformError | undefined => {
    const current = options.binding();
    if (!current.sessionId) {
      return { code: "not-owner", message: "no live session is bound to this host" };
    }
    if (binding.sessionId !== current.sessionId) {
      return { code: "not-owner", message: "the request belongs to another session" };
    }
    if (binding.epoch !== current.epoch) {
      return {
        code: "stale-revision",
        message: "the request is from an older host/session epoch",
      };
    }
    return undefined;
  };

  const findJob = (
    requestIdValue: string,
    operationIdValue: string,
  ): ComposerTransformResult<Job> => {
    const job = byOperation.get(operationIdValue);
    if (!job) {
      return { ok: false, error: { code: "expired", message: "unknown composer operation" } };
    }
    if (job.request.requestId !== requestIdValue) {
      return {
        ok: false,
        error: { code: "invalid-request-id", message: "requestId does not match its operation" },
      };
    }
    const fenced = fence(job.request.binding);
    if (fenced) return { ok: false, error: fenced };
    return { ok: true, value: job };
  };

  const start = (raw: unknown): ComposerTransformResult<ComposerTransformStartedReceipt> => {
    if (disposed) {
      return { ok: false, error: { code: "cancelled", message: "the host was disposed" } };
    }
    const parsed = parseComposerTransformStartRequest(raw);
    if (!parsed.ok) return parsed;
    const request = parsed.value;
    const fingerprint = fingerprintOf(request);
    pruneSettled();

    const live = jobs.get(request.requestId);
    if (live) {
      if (live.fingerprint === fingerprint) {
        // A retry after a lost receipt joins the same operation; it must not
        // start a second companion/runtime.
        return { ok: true, value: live.receipt };
      }
      return {
        ok: false,
        error: {
          code: "request-conflict",
          message: "requestId is already in use by a different operation",
        },
      };
    }
    const replay = settled.get(request.requestId);
    if (replay) {
      if (replay.fingerprint === fingerprint) return { ok: true, value: replay.receipt };
      return {
        ok: false,
        error: {
          code: "request-conflict",
          message: "requestId is already in use by a different operation",
        },
      };
    }

    const fenced = fence(request.binding);
    if (fenced) return { ok: false, error: fenced };

    // One live operation per composer binding (plan step 23). A reloaded or
    // reattached renderer that lost its in-memory record must reconcile the
    // live operation through `composer.current` instead of starting a second
    // provider call under a fresh request id.
    for (const liveJob of jobs.values()) {
      if (liveJob.disposed || isComposerTransformTerminal(liveJob.state)) continue;
      if (
        liveJob.request.binding.sessionId === request.binding.sessionId &&
        liveJob.request.binding.epoch === request.binding.epoch
      ) {
        return {
          ok: false,
          error: {
            code: "request-conflict",
            message: "another operation is already live for this composer",
          },
        };
      }
    }

    const resolvedControl = options.controls.resolve({
      ownerId: request.ownerId,
      controlId: request.controlId,
      contributionRevision: request.contributionRevision,
    });
    if (!resolvedControl.ok) return resolvedControl;
    if (resolvedControl.control.id !== request.controlId) {
      return {
        ok: false,
        error: { code: "unresolved-action", message: "the control id does not match the registry" },
      };
    }
    const targets = resolveComposerControlTargets(
      request.ownerId,
      resolvedControl.control,
      resolvedControl.actions,
    );
    if (!targets.ok) return targets;
    if (targets.value.transform.id !== request.transformActionId) {
      return {
        ok: false,
        error: {
          code: "invalid-reference",
          message: "transformActionId does not name the declared transform action",
        },
      };
    }
    if (targets.value.toggle.id !== request.actionId) {
      return {
        ok: false,
        error: {
          code: "invalid-reference",
          message: "actionId does not name the declared toggle action",
        },
      };
    }

    // Live command provenance is the authority, not the renderer's metadata.
    const commands = resolveComposerOperationCommands(
      targets.value.operation,
      options.commands.list(),
    );
    if (!commands.ok) return commands;
    if (commands.value.publicCommand.name !== targets.value.transform.command?.name) {
      return {
        ok: false,
        error: {
          code: "invalid-reference",
          message: "the transform action must invoke the declared public command",
        },
      };
    }

    if (typeof options.randomBytes !== "function") {
      return {
        ok: false,
        error: {
          code: "unauthorized",
          message: "this host cannot mint an unpredictable operation grant",
        },
      };
    }
    const minted = mintComposerGrant(options.randomBytes);
    if (!minted.ok) return minted;
    const grant = minted.value;
    const operationId = operationIdOf(options.randomBytes);
    if (!operationId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "the CSPRNG could not mint an operation id" },
      };
    }

    // The bus is the only private channel available in SDK 1.5. Without it the
    // companion cannot receive the typed port, so fail closed.
    if (!options.bus) {
      return {
        ok: false,
        error: {
          code: "rendezvous-invalid",
          message: "this host has no in-process event bus for the private rendezvous",
        },
      };
    }

    const at = clock.now();
    const receiptParsed = parseComposerTransformStartedReceipt({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: request.requestId,
      operationId,
      status: "started",
      binding: request.binding,
      startedAt: at,
    });
    if (!receiptParsed.ok) return receiptParsed;
    const receipt = receiptParsed.value;

    const abort = new AbortController();
    const operation: ComposerTransformOperation = {
      request,
      operationId,
      binding: request.binding,
      signal: abort.signal,
    };
    const job: Job = {
      request,
      fingerprint,
      operationId,
      operation,
      receipt,
      state: "accepted",
      revision: 1,
      updatedAt: at,
      claimed: false,
      disposed: false,
      abort,
      companionInvoked: false,
    };

    const armed = armComposerRendezvous({
      bus: options.bus,
      grant: formatComposerGrant(grant),
      operation,
      now: () => clock.now(),
      ttlMs,
      handlers: {
        onProgress(update: ComposerTransformProgress) {
          if (job.disposed || isComposerTransformTerminal(job.state)) return;
          markClaimed(job);
          job.state = update.state;
          job.revision += 1;
          job.updatedAt = update.at;
          emit(COMPOSER_TRANSFORM_EVENTS.progress, update, job);
          log(`composer-transform ${job.request.requestId} ${job.operationId} ${update.state}`);
        },
        onCandidate(candidate: ComposerTransformCandidate) {
          if (job.disposed || isComposerTransformTerminal(job.state)) return;
          markClaimed(job);
          if (candidate.candidateRevision <= job.revision) {
            report(
              new ComposerTransformHostError(
                "stale-revision",
                "a candidate cannot replace an equal or older revision",
              ),
            );
            return;
          }
          job.candidate = candidate;
          job.state = "candidate";
          job.revision = candidate.candidateRevision;
          job.updatedAt = candidate.at;
          emit(COMPOSER_TRANSFORM_EVENTS.result, candidate, job);
          log(
            `composer-transform ${job.request.requestId} ${job.operationId} candidate ${candidate.candidateRevision}`,
          );
        },
        onFailure(failure: ComposerTransformFailure) {
          if (job.disposed || isComposerTransformTerminal(job.state)) return;
          markClaimed(job);
          job.failure = failure;
          job.state = "failed";
          job.revision += 1;
          job.updatedAt = failure.at;
          emit(COMPOSER_TRANSFORM_EVENTS.result, failure, job);
          remember(job);
          log(
            `composer-transform ${job.request.requestId} ${job.operationId} failed ${failure.code}`,
          );
        },
        onInvalid(error: ComposerTransformError) {
          report(new ComposerTransformHostError(error.code, error.message));
        },
      },
      onReject(error: ComposerTransformError) {
        if (job.disposed || job.claimed || isComposerTransformTerminal(job.state)) return;
        failJob(job, error.code, error.message, false);
      },
    });
    if (!armed.ok) {
      return armed;
    }
    job.rendezvous = armed.value;
    job.expiryHandle = clock.setTimeout(() => {
      job.expiryHandle = undefined;
      if (job.rendezvous?.claimed()) {
        markClaimed(job);
        return;
      }
      expire(job);
    }, ttlMs);

    jobs.set(request.requestId, job);
    byOperation.set(operationId, job);

    // Prompt/model work happens only after the accepted, source-bound receipt.
    // The companion is invoked once, asynchronously; a failed bootstrap is a
    // definite failure and is never retried automatically.
    job.companionInvoked = true;
    void Promise.resolve()
      .then(() =>
        options.companion.invoke(
          commands.value.companionCommand.name,
          formatComposerBootstrapArgs(formatComposerGrant(grant)),
        ),
      )
      .then((result) => {
        if (result.ran) return;
        failJob(
          job,
          "rendezvous-invalid",
          result.error ?? "the companion command is not registered",
          false,
        );
      })
      .catch((error: unknown) => {
        failJob(
          job,
          "rendezvous-invalid",
          error instanceof Error ? error.message : String(error),
          false,
        );
      });

    log(
      `composer-transform ${request.requestId} ${operationId} accepted owner=${request.ownerId} control=${request.controlId} revision=${request.contributionRevision}`,
    );
    return { ok: true, value: receipt };
  };

  const status = (raw: unknown): ComposerTransformResult<ComposerTransformStatus> => {
    const parsed = parseComposerTransformStatusRequest(raw);
    if (!parsed.ok) return parsed;
    const found = findJob(parsed.value.requestId, parsed.value.operationId);
    if (found.ok) return { ok: true, value: statusOf(found.value) };
    // Receipt loss: a settled operation still answers its terminal state so the
    // renderer can reconcile instead of starting the transform again.
    const replay = settled.get(parsed.value.requestId);
    if (replay && clock.now() - replay.at <= receiptTtlMs) {
      return { ok: true, value: replay.status };
    }
    return found;
  };

  const current = (raw: unknown): ComposerTransformResult<ComposerTransformCurrentStatus> => {
    const parsed = parseComposerTransformCurrentRequest(raw);
    if (!parsed.ok) return parsed;
    const bound = options.binding();
    const requested = parsed.value.binding;
    // A stale epoch/binding is a different composer: answer "nothing live"
    // instead of leaking another generation's operation.
    const sameLiveBinding =
      !!bound.sessionId &&
      requested.sessionId === bound.sessionId &&
      requested.epoch === bound.epoch;
    if (!sameLiveBinding) {
      return {
        ok: true,
        value: {
          contract: COMPOSER_TRANSFORM_CONTRACT,
          binding: requested,
          operation: null,
        },
      };
    }
    let found: Job | undefined;
    for (const job of jobs.values()) {
      if (job.disposed || isComposerTransformTerminal(job.state)) continue;
      if (
        job.request.binding.sessionId !== requested.sessionId ||
        job.request.binding.epoch !== requested.epoch
      ) {
        continue;
      }
      if (found === undefined || job.revision > found.revision) found = job;
    }
    if (!found) {
      return {
        ok: true,
        value: {
          contract: COMPOSER_TRANSFORM_CONTRACT,
          binding: requested,
          operation: null,
        },
      };
    }
    // Candidate text is private to this binding; the request was fenced above
    // and the response is delivered over the same tab IPC. Diagnostics never
    // include it.
    const candidate = found.candidate;
    const value = parseComposerTransformCurrentStatus({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      binding: requested,
      operation: {
        requestId: found.request.requestId,
        operationId: found.operationId,
        ownerId: found.request.ownerId,
        controlId: found.request.controlId,
        state: found.state,
        revision: found.revision,
        updatedAt: found.updatedAt,
        ...(candidate === undefined
          ? {}
          : {
              candidate: {
                candidateRevision: candidate.candidateRevision,
                text: candidate.text,
                ...(candidate.summary === undefined ? {} : { summary: candidate.summary }),
                at: candidate.at,
              },
            }),
      },
    });
    if (!value.ok) return value;
    return { ok: true, value: value.value };
  };

  const cancel = (raw: unknown): ComposerTransformResult<ComposerTransformCancelReceipt> => {
    const parsed = parseComposerTransformCancelRequest(raw);
    if (!parsed.ok) return parsed;
    const at = clock.now();
    const found = findJob(parsed.value.requestId, parsed.value.operationId);
    if (!found.ok) {
      // A terminal operation is replayed from the bounded settled map so a
      // repeated cancel never reports "not-found" for a completed request.
      const replay = settled.get(parsed.value.requestId);
      if (replay && clock.now() - replay.at <= receiptTtlMs) {
        return {
          ok: true,
          value: {
            contract: COMPOSER_TRANSFORM_CONTRACT,
            requestId: parsed.value.requestId,
            operationId: parsed.value.operationId,
            state: "already-terminal",
            at,
          },
        };
      }
      return {
        ok: true,
        value: {
          contract: COMPOSER_TRANSFORM_CONTRACT,
          requestId: parsed.value.requestId,
          operationId: parsed.value.operationId,
          state: "not-found",
          at,
        },
      };
    }
    const job = found.value;
    if (isComposerTransformTerminal(job.state)) {
      return {
        ok: true,
        value: {
          contract: COMPOSER_TRANSFORM_CONTRACT,
          requestId: parsed.value.requestId,
          operationId: parsed.value.operationId,
          state: "already-terminal",
          at,
        },
      };
    }
    job.state = "cancelled";
    job.revision += 1;
    job.updatedAt = at;
    job.failure = failureOf(job, "cancelled", "the operation was cancelled", false, at);
    teardown(job, parsed.value.reason ?? "cancelled");
    emit(COMPOSER_TRANSFORM_EVENTS.result, job.failure, job);
    remember(job);
    log(`composer-transform ${job.request.requestId} ${job.operationId} cancelled`);
    const receipt = parseComposerTransformCancelReceipt({
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: parsed.value.requestId,
      operationId: parsed.value.operationId,
      state: "cancelled",
      at,
    });
    if (!receipt.ok) return receipt;
    return { ok: true, value: receipt.value };
  };

  const applied = (raw: unknown): ComposerTransformResult<ComposerTransformApplyReceipt> => {
    const parsed = parseComposerTransformApplyReceipt(raw);
    if (!parsed.ok) return parsed;
    const found = findJob(parsed.value.requestId, parsed.value.operationId);
    if (!found.ok) {
      const replay = settled.get(parsed.value.requestId);
      if (replay?.applied && replay.applied.appliedRevision === parsed.value.appliedRevision) {
        return { ok: true, value: replay.applied };
      }
      return found;
    }
    const job = found.value;
    if (job.applied) {
      // An apply receipt whose acknowledgement was lost can be replayed without
      // replacing the draft twice or starting another provider call.
      if (job.applied.appliedRevision === parsed.value.appliedRevision) {
        return { ok: true, value: job.applied };
      }
      return {
        ok: false,
        error: { code: "stale-revision", message: "a different candidate is already applied" },
      };
    }
    if (job.state === "cancelled" || job.state === "expired" || job.state === "failed") {
      const code: ComposerTransformErrorCode =
        job.state === "cancelled"
          ? "cancelled"
          : job.state === "expired"
            ? "expired"
            : "rendezvous-invalid";
      return {
        ok: false,
        error: { code, message: "the operation is terminal" },
      };
    }
    if (job.state !== "candidate" || !job.candidate) {
      return {
        ok: false,
        error: { code: "invalid-state", message: "there is no candidate to apply" },
      };
    }
    if (parsed.value.appliedRevision !== job.candidate.candidateRevision) {
      return {
        ok: false,
        error: {
          code: "stale-revision",
          message: "the applied revision is not the current candidate",
        },
      };
    }
    job.applied = parsed.value;
    job.state = parsed.value.disposition === "replaced" ? "applied" : "conflicted";
    job.revision += 1;
    job.updatedAt = parsed.value.appliedAt;
    emit(COMPOSER_TRANSFORM_EVENTS.applied, parsed.value, job);
    // The one-shot toggle is owned by the publisher, not the renderer: the
    // applied receipt is its only automatic disarm, and it must reach the
    // extension bus as well as the renderer frames. Renderer-only delivery
    // left a reloaded renderer reading a stale `checked:true` from a publisher
    // that never learned the apply had happened (plan step 15/23).
    if (options.bus) {
      try {
        options.bus.emit(COMPOSER_TRANSFORM_EVENTS.applied, parsed.value);
      } catch (error) {
        report(error);
      }
    }
    remember(job);
    log(
      `composer-transform ${job.request.requestId} ${job.operationId} ${job.state} revision=${parsed.value.appliedRevision}`,
    );
    return { ok: true, value: parsed.value };
  };

  const capabilities = () => ({
    contractVersion: COMPOSER_TRANSFORM_VERSION,
    kinds: [COMPOSER_CONTROL_KIND] as readonly string[],
    slots: [COMPOSER_CONTROL_SLOT] as readonly string[],
    maxFrameBytes: COMPOSER_TRANSFORM_LIMITS.maxAggregateFrameBytes,
    icons: COMPOSER_CONTROL_ICONS as readonly string[],
  });

  const announce = (): void => {
    try {
      options.bus?.emit(COMPOSER_TRANSFORM_EVENTS.hello, capabilities());
    } catch (error) {
      report(error);
    }
  };

  if (options.bus && !disposed) {
    try {
      offs.push(
        options.bus.on(COMPOSER_TRANSFORM_EVENTS.probe, () => {
          announce();
          return undefined;
        }),
      );
    } catch (error) {
      report(error);
    }
  }

  const reset = (): void => {
    for (const job of jobs.values()) teardown(job, "reset");
    jobs.clear();
    byOperation.clear();
    settled.clear();
  };

  /**
   * Cancels every live operation and drops every outstanding grant while
   * retaining the bounded settled receipts. This is the lifecycle invalidation
   * used by host restart/crash recovery, a session rebind
   * (new/resume/fork/rewind), a publisher disable and policy/trust revocation:
   * a cached candidate can never become applicable afterwards, and the renderer
   * keeps its own draft text/attachments.
   */
  const invalidate = (reason: string): void => {
    const at = clock.now();
    const message = reason.length > 0 ? reason : "the operation was invalidated";
    for (const job of [...jobs.values()]) {
      if (job.disposed) continue;
      if (isComposerTransformTerminal(job.state)) {
        // A finished operation keeps its settled receipt for idempotent replay;
        // teardown is already done when it was remembered.
        continue;
      }
      job.state = "cancelled";
      job.revision += 1;
      job.updatedAt = at;
      job.failure = failureOf(job, "cancelled", message, false, at);
      teardown(job, message);
      emit(COMPOSER_TRANSFORM_EVENTS.result, job.failure, job);
      remember(job);
      log(`composer-transform ${job.request.requestId} ${job.operationId} invalidated`);
    }
  };

  const host: ComposerTransformHost = {
    handlers: () => ({
      "composer.transform": (params) => {
        const result = start(params);
        if (!result.ok)
          throw new ComposerTransformHostError(result.error.code, result.error.message);
        return result.value;
      },
      "composer.status": (params) => {
        const result = status(params);
        if (!result.ok)
          throw new ComposerTransformHostError(result.error.code, result.error.message);
        return result.value;
      },
      "composer.current": (params) => {
        const result = current(params);
        if (!result.ok)
          throw new ComposerTransformHostError(result.error.code, result.error.message);
        return result.value;
      },
      "composer.cancel": (params) => {
        const result = cancel(params);
        if (!result.ok)
          throw new ComposerTransformHostError(result.error.code, result.error.message);
        return result.value;
      },
      "composer.applied": (params) => {
        const result = applied(params);
        if (!result.ok)
          throw new ComposerTransformHostError(result.error.code, result.error.message);
        return result.value;
      },
    }),
    start,
    status,
    current,
    cancel,
    applied,
    capabilities,
    announce,
    invalidate,
    reset,
    dispose() {
      if (disposed) return;
      disposed = true;
      reset();
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch (error) {
          report(error);
        }
      }
    },
    diagnostics(requestIdValue: string) {
      const job = jobs.get(requestIdValue);
      if (!job) return undefined;
      return {
        ...composerTransformDiagnostics(job.request),
        operationId: job.operationId,
        state: job.state,
        revision: job.revision,
        claimed: job.claimed,
        companionInvoked: job.companionInvoked,
      };
    },
  };

  return host;
}

/** Narrow helper for tests/wiring: the request-id retention is bounded. */
export function composerTransformHostLimits(): {
  ttlMs: number;
  receiptTtlMs: number;
  maxRetained: number;
  maxFrameBytes: number;
} {
  return {
    ttlMs: DEFAULT_TTL_MS,
    receiptTtlMs: DEFAULT_RECEIPT_TTL_MS,
    maxRetained: COMPOSER_TRANSFORM_LIMITS.maxRetainedReceipts,
    maxFrameBytes: COMPOSER_TRANSFORM_LIMITS.maxAggregateFrameBytes,
  };
}

/** Re-exported for the SDK adapter and tests that only need the shape. */
export type { ComposerTransformError, ComposerTransformErrorCode, ComposerTransformResult };
export type { ComposerTransformStartRequest };
export type { ComposerControlContribution, ComposerProjectedAction, ComposerCommandRegistration };
export type { ComposerTransformState };
export { asRecord as composerTransformAsRecord };
