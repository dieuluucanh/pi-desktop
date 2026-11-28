import { describe, expect, it } from "vitest";
import {
  RELATED_SESSION_LIMITS,
  RELATED_SESSION_VERSION,
  relatedSessionSupport,
  validateBootstrapEntries,
  validateRelatedSessionCapabilities,
  validateRelatedSessionRequest,
  validateRelatedSessionResult,
  validateRelatedSessionSpec,
} from "../../src/shared/related-sessions";

/**
 * Desktop's independent reader of the related-session contract (orchestrator
 * step 12). The publisher lives in another package, so malformed, unbounded or
 * unknown payloads must be rejected here rather than trusted.
 */

function spec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-1",
    parentSessionRef: "session-parent",
    relation: "child",
    title: "Task 2 — build",
    cwd: "C:/work/app",
    dedupeKey: "task-2",
    bootstrap: [
      {
        customType: "workflow-managed-session",
        content: '{"version":1}',
        display: false,
      },
    ],
    ...over,
  };
}

function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-1",
    operation: "create",
    ownerCommand: "workflow",
    spec: spec(),
    // Native operations require the host-issued capability grant; a payload's
    // own owner string is not authority.
    grant: { token: "grant-1", ownerCommand: "workflow", sessionId: "session-1", epoch: 1 },
    ...over,
  };
}

describe("related-session spec", () => {
  it("accepts a bounded create spec", () => {
    const parsed = validateRelatedSessionSpec(spec());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.relation).toBe("child");
    expect(parsed.value.bootstrap).toHaveLength(1);
  });

  it("requires an absolute cwd", () => {
    expect(validateRelatedSessionSpec(spec({ cwd: "work/app" }))).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(validateRelatedSessionSpec(spec({ cwd: "C:\\work\\app" })).ok).toBe(true);
    expect(validateRelatedSessionSpec(spec({ cwd: "/work/app" })).ok).toBe(true);
  });

  it("rejects unknown bootstrap types, control characters and oversized content", () => {
    expect(
      validateRelatedSessionSpec(
        spec({ bootstrap: [{ customType: "shell", content: "rm -rf /", display: false }] }),
      ).ok,
    ).toBe(false);
    expect(
      validateRelatedSessionSpec(
        spec({
          bootstrap: [
            { customType: "workflow-task-assignment", content: "a\u0007b", display: false },
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateRelatedSessionSpec(
        spec({
          bootstrap: [
            {
              customType: "workflow-task-assignment",
              content: "x".repeat(RELATED_SESSION_LIMITS.maxBootstrapChars + 1),
              display: false,
            },
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateRelatedSessionSpec(
        spec({
          bootstrap: Array.from({ length: RELATED_SESSION_LIMITS.maxBootstrapEntries + 1 }, () => ({
            customType: "workflow-task-assignment",
            content: "x",
            display: false,
          })),
        }),
      ).ok,
    ).toBe(false);
  });

  it("validates a bare bootstrap list for the host's session.create params", () => {
    expect(validateBootstrapEntries([])).toEqual({ ok: true, value: [] });
    expect(validateBootstrapEntries([{ customType: "nope", content: "x" }]).ok).toBe(false);
    expect(validateBootstrapEntries("x").ok).toBe(false);
  });
});

describe("related-session request", () => {
  it("requires a registered-command-shaped owner", () => {
    expect(validateRelatedSessionRequest(request({ ownerCommand: "" })).ok).toBe(false);
    expect(validateRelatedSessionRequest(request({ ownerCommand: "Bad Name" })).ok).toBe(false);
    expect(validateRelatedSessionRequest(request()).ok).toBe(true);
  });

  it("requires a spec for create and a ref for every other operation", () => {
    expect(validateRelatedSessionRequest(request({ spec: undefined })).ok).toBe(false);
    for (const operation of ["open", "focus", "inspect", "interrupt", "close"]) {
      expect(
        validateRelatedSessionRequest(request({ operation, spec: undefined, sessionRef: "tab-1" }))
          .ok,
      ).toBe(true);
      expect(validateRelatedSessionRequest(request({ operation, spec: undefined })).ok).toBe(false);
    }
    expect(validateRelatedSessionRequest(request({ operation: "launch" })).ok).toBe(false);
  });
});

describe("related-session result and capabilities", () => {
  it("rejects a result without an explicit ok discriminant", () => {
    expect(validateRelatedSessionResult({}).ok).toBe(false);
    expect(validateRelatedSessionResult({ ok: true, sessionRef: "tab-1" }).ok).toBe(true);
    expect(validateRelatedSessionResult({ ok: false, code: "nope", reason: "x" }).ok).toBe(false);
    expect(
      validateRelatedSessionResult({ ok: false, code: "unsupported", reason: "no host" }).ok,
    ).toBe(true);
  });

  it("normalizes capabilities and fails closed without source binding", () => {
    const base = {
      version: RELATED_SESSION_VERSION,
      create: true,
      open: true,
      focus: true,
      inspect: true,
      interrupt: true,
      close: true,
      separateWindow: true,
      bootstrapBeforeStart: true,
      sourceBound: true,
      label: "Pi Desktop",
    };
    const parsed = validateRelatedSessionCapabilities(base);
    expect(parsed).toEqual(expect.objectContaining({ label: "Pi Desktop", sourceBound: true }));
    expect(validateRelatedSessionCapabilities({ ...base, label: "" })).toBeNull();

    expect(relatedSessionSupport(parsed)).toBeUndefined();
    expect(relatedSessionSupport({ ...parsed!, sourceBound: false })).toMatch(/verify/);
    expect(relatedSessionSupport({ ...parsed!, create: false })).toMatch(/cannot open/);
    expect(relatedSessionSupport({ ...parsed!, version: 0 })).toMatch(/older/);
    expect(relatedSessionSupport(null)).toMatch(/not announced/);
  });
});
