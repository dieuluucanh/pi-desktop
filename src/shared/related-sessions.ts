/**
 * Generic related-session contract v1 — Desktop reader (orchestrator step 12).
 *
 * The publisher side lives in `@dieulc/workflow`'s `session-host.ts`. Desktop
 * must validate independently: the wire is a contract, not a shared package,
 * so a malformed or oversized payload is rejected here rather than trusted.
 *
 * Trust posture:
 *   - the owning extension is identified by a **registered command name**; the
 *     host resolves that command's SDK `sourceInfo` and derives the owner key.
 *     A payload's own `ownerKey`/`ownerLabel` is never authority;
 *   - `sessionRef` is an opaque host handle (a tab id); an extension must not
 *     assume a path or a process;
 *   - bootstrap entries are bounded and written before `session_start`; they
 *     are data, never a turn trigger;
 *   - an unsupported operation returns `code: "unsupported"` and work does not
 *     start.
 *
 * No SDK and no DOM import: node and web TypeScript projects both use this.
 */

export const RELATED_SESSION_VERSION = 1 as const;

/** Bus channels between an extension and the host bridge. */
export const RELATED_SESSION_CHANNELS = {
  probe: "session-host:probe",
  hello: "session-host:hello",
  request: "session-host:request",
  result: "session-host:result",
} as const;

export const RELATED_SESSION_LIMITS = {
  maxBootstrapEntries: 8,
  maxBootstrapChars: 8_000,
  maxTitleChars: 120,
  maxRefChars: 400,
  maxDedupeChars: 200,
  maxOwnerCommandChars: 64,
  maxOwnerKeyChars: 1_000,
} as const;

export const SESSION_BOOTSTRAP_TYPES = [
  "workflow-managed-session",
  "workflow-task-assignment",
  "workflow-roadmap-reference",
] as const;

export type SessionBootstrapType = (typeof SESSION_BOOTSTRAP_TYPES)[number];

export interface SessionBootstrapEntry {
  customType: SessionBootstrapType;
  /** JSON or plain text; the host writes it as a custom message content. */
  content: string;
  display: boolean;
}

export interface RelatedSessionSpec {
  /** Caller-generated idempotency key; retries reuse it. */
  requestId: string;
  /** Opaque parent identity supplied by the caller (not an auth token). */
  parentSessionRef: string;
  relation: "child" | "sibling";
  title: string;
  /** Absolute working directory for the child. */
  cwd: string;
  /** Semantic starting mode; the bootstrap entry carries the real instruction. */
  mode?: string;
  /** Dedupe key: same key + same parent reuses the existing session. */
  dedupeKey: string;
  bootstrap: SessionBootstrapEntry[];
}

export const RELATED_SESSION_OPERATIONS = [
  "create",
  "open",
  "focus",
  "inspect",
  "interrupt",
  "close",
] as const;

export type RelatedSessionOperation = (typeof RELATED_SESSION_OPERATIONS)[number];

/** What a host advertises before an extension dispatches work. */
export interface RelatedSessionCapabilities {
  version: number;
  create: boolean;
  open: boolean;
  focus: boolean;
  inspect: boolean;
  interrupt: boolean;
  close: boolean;
  separateWindow: boolean;
  bootstrapBeforeStart: boolean;
  /** Ownership is derived from a registered command's SDK source info. */
  sourceBound: boolean;
  label: string;
  reason?: string;
}

export type RelatedSessionErrorCode = "unsupported" | "rejected" | "failed" | "cancelled";

export type RelatedSessionResult =
  | {
      ok: true;
      sessionRef: string;
      focused: boolean;
      reused: boolean;
      title?: string;
      running?: boolean;
    }
  | { ok: false; code: RelatedSessionErrorCode; reason: string };

/** One validated request, as the host forwards it to the desktop main process. */
export interface RelatedSessionRequest {
  requestId: string;
  operation: RelatedSessionOperation;
  /** The extension's registered command name; the host resolves its source. */
  ownerCommand: string;
  spec?: RelatedSessionSpec;
  sessionRef?: string;
}

export type RelatedSessionRequestResult =
  { ok: true; value: RelatedSessionRequest } | { ok: false; error: string };

// Control characters are rejected, not sanitized: a payload must not smuggle
// terminal escapes into a title or a path.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const OPERATION = /^[a-z]+$/;
const COMMAND_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function plainText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  if (CONTROL.test(trimmed)) return undefined;
  return trimmed;
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
}

/**
 * Validates the bounded bootstrap list. Shared by the launch spec, the host's
 * `session.create` params and the main-process service, so no path can write an
 * unbounded or unknown entry before the child starts.
 */
export function validateBootstrapEntries(
  raw: unknown,
): { ok: true; value: SessionBootstrapEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "bootstrap must be an array" };
  if (raw.length > RELATED_SESSION_LIMITS.maxBootstrapEntries) {
    return { ok: false, error: "too many bootstrap entries" };
  }
  const bootstrap: SessionBootstrapEntry[] = [];
  let total = 0;
  for (const entry of raw) {
    if (!isRecord(entry)) return { ok: false, error: "bootstrap entry must be an object" };
    if (
      typeof entry.customType !== "string" ||
      !(SESSION_BOOTSTRAP_TYPES as readonly string[]).includes(entry.customType)
    ) {
      return { ok: false, error: `unsupported bootstrap entry ${String(entry.customType)}` };
    }
    const content = plainText(entry.content, RELATED_SESSION_LIMITS.maxBootstrapChars);
    if (!content) return { ok: false, error: `invalid bootstrap content for ${entry.customType}` };
    total += content.length;
    if (
      total >
      RELATED_SESSION_LIMITS.maxBootstrapChars * RELATED_SESSION_LIMITS.maxBootstrapEntries
    ) {
      return { ok: false, error: "bootstrap content is too large" };
    }
    bootstrap.push({
      customType: entry.customType as SessionBootstrapType,
      content,
      display: entry.display === true,
    });
  }
  return { ok: true, value: bootstrap };
}

/**
 * Validates a launch spec. Control characters, relative cwds, unknown
 * bootstrap types and oversized payloads are rejected wholesale; the child must
 * never start with an instruction the host cannot interpret.
 */
export function validateRelatedSessionSpec(
  raw: unknown,
): { ok: true; value: RelatedSessionSpec } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "spec must be an object" };
  const requestId = plainText(raw.requestId, RELATED_SESSION_LIMITS.maxDedupeChars);
  if (!requestId) return { ok: false, error: "invalid requestId" };
  const parentSessionRef = plainText(raw.parentSessionRef, RELATED_SESSION_LIMITS.maxRefChars);
  if (!parentSessionRef) return { ok: false, error: "invalid parentSessionRef" };
  if (raw.relation !== "child" && raw.relation !== "sibling") {
    return { ok: false, error: "relation must be child or sibling" };
  }
  const title = plainText(raw.title, RELATED_SESSION_LIMITS.maxTitleChars);
  if (!title) return { ok: false, error: "invalid title" };
  const cwd = plainText(raw.cwd, RELATED_SESSION_LIMITS.maxRefChars);
  if (!cwd) return { ok: false, error: "invalid cwd" };
  if (!isAbsolutePath(cwd)) return { ok: false, error: "cwd must be absolute" };
  const mode = raw.mode === undefined ? undefined : plainText(raw.mode, 40);
  if (raw.mode !== undefined && mode === undefined) return { ok: false, error: "invalid mode" };
  const dedupeKey = plainText(raw.dedupeKey, RELATED_SESSION_LIMITS.maxDedupeChars);
  if (!dedupeKey) return { ok: false, error: "invalid dedupeKey" };

  const bootstrap = validateBootstrapEntries(raw.bootstrap);
  if (!bootstrap.ok) return bootstrap;

  return {
    ok: true,
    value: {
      requestId,
      parentSessionRef,
      relation: raw.relation,
      title,
      cwd,
      ...(mode === undefined ? {} : { mode }),
      dedupeKey,
      bootstrap: bootstrap.value,
    },
  };
}

/** Validates one bus/host request before any work is attempted. */
export function validateRelatedSessionRequest(raw: unknown): RelatedSessionRequestResult {
  if (!isRecord(raw)) return { ok: false, error: "request must be an object" };
  const requestId = plainText(raw.requestId, RELATED_SESSION_LIMITS.maxDedupeChars);
  if (!requestId) return { ok: false, error: "invalid requestId" };
  if (
    typeof raw.operation !== "string" ||
    !OPERATION.test(raw.operation) ||
    !(RELATED_SESSION_OPERATIONS as readonly string[]).includes(raw.operation)
  ) {
    return { ok: false, error: "unknown operation" };
  }
  const ownerCommand = plainText(raw.ownerCommand, RELATED_SESSION_LIMITS.maxOwnerCommandChars);
  if (!ownerCommand || !COMMAND_NAME.test(ownerCommand)) {
    return { ok: false, error: "ownerCommand must name a registered command" };
  }
  const operation = raw.operation as RelatedSessionOperation;

  if (operation === "create") {
    const spec = validateRelatedSessionSpec(raw.spec);
    if (!spec.ok) return { ok: false, error: spec.error };
    return { ok: true, value: { requestId, operation, ownerCommand, spec: spec.value } };
  }

  const sessionRef = plainText(raw.sessionRef, RELATED_SESSION_LIMITS.maxRefChars);
  if (!sessionRef) return { ok: false, error: "sessionRef is required" };
  return { ok: true, value: { requestId, operation, ownerCommand, sessionRef } };
}

/** Validates a host answer before the extension receives it. */
export function validateRelatedSessionResult(
  raw: unknown,
): { ok: true; value: RelatedSessionResult } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "result must be an object" };
  if (raw.ok === true) {
    const sessionRef = plainText(raw.sessionRef, RELATED_SESSION_LIMITS.maxRefChars);
    if (!sessionRef) return { ok: false, error: "invalid sessionRef" };
    const title =
      raw.title === undefined
        ? undefined
        : plainText(raw.title, RELATED_SESSION_LIMITS.maxTitleChars);
    if (raw.title !== undefined && title === undefined) {
      return { ok: false, error: "invalid title" };
    }
    return {
      ok: true,
      value: {
        ok: true,
        sessionRef,
        focused: raw.focused === true,
        reused: raw.reused === true,
        ...(title === undefined ? {} : { title }),
        ...(typeof raw.running === "boolean" ? { running: raw.running } : {}),
      },
    };
  }
  if (raw.ok === false) {
    const code = raw.code;
    if (
      code !== "unsupported" &&
      code !== "rejected" &&
      code !== "failed" &&
      code !== "cancelled"
    ) {
      return { ok: false, error: "unknown error code" };
    }
    const reason = plainText(raw.reason, 400);
    if (!reason) return { ok: false, error: "invalid reason" };
    return { ok: true, value: { ok: false, code, reason } };
  }
  return { ok: false, error: "result must say ok: true or ok: false" };
}

/** Validates host capabilities received over the bus. */
export function validateRelatedSessionCapabilities(
  raw: unknown,
): RelatedSessionCapabilities | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.version !== "number" || !Number.isFinite(raw.version)) return null;
  const label = plainText(raw.label, 80);
  if (!label) return null;
  const flag = (value: unknown): boolean => value === true;
  return {
    version: Math.trunc(raw.version),
    create: flag(raw.create),
    open: flag(raw.open),
    focus: flag(raw.focus),
    inspect: flag(raw.inspect),
    interrupt: flag(raw.interrupt),
    close: flag(raw.close),
    separateWindow: flag(raw.separateWindow),
    bootstrapBeforeStart: flag(raw.bootstrapBeforeStart),
    sourceBound: flag(raw.sourceBound),
    label,
    ...(plainText(raw.reason, 400) === undefined ? {} : { reason: plainText(raw.reason, 400) }),
  };
}

/**
 * The one dispatch gate. Returns a user-facing reason instead of throwing, so a
 * caller pauses with an actionable message rather than silently degrading.
 */
export function relatedSessionSupport(
  capabilities: RelatedSessionCapabilities | null,
): string | undefined {
  if (!capabilities) return "the host has not announced related-session support";
  if (capabilities.version < RELATED_SESSION_VERSION) {
    return `related-session contract v${capabilities.version} is older than v${RELATED_SESSION_VERSION}`;
  }
  if (!capabilities.sourceBound) {
    return "this host cannot verify which extension owns the request";
  }
  if (!capabilities.create) return capabilities.reason ?? "this host cannot open a related session";
  if (!capabilities.separateWindow) {
    return capabilities.reason ?? "this host cannot open a separate session window/tab";
  }
  if (!capabilities.bootstrapBeforeStart) {
    return "this host cannot apply the task bootstrap before the child starts";
  }
  if (!capabilities.focus) return "this host cannot bring the child session forward";
  return undefined;
}
