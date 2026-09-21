import { describe, expect, it } from "vitest";
import {
  describeUpdate,
  initialUpdateState,
  reduceUpdateState,
  sanitizeUpdateState,
  updateAction,
  MAX_RELEASE_NOTES_LENGTH,
  MAX_UPDATE_ERROR_LENGTH,
  type UpdateState,
} from "../../src/shared/updates";

const T0 = 1_000;

function supported(): UpdateState {
  return initialUpdateState(true);
}

describe("update state machine (plan step 26)", () => {
  it("starts idle when supported and unsupported otherwise", () => {
    expect(initialUpdateState(true)).toMatchObject({ phase: "idle", supported: true });
    expect(initialUpdateState(false)).toMatchObject({ phase: "unsupported", supported: false });
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

  it("ignores feed chatter in an unsupported build but still records wiring errors", () => {
    const unsupported = initialUpdateState(false);
    expect(reduceUpdateState(unsupported, { type: "available", version: "1.0.0" }, T0)).toBe(
      unsupported,
    );
    expect(reduceUpdateState(unsupported, { type: "error", message: "failed" }, T0).phase).toBe(
      "error",
    );
  });

  it("picks one action per phase", () => {
    expect(updateAction(initialUpdateState(false))).toBeNull();
    expect(updateAction({ ...supported(), phase: "available" })).toBe("download");
    expect(updateAction({ ...supported(), phase: "downloaded" })).toBe("install");
    expect(updateAction({ ...supported(), phase: "idle" })).toBe("check");
    expect(updateAction({ ...supported(), phase: "up-to-date" })).toBe("check");
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
      "error",
    ] as const) {
      expect(describeUpdate({ ...supported(), phase, version: "1.0.0" }).length).toBeGreaterThan(0);
    }
    expect(describeUpdate({ ...supported(), phase: "downloading", percent: 42 })).toContain("42%");
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
      version: " 1.0.0 ",
      percent: 55.4,
      bytesPerSecond: 1024,
      releaseNotes: "notes",
      error: null,
      checkedAt: 5,
      extra: "ignored",
    });
    expect(state).toEqual({
      phase: "downloading",
      supported: true,
      version: "1.0.0",
      percent: 55,
      bytesPerSecond: 1024,
      releaseNotes: "notes",
      error: null,
      checkedAt: 5,
    });
  });

  it("falls back to idle for an unknown phase in a supported build", () => {
    expect(sanitizeUpdateState({ supported: true, phase: "teleporting" }).phase).toBe("idle");
    expect(sanitizeUpdateState({ supported: false, phase: "teleporting" }).phase).toBe(
      "unsupported",
    );
  });
});
