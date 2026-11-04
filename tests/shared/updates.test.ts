import { describe, expect, it } from "vitest";
import {
  autoCheckAllowed,
  classifyUpdateProblem,
  compareVersions,
  describeUpdate,
  describeUpdateProblem,
  initialUpdateState,
  isVersionNewer,
  reduceUpdateState,
  resolveUpdateSupport,
  sanitizeUpdateState,
  updateAction,
  MAX_RELEASE_NOTES_LENGTH,
  MAX_UPDATE_ERROR_LENGTH,
  type UpdateState,
} from "../../src/shared/updates";

const T0 = 1_000;

function supported(currentVersion = ""): UpdateState {
  return initialUpdateState(true, { currentVersion });
}

describe("update state machine (plan step 26)", () => {
  it("starts idle when supported and unsupported otherwise", () => {
    expect(initialUpdateState(true)).toMatchObject({ phase: "idle", supported: true });
    expect(initialUpdateState(false)).toMatchObject({
      phase: "unsupported",
      supported: false,
      unsupportedReason: "updater-unavailable",
    });
    expect(initialUpdateState(false, { unsupportedReason: "development" }).unsupportedReason).toBe(
      "development",
    );
  });

  it("walks checking → available → downloading → downloaded", () => {
    let state = reduceUpdateState(supported(), { type: "checking" }, T0);
    expect(state).toMatchObject({ phase: "checking", checkedAt: T0 });

    state = reduceUpdateState(
      state,
      { type: "available", version: "0.2.0", releaseNotes: "Fixes." },
      T0 + 1,
    );
    expect(state).toMatchObject({ phase: "available", version: "0.2.0", releaseNotes: "Fixes." });

    state = reduceUpdateState(state, { type: "progress", percent: 12.6, bytesPerSecond: 900 }, T0);
    expect(state).toMatchObject({ phase: "downloading", percent: 13, bytesPerSecond: 900 });

    state = reduceUpdateState(state, { type: "downloaded", version: "0.2.0" }, T0 + 2);
    expect(state).toMatchObject({ phase: "downloaded", version: "0.2.0", percent: 100 });
  });

  it("keeps the offered version when a progress event omits one", () => {
    let state = reduceUpdateState(supported(), { type: "available", version: "1.2.3" }, T0);
    state = reduceUpdateState(state, { type: "progress", percent: 5 }, T0);
    state = reduceUpdateState(state, { type: "downloaded" }, T0);
    expect(state.version).toBe("1.2.3");
  });

  it("maps an up-to-date answer and clears any previous offer", () => {
    let state = reduceUpdateState(supported(), { type: "available", version: "9.9.9" }, T0);
    state = reduceUpdateState(state, { type: "not-available", version: "0.1.0" }, T0 + 1);
    expect(state).toMatchObject({
      phase: "up-to-date",
      version: null,
      releaseNotes: null,
      error: null,
      problemKind: null,
    });
  });

  it("clamps progress and tolerates junk numbers", () => {
    expect(reduceUpdateState(supported(), { type: "progress", percent: 150 }, T0).percent).toBe(
      100,
    );
    expect(reduceUpdateState(supported(), { type: "progress", percent: -5 }, T0).percent).toBe(0);
    const state = reduceUpdateState(
      supported(),
      { type: "progress", percent: Number.NaN, bytesPerSecond: Number.POSITIVE_INFINITY },
      T0,
    );
    expect(state.percent).toBeNull();
    expect(state.bytesPerSecond).toBeNull();
  });

  it("bounds release notes and error text", () => {
    const notes = reduceUpdateState(
      supported(),
      { type: "available", version: "1.0.0", releaseNotes: "x".repeat(10_000) },
      T0,
    );
    expect(notes.releaseNotes?.length).toBe(MAX_RELEASE_NOTES_LENGTH + 1);

    const error = reduceUpdateState(
      supported(),
      { type: "error", message: "y".repeat(10_000) },
      T0,
    );
    expect(error.error?.length).toBe(MAX_UPDATE_ERROR_LENGTH + 1);
    expect(error.phase).toBe("error");
  });

  it("ignores every event in an unsupported build", () => {
    const unsupported = initialUpdateState(false);
    expect(reduceUpdateState(unsupported, { type: "available", version: "1.0.0" }, T0)).toBe(
      unsupported,
    );
    expect(reduceUpdateState(unsupported, { type: "error", message: "failed" }, T0)).toBe(
      unsupported,
    );
  });

  it("picks one action per phase", () => {
    expect(updateAction(initialUpdateState(false))).toBeNull();
    expect(updateAction({ ...supported(), phase: "available" })).toBe("download");
    expect(updateAction({ ...supported(), phase: "downloaded" })).toBe("install");
    expect(updateAction({ ...supported(), phase: "idle" })).toBe("check");
    expect(updateAction({ ...supported(), phase: "up-to-date" })).toBe("check");
    expect(updateAction({ ...supported(), phase: "no-feed" })).toBe("check");
    expect(updateAction({ ...supported(), phase: "error" })).toBe("check");
    expect(updateAction({ ...supported(), phase: "downloading" })).toBeNull();
  });

  it("describes every phase for the UI", () => {
    for (const phase of [
      "unsupported",
      "idle",
      "checking",
      "available",
      "downloading",
      "downloaded",
      "up-to-date",
      "no-feed",
      "error",
    ] as const) {
      expect(describeUpdate({ ...supported(), phase, version: "1.0.0" }).length).toBeGreaterThan(0);
    }
    expect(describeUpdate({ ...supported(), phase: "downloading", percent: 42 })).toContain("42%");
    expect(describeUpdate({ ...supported(), phase: "up-to-date" })).toBe(
      "Pi Desktop is up to date.",
    );
    expect(describeUpdate({ ...supported(), phase: "no-feed" })).toBe(
      "No published release was found for this build.",
    );
    expect(
      describeUpdate({
        ...supported(),
        phase: "error",
        problemKind: "network",
      }),
    ).toContain("Couldn't reach the update server");
    expect(
      describeUpdate({
        ...initialUpdateState(false, { unsupportedReason: "safe-mode" }),
      }),
    ).toContain("safe mode");
    expect(
      describeUpdate({
        ...initialUpdateState(false, { unsupportedReason: "offline" }),
      }),
    ).toContain("PI_OFFLINE");
  });
});

describe("version comparison", () => {
  it("compares stable, prerelease and build-metadata versions", () => {
    expect(compareVersions("0.4.0", "0.3.9")).toBe(1);
    expect(compareVersions("0.3.0", "0.4.0")).toBe(-1);
    expect(compareVersions("v0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("0.3.0+build.7", "0.3.0")).toBe(0);
    expect(compareVersions("0.3.0-beta.2", "0.3.0-beta.10")).toBe(-1);
    expect(compareVersions("0.3.0", "0.3.0-beta.10")).toBe(1);
    expect(compareVersions("not-a-version", "0.3.0")).toBe(0);
  });

  it("only treats a valid, strictly newer version as an update", () => {
    expect(isVersionNewer("v0.4.0", "0.3.0")).toBe(true);
    expect(isVersionNewer("0.3.0", "0.3.0")).toBe(false);
    expect(isVersionNewer("0.2.9", "0.3.0")).toBe(false);
    expect(isVersionNewer("0.4.0", "not-a-version")).toBe(false);
    expect(isVersionNewer(null, "0.3.0")).toBe(false);
  });

  it("rejects an offered version that is not newer than the running app", () => {
    const current = supported("0.3.0");
    const same = reduceUpdateState(current, { type: "available", version: "0.3.0" }, T0);
    expect(same).toMatchObject({ phase: "up-to-date", version: null });

    const older = reduceUpdateState(current, { type: "available", version: "0.2.0" }, T0);
    expect(older.phase).toBe("up-to-date");

    const newer = reduceUpdateState(current, { type: "available", version: "0.4.0" }, T0);
    expect(newer).toMatchObject({ phase: "available", version: "0.4.0" });
  });
});

describe("update problem classification", () => {
  it("separates a missing check feed from a failed download", () => {
    expect(classifyUpdateProblem("ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "check")).toBe("no-feed");
    expect(classifyUpdateProblem("HttpError: 404 Not Found", "check")).toBe("no-feed");
    expect(classifyUpdateProblem("HttpError: 404 Not Found", "download")).toBe("download");
    expect(classifyUpdateProblem("getaddrinfo ENOTFOUND github.com", "check")).toBe("network");
    expect(classifyUpdateProblem("ERR_UPDATER_INVALID_VERSION", "check")).toBe("invalid-version");
    expect(classifyUpdateProblem("installer missing", "install")).toBe("install");
    expect(classifyUpdateProblem("something odd", "check")).toBe("unknown");
  });

  it("keeps automatic-check failures quiet and manual ones visible", () => {
    const idle = supported("0.3.0");
    const automatic = reduceUpdateState(
      reduceUpdateState(idle, { type: "checking", automatic: true }, T0),
      { type: "error", message: "getaddrinfo ENOTFOUND github.com", context: "check" },
      T0 + 1,
    );
    expect(automatic).toMatchObject({
      phase: "idle",
      problemKind: "network",
      problemAutomatic: true,
      lastCheckWasAutomatic: true,
    });

    const manual = reduceUpdateState(
      reduceUpdateState(idle, { type: "checking", automatic: false }, T0),
      { type: "error", message: "getaddrinfo ENOTFOUND github.com", context: "check" },
      T0 + 1,
    );
    expect(manual).toMatchObject({
      phase: "error",
      problemKind: "network",
      problemAutomatic: false,
    });
  });

  it("maps a missing check feed to the benign no-feed phase", () => {
    const manual = reduceUpdateState(
      supported("0.3.0"),
      { type: "error", message: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", context: "check" },
      T0,
    );
    expect(manual).toMatchObject({ phase: "no-feed", problemKind: "no-feed" });
  });

  it("does not discard an offer when a later check fails", () => {
    const offered = reduceUpdateState(
      supported("0.3.0"),
      { type: "available", version: "0.4.0" },
      T0,
    );
    const failed = reduceUpdateState(
      offered,
      { type: "error", message: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", context: "check" },
      T0 + 1,
    );
    expect(failed).toMatchObject({ phase: "available", version: "0.4.0", problemKind: "no-feed" });
  });

  it("keeps a downloaded build when a later check fails", () => {
    let state = reduceUpdateState(supported("0.3.0"), { type: "available", version: "0.4.0" }, T0);
    state = reduceUpdateState(state, { type: "downloaded", version: "0.4.0" }, T0 + 1);
    state = reduceUpdateState(state, { type: "checking", automatic: false }, T0 + 2);
    state = reduceUpdateState(
      state,
      { type: "error", message: "getaddrinfo ENOTFOUND github.com", context: "check" },
      T0 + 3,
    );
    expect(state).toMatchObject({ phase: "downloaded", version: "0.4.0", percent: 100 });
  });

  it("keeps the offer on a download failure and the build on an install failure", () => {
    let state = reduceUpdateState(supported("0.3.0"), { type: "available", version: "0.4.0" }, T0);
    state = reduceUpdateState(
      state,
      { type: "error", message: "HttpError: 404 Not Found", context: "download" },
      T0 + 1,
    );
    expect(state).toMatchObject({
      phase: "available",
      version: "0.4.0",
      problemKind: "download",
      percent: null,
    });

    state = reduceUpdateState(state, { type: "downloaded", version: "0.4.0" }, T0 + 2);
    state = reduceUpdateState(
      state,
      { type: "error", message: "installer missing", context: "install" },
      T0 + 3,
    );
    expect(state).toMatchObject({
      phase: "downloaded",
      version: "0.4.0",
      problemKind: "install",
    });
  });
});

describe("update problem descriptions", () => {
  it("has a friendly sentence for every kind", () => {
    for (const kind of [
      "no-feed",
      "network",
      "invalid-feed",
      "invalid-version",
      "download",
      "install",
      "unknown",
    ] as const) {
      expect(describeUpdateProblem(kind).length).toBeGreaterThan(0);
    }
  });
});

describe("update support policy", () => {
  it("orders the support gate dev → safe mode → offline → port", () => {
    expect(
      resolveUpdateSupport({
        isPackaged: false,
        safeMode: true,
        offline: true,
        portAvailable: true,
      }),
    ).toEqual({ supported: false, reason: "development" });
    expect(
      resolveUpdateSupport({
        isPackaged: true,
        safeMode: true,
        offline: true,
        portAvailable: true,
      }),
    ).toEqual({ supported: false, reason: "safe-mode" });
    expect(
      resolveUpdateSupport({
        isPackaged: true,
        safeMode: false,
        offline: true,
        portAvailable: true,
      }),
    ).toEqual({ supported: false, reason: "offline" });
    expect(
      resolveUpdateSupport({
        isPackaged: true,
        safeMode: false,
        offline: false,
        portAvailable: false,
      }),
    ).toEqual({ supported: false, reason: "updater-unavailable" });
    expect(
      resolveUpdateSupport({
        isPackaged: true,
        safeMode: false,
        offline: false,
        portAvailable: true,
      }),
    ).toEqual({ supported: true, reason: null });
  });

  it("never auto-checks a local/dev build or an unsupported launch", () => {
    const supported = resolveUpdateSupport({
      isPackaged: true,
      safeMode: false,
      offline: false,
      portAvailable: true,
    });
    expect(autoCheckAllowed({ support: supported, autoCheck: true, buildChannel: "release" })).toBe(
      true,
    );
    expect(autoCheckAllowed({ support: supported, autoCheck: true, buildChannel: "unknown" })).toBe(
      true,
    );
    expect(autoCheckAllowed({ support: supported, autoCheck: true, buildChannel: "local" })).toBe(
      false,
    );
    expect(autoCheckAllowed({ support: supported, autoCheck: true, buildChannel: "dev" })).toBe(
      false,
    );
    expect(
      autoCheckAllowed({ support: supported, autoCheck: false, buildChannel: "release" }),
    ).toBe(false);
    expect(
      autoCheckAllowed({
        support: { supported: false, reason: "safe-mode" },
        autoCheck: true,
        buildChannel: "release",
      }),
    ).toBe(false);
  });
});

describe("sanitizeUpdateState", () => {
  it("returns an unsupported state for junk", () => {
    expect(sanitizeUpdateState(null)).toEqual(initialUpdateState(false));
    expect(sanitizeUpdateState("available")).toEqual(initialUpdateState(false));
  });

  it("coerces a pushed payload field by field", () => {
    const state = sanitizeUpdateState({
      phase: "downloading",
      supported: true,
      unsupportedReason: "development",
      currentVersion: " 0.3.0 ",
      version: " 1.0.0 ",
      percent: 55.4,
      bytesPerSecond: 1024,
      releaseNotes: "notes",
      error: null,
      problemKind: "download",
      problemAutomatic: true,
      checkedAt: 5,
      lastCheckWasAutomatic: true,
      extra: "ignored",
    });
    expect(state).toEqual({
      phase: "downloading",
      supported: true,
      unsupportedReason: null,
      currentVersion: "0.3.0",
      version: "1.0.0",
      percent: 55,
      bytesPerSecond: 1024,
      releaseNotes: "notes",
      error: null,
      problemKind: "download",
      problemAutomatic: true,
      checkedAt: 5,
      lastCheckWasAutomatic: true,
    });
  });

  it("never lets an unsupported payload keep an offer or a problem", () => {
    const state = sanitizeUpdateState({
      supported: false,
      phase: "available",
      version: "9.9.9",
      error: "oops",
      problemKind: "network",
      unsupportedReason: "safe-mode",
    });
    expect(state).toMatchObject({
      phase: "unsupported",
      supported: false,
      unsupportedReason: "safe-mode",
      version: null,
      error: null,
      problemKind: null,
    });
  });

  it("falls back to idle for an unknown phase in a supported build", () => {
    expect(sanitizeUpdateState({ supported: true, phase: "teleporting" }).phase).toBe("idle");
    expect(sanitizeUpdateState({ supported: false, phase: "teleporting" }).phase).toBe(
      "unsupported",
    );
    expect(sanitizeUpdateState({ supported: true, phase: "unsupported" }).phase).toBe("idle");
    expect(
      sanitizeUpdateState({ supported: true, problemKind: "teleporting" }).problemKind,
    ).toBeNull();
  });
});
