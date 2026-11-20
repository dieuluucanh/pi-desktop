import { describe, expect, it } from "vitest";
import {
  BUILD_CHANNELS,
  BUILD_INFO_FILE,
  devBuildInfo,
  parseBuildInfo,
  unknownBuildInfo,
} from "../../src/shared/build-info";

describe("build info", () => {
  it("names the file electron-builder writes and the app reads", () => {
    expect(BUILD_INFO_FILE).toBe("build-info.json");
    expect(BUILD_CHANNELS).toEqual(["dev", "local", "release", "unknown"]);
  });

  it("has honest dev and unknown fallbacks", () => {
    expect(devBuildInfo()).toEqual({
      channel: "dev",
      version: null,
      commit: null,
      builtAt: null,
      macSigning: "none",
      piVersion: null,
    });
    expect(unknownBuildInfo()).toEqual({
      channel: "unknown",
      version: null,
      commit: null,
      builtAt: null,
      macSigning: "none",
      piVersion: null,
    });
  });

  it("coerces a packaged document field by field", () => {
    expect(
      parseBuildInfo({
        channel: "local",
        version: " 0.3.0 ",
        commit: " 1a2b3c4d5e6f ",
        builtAt: "2026-11-01T12:00:00.000Z",
        macSigning: "adhoc",
        piVersion: " 1.5.0 ",
        extra: "ignored",
      }),
    ).toEqual({
      channel: "local",
      version: "0.3.0",
      commit: "1a2b3c4d5e6f",
      builtAt: "2026-11-01T12:00:00.000Z",
      macSigning: "adhoc",
      piVersion: "1.5.0",
    });
  });

  it("reads a bundled agent version and rejects a non-string", () => {
    expect(parseBuildInfo({ channel: "release", piVersion: "1.5.0" }).piVersion).toBe("1.5.0");
    expect(parseBuildInfo({ channel: "release", piVersion: 7 }).piVersion).toBeNull();
    expect(parseBuildInfo({ channel: "release" }).piVersion).toBeNull();
  });

  it("only trusts a known macOS signing value", () => {
    // A package built before this field existed, or a hand-edited file, can
    // never claim a signature Squirrel.Mac would accept.
    expect(parseBuildInfo({ channel: "release" }).macSigning).toBe("none");
    expect(parseBuildInfo({ channel: "release", macSigning: "self-signed" }).macSigning).toBe(
      "none",
    );
    expect(parseBuildInfo({ channel: "release", macSigning: 7 }).macSigning).toBe("none");
    expect(parseBuildInfo({ channel: "release", macSigning: "developer-id" }).macSigning).toBe(
      "developer-id",
    );
  });

  it("falls back to unknown for junk, unknown channels and oversized fields", () => {
    expect(parseBuildInfo(null)).toEqual(unknownBuildInfo());
    expect(parseBuildInfo("release")).toEqual(unknownBuildInfo());
    expect(parseBuildInfo({ channel: "nightly" }).channel).toBe("unknown");
    expect(parseBuildInfo({ channel: "release", version: 7 }).version).toBeNull();
    expect(parseBuildInfo({ channel: "release", commit: "" }).commit).toBeNull();
    expect(parseBuildInfo({ channel: "release", version: "x".repeat(500) }).version?.length).toBe(
      201,
    );
  });
});
