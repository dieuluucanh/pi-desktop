import { describe, expect, it } from "vitest";
import {
  appendIncident,
  classifyFailure,
  createIncident,
  DEFAULT_INCIDENT_LIMIT,
  DIAGNOSTIC_ENV_KEYS,
  incidentFix,
  incidentHeadline,
  incidentSeverity,
  isOfflineError,
  isRecoverable,
  parseReportedIncident,
} from "../../src/shared/diagnostics";

/**
 * The reliability vocabulary (plan step 22). These tests pin the classification
 * order (disk problems beat connectivity), the recovery promise (only host
 * failures are "restart fixes it"), the bounded incident list and the fact that
 * the bundled env allowlist never sweeps the whole environment.
 */

describe("classifyFailure", () => {
  it("recognises the host failure families", () => {
    expect(classifyFailure("host exited unexpectedly (code 1)")).toBe("host_crash");
    expect(classifyFailure('host request "prompt" timed out after 30000 ms')).toBe("host_timeout");
    expect(classifyFailure("host for tab-1 is not running")).toBe("host_spawn");
    expect(classifyFailure("host for tab-1 crashed 3 times; giving up")).toBe("host_crash");
  });

  it("recognises the environment families", () => {
    expect(classifyFailure("getaddrinfo ENOTFOUND registry.npmjs.org")).toBe("offline");
    expect(classifyFailure("EACCES: permission denied, open auth.json")).toBe("permission");
    expect(classifyFailure("EROFS: read-only file system, open settings.json")).toBe("read_only");
    expect(classifyFailure("ENOSPC: no space left on device")).toBe("disk_full");
  });

  it("treats a disk problem as the cause even when the message also mentions a crash", () => {
    // The read-only profile is what the user must fix; the crash is a symptom.
    expect(classifyFailure("host crashed: EROFS read-only file system")).toBe("read_only");
    expect(classifyFailure("ENOSPC while the host was running")).toBe("disk_full");
  });

  it("falls back to unknown without inventing a cause", () => {
    expect(classifyFailure("the flux capacitor overheated")).toBe("unknown");
    expect(classifyFailure("")).toBe("unknown");
  });
});

describe("isOfflineError", () => {
  it("only reports connectivity failures", () => {
    expect(isOfflineError("fetch failed")).toBe(true);
    expect(isOfflineError("ECONNRESET")).toBe(true);
    expect(isOfflineError("ENOENT: no such file")).toBe(false);
  });
});

describe("severity, recovery and fixes", () => {
  it("marks host failures as restartable and environment failures as not", () => {
    expect(isRecoverable("host_crash")).toBe(true);
    expect(isRecoverable("host_timeout")).toBe(true);
    expect(isRecoverable("host_failed")).toBe(true);
    expect(isRecoverable("offline")).toBe(false);
    expect(isRecoverable("read_only")).toBe(false);
    expect(isRecoverable("permission")).toBe(false);
  });

  it("gives every actionable family a fix and leaves the rest alone", () => {
    expect(incidentFix("host_crash")).toMatch(/Restart the session/);
    expect(incidentFix("offline")).toMatch(/offline/);
    expect(incidentFix("read_only")).toMatch(/read-only/);
    expect(incidentFix("permission")).toMatch(/permissions/);
    expect(incidentFix("disk_full")).toMatch(/disk is full/i);
    expect(incidentFix("unknown")).toBeNull();
  });

  it("assigns error severity to crashes and warning to connectivity", () => {
    expect(incidentSeverity("host_crash")).toBe("error");
    expect(incidentSeverity("offline")).toBe("warning");
    expect(incidentSeverity("bad_request")).toBe("warning");
    expect(incidentHeadline(createIncident({ kind: "host_crash", message: "x" }))).toMatch(
      /crashed/,
    );
  });
});

describe("createIncident", () => {
  it("derives severity, recoverability, fix and timestamp", () => {
    const incident = createIncident({
      kind: "host_crash",
      message: "boom",
      detail: "stack",
      tabId: "tab-1",
      at: 42,
      id: "inc-1",
    });
    expect(incident).toMatchObject({
      id: "inc-1",
      kind: "host_crash",
      severity: "error",
      message: "boom",
      detail: "stack",
      tabId: "tab-1",
      at: 42,
      recoverable: true,
    });
    expect(incident.fix).toBeTruthy();
  });

  it("omits absent optional fields instead of writing undefined", () => {
    const incident = createIncident({ kind: "unknown", message: "mystery" });
    expect(incident).not.toHaveProperty("detail");
    expect(incident).not.toHaveProperty("tabId");
    expect(incident).not.toHaveProperty("fix");
  });
});

describe("appendIncident", () => {
  it("keeps the list newest-first and bounded", () => {
    let list = [] as ReturnType<typeof createIncident>[];
    for (let index = 0; index < DEFAULT_INCIDENT_LIMIT + 5; index += 1) {
      list = appendIncident(list, createIncident({ kind: "unknown", message: `m${index}` }));
    }
    expect(list).toHaveLength(DEFAULT_INCIDENT_LIMIT);
    expect(list[0]?.message).toBe(`m${DEFAULT_INCIDENT_LIMIT + 4}`);
  });

  it("collapses a repeated identical incident (a crash loop is one line)", () => {
    const first = createIncident({ kind: "host_crash", message: "same", id: "a" });
    const second = createIncident({ kind: "host_crash", message: "same", id: "b" });
    const list = appendIncident(appendIncident([], first), second);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("a");
  });

  it("does not collapse a different kind with the same message", () => {
    const a = createIncident({ kind: "host_crash", message: "same" });
    const b = createIncident({ kind: "offline", message: "same" });
    expect(appendIncident(appendIncident([], a), b)).toHaveLength(2);
  });
});

describe("parseReportedIncident", () => {
  it("accepts a renderer report and classifies when the kind is absent", () => {
    const parsed = parseReportedIncident({ message: "ECONNREFUSED 127.0.0.1:443" });
    expect(parsed?.kind).toBe("offline");
    expect(parsed?.severity).toBe("warning");
  });

  it("honours a known kind and truncates oversized fields", () => {
    const parsed = parseReportedIncident({
      kind: "extension_error",
      message: "x".repeat(5_000),
      detail: "y".repeat(9_000),
    });
    expect(parsed?.kind).toBe("extension_error");
    expect(parsed?.message).toHaveLength(4_000);
    expect(parsed?.detail).toHaveLength(8_000);
  });

  it("refuses an empty or non-string message", () => {
    expect(parseReportedIncident({})).toBeNull();
    expect(parseReportedIncident({ message: "" })).toBeNull();
    expect(parseReportedIncident({ message: 42 })).toBeNull();
    expect(parseReportedIncident(null)).toBeNull();
  });
});

describe("DIAGNOSTIC_ENV_KEYS", () => {
  it("is an allowlist, not the whole environment", () => {
    expect(DIAGNOSTIC_ENV_KEYS).toContain("PI_CODING_AGENT_DIR");
    expect(DIAGNOSTIC_ENV_KEYS).toContain("PI_OFFLINE");
    expect(DIAGNOSTIC_ENV_KEYS).not.toContain("PATH");
    expect(DIAGNOSTIC_ENV_KEYS).not.toContain("HOME");
  });
});
