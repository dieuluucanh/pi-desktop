import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readBuildInfo } from "../../src/main/build-info";
import { BUILD_INFO_FILE } from "../../src/shared/build-info";

const RESOURCES = join("C:", "app", "resources");

describe("readBuildInfo", () => {
  it("reports a development run without reading a file", () => {
    const readTextFile = vi.fn(() => null);
    expect(readBuildInfo({ isPackaged: false, resourcesDir: RESOURCES, readTextFile })).toEqual({
      channel: "dev",
      version: null,
      commit: null,
      builtAt: null,
      macSigning: "none",
    });
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("reads the packaged provenance file", () => {
    const readTextFile = vi.fn(() =>
      JSON.stringify({
        channel: "local",
        version: "0.3.0",
        commit: "abc123",
        builtAt: "2026-11-01T00:00:00.000Z",
        macSigning: "adhoc",
      }),
    );
    expect(readBuildInfo({ isPackaged: true, resourcesDir: RESOURCES, readTextFile })).toEqual({
      channel: "local",
      version: "0.3.0",
      commit: "abc123",
      builtAt: "2026-11-01T00:00:00.000Z",
      macSigning: "adhoc",
    });
    expect(readTextFile).toHaveBeenCalledWith(join(RESOURCES, BUILD_INFO_FILE));
  });

  it("degrades to unknown when the file is missing, unreadable or malformed", () => {
    const expected = {
      channel: "unknown",
      version: null,
      commit: null,
      builtAt: null,
      macSigning: "none",
    };
    expect(
      readBuildInfo({ isPackaged: true, resourcesDir: RESOURCES, readTextFile: () => null }),
    ).toEqual(expected);
    expect(
      readBuildInfo({
        isPackaged: true,
        resourcesDir: RESOURCES,
        readTextFile: () => {
          throw new Error("EACCES");
        },
      }),
    ).toEqual(expected);
    expect(
      readBuildInfo({
        isPackaged: true,
        resourcesDir: RESOURCES,
        readTextFile: () => "{not json",
      }),
    ).toEqual(expected);
  });
});
