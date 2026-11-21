/**
 * Main-process related-session service (orchestrator plan step 12).
 *
 * A host forwards one validated request from an extension; this service turns
 * it into a normal Desktop tab operation. It owns the policy that a host cannot
 * grant itself:
 *
 *   - the parent is the tab whose host forwarded the request, never a value in
 *     the payload;
 *   - the child cwd must stay inside the parent project;
 *   - a request id is idempotent, and `(parent, dedupeKey)` reuses one session;
 *   - `open`/`focus`/`inspect`/`interrupt`/`close` only touch sessions this
 *     parent created (no cross-session handle walking);
 *   - an unsupported/untrusted operation fails before a tab is created.
 *
 * Pure Node: tabs, trust and process effects arrive through the injected port.
 */

import {
  validateRelatedSessionRequest,
  type RelatedSessionOperation,
  type RelatedSessionRequest,
  type RelatedSessionResult,
  type SessionBootstrapEntry,
} from "../shared/related-sessions";

export interface RelatedSessionParent {
  /** The provider root the parent session works in. */
  cwd: string;
}

export interface CreateRelatedTabInput {
  cwd: string;
  title: string;
  parentTabId: string;
  relation: "child" | "sibling";
  dedupeKey: string;
  bootstrap: SessionBootstrapEntry[];
}

export interface RelatedSessionInspection {
  title: string;
  running: boolean;
}

export interface RelatedSessionPort {
  parent(parentTabId: string): RelatedSessionParent | null;
  create(input: CreateRelatedTabInput): Promise<{ sessionRef: string }>;
  focus(sessionRef: string): Promise<boolean>;
  inspect(sessionRef: string): Promise<RelatedSessionInspection | null>;
  interrupt(sessionRef: string): Promise<boolean>;
  close(sessionRef: string): Promise<boolean>;
  /** The parent tab that created this ref, or null when it is not related. */
  ownerOf(sessionRef: string): string | null;
}

export interface RelatedSessionService {
  /** Handles one host event; `parentTabId` comes from the host subscription. */
  handle(payload: unknown, parentTabId: string): Promise<RelatedSessionResult>;
  /** Drops idempotency/dedupe state when a parent tab closes. */
  forget(parentTabId: string): void;
}

export interface RelatedSessionServiceOptions {
  port: RelatedSessionPort;
  now?: () => number;
  /** Windows paths compare case-insensitively; Linux/macOS do not. */
  caseInsensitive?: boolean;
  /** Bounded idempotency history. */
  maxRemembered?: number;
}

const MAX_REMEMBERED = 200;
const RESULT_TTL_MS = 10 * 60_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalize(value: string, caseInsensitive: boolean): string {
  const slashed = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return caseInsensitive ? slashed.toLowerCase() : slashed;
}

/** True when `candidate` is the root itself or a descendant of it. */
export function isWithinRoot(candidate: string, root: string, caseInsensitive = false): boolean {
  const left = normalize(candidate, caseInsensitive);
  const right = normalize(root, caseInsensitive);
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  return left.startsWith(`${right}/`);
}

function failure(
  code: "unsupported" | "rejected" | "failed" | "cancelled",
  reason: string,
): RelatedSessionResult {
  return { ok: false, code, reason };
}

export function createRelatedSessionService(
  options: RelatedSessionServiceOptions,
): RelatedSessionService {
  const port = options.port;
  const now = options.now ?? (() => Date.now());
  const caseInsensitive = options.caseInsensitive ?? process.platform === "win32";
  const maxRemembered = options.maxRemembered ?? MAX_REMEMBERED;

  const requests = new Map<string, { at: number; result: Promise<RelatedSessionResult> }>();
  const dedupe = new Map<string, { sessionRef: string; at: number }>();

  const prune = (): void => {
    const at = now();
    for (const [key, entry] of requests) {
      if (at - entry.at > RESULT_TTL_MS || requests.size > maxRemembered) requests.delete(key);
      if (requests.size <= maxRemembered && at - entry.at <= RESULT_TTL_MS) break;
    }
    for (const [key, entry] of dedupe) {
      if (at - entry.at > RESULT_TTL_MS) dedupe.delete(key);
    }
  };

  const dedupeKey = (parentTabId: string, key: string): string => `${parentTabId}\u0000${key}`;

  const run = async (
    input: RelatedSessionRequest,
    parentTabId: string,
  ): Promise<RelatedSessionResult> => {
    const parent = port.parent(parentTabId);
    if (!parent) return failure("rejected", "the requesting tab is no longer open");

    const operation: RelatedSessionOperation = input.operation;

    if (operation === "create") {
      const spec = input.spec;
      if (!spec) return failure("rejected", "create requires a session spec");
      if (!isWithinRoot(spec.cwd, parent.cwd, caseInsensitive)) {
        return failure(
          "rejected",
          `the child folder must stay inside the parent project (${parent.cwd})`,
        );
      }
      const key = dedupeKey(parentTabId, spec.dedupeKey);
      const existing = dedupe.get(key);
      if (existing) {
        const focused = await port.focus(existing.sessionRef);
        return {
          ok: true,
          sessionRef: existing.sessionRef,
          focused,
          reused: true,
        };
      }
      try {
        const created = await port.create({
          cwd: spec.cwd,
          title: spec.title,
          parentTabId,
          relation: spec.relation,
          dedupeKey: spec.dedupeKey,
          bootstrap: spec.bootstrap,
        });
        dedupe.set(key, { sessionRef: created.sessionRef, at: now() });
        return {
          ok: true,
          sessionRef: created.sessionRef,
          focused: true,
          reused: false,
        };
      } catch (error) {
        return failure(
          "failed",
          error instanceof Error ? error.message : "the related session could not be opened",
        );
      }
    }

    const sessionRef = input.sessionRef;
    if (!sessionRef) return failure("rejected", "sessionRef is required");
    if (port.ownerOf(sessionRef) !== parentTabId) {
      return failure("rejected", "that session does not belong to this conversation");
    }

    if (operation === "open" || operation === "focus") {
      const focused = await port.focus(sessionRef);
      return focused
        ? { ok: true, sessionRef, focused: true, reused: operation === "open" }
        : failure("failed", "the related session is no longer open");
    }
    if (operation === "inspect") {
      const inspection = await port.inspect(sessionRef);
      if (!inspection) return failure("failed", "the related session is no longer open");
      return {
        ok: true,
        sessionRef,
        focused: false,
        reused: false,
        title: inspection.title,
        running: inspection.running,
      };
    }
    if (operation === "interrupt") {
      return (await port.interrupt(sessionRef))
        ? { ok: true, sessionRef, focused: false, reused: false }
        : failure("failed", "the related session could not be interrupted");
    }
    if (operation === "close") {
      return (await port.close(sessionRef))
        ? { ok: true, sessionRef, focused: false, reused: false }
        : failure("failed", "the related session could not be closed");
    }
    return failure("unsupported", `unsupported operation ${String(operation)}`);
  };

  const service: RelatedSessionService = {
    async handle(payload, parentTabId) {
      prune();
      const record = asRecord(payload);
      const requestId = typeof record.requestId === "string" ? record.requestId : "";
      // Ownership must be source-bound at the host: an empty key means the
      // request never went through command provenance, so refuse it.
      if (typeof record.ownerKey !== "string" || record.ownerKey.trim().length === 0) {
        return failure("rejected", "the request has no verified extension owner");
      }

      const parsed = validateRelatedSessionRequest(payload);
      if (!parsed.ok) {
        return requestId
          ? { ok: false, code: "rejected", reason: parsed.error }
          : failure("rejected", parsed.error);
      }

      const previous = requestId ? requests.get(requestId) : undefined;
      if (previous) return previous.result;

      const result = run(parsed.value, parentTabId);
      if (requestId) requests.set(requestId, { at: now(), result });
      return result;
    },

    forget(parentTabId) {
      const prefix = `${parentTabId}\u0000`;
      for (const key of dedupe.keys()) {
        if (key.startsWith(prefix)) dedupe.delete(key);
      }
      for (const [key, entry] of requests) {
        if (!entry) requests.delete(key);
      }
    },
  };

  return service;
}
