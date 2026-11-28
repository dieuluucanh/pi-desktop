import { describe, expect, it } from "vitest";

import {
  PI_AGENT_FAMILY,
  PI_AGENT_PACKAGE,
  PiAgentError,
  TYPEBOX_PACKAGE,
  classifyPiStatus,
  enginesFloor,
  isExactVersion,
  majorOf,
  readPiPins,
  renderVersionsDoc,
  resolveTargetPins,
  rewritePiPins,
  satisfiesFloor,
} from "../../scripts/pi-agent-package.mjs";
import { npmInvocation } from "../../scripts/pi-agent.mjs";
import type { TargetPins } from "../../scripts/pi-agent-package.mjs";

/**
 * The Pi agent pin helpers (2026-11-15 update-channels plan, step 9).
 *
 * The point of these helpers is that a bump is mechanical *and* refuses to
 * guess: the family and typebox move together, and the versions document is
 * part of the pin, not prose that can drift.
 */

const PINS = {
  family: {
    "@earendil-works/pi-coding-agent": "1.6.0",
    "@earendil-works/pi-agent-core": "1.6.0",
    "@earendil-works/pi-ai": "1.6.0",
    "@earendil-works/pi-tui": "1.6.0",
  },
  typebox: "1.3.30",
};

const SDK_DEPS = {
  "@earendil-works/pi-agent-core": "1.6.0",
  "@earendil-works/pi-ai": "1.6.0",
  "@earendil-works/pi-tui": "1.6.0",
  typebox: "1.3.30",
};

const MANIFEST = {
  name: "pi-desktop",
  dependencies: {
    "@earendil-works/pi-coding-agent": "1.5.0",
    "@earendil-works/pi-agent-core": "1.5.0",
    "@earendil-works/pi-ai": "1.5.0",
    "@earendil-works/pi-tui": "1.5.0",
    react: "19.3.0",
    typebox: "1.3.27",
  },
};

const VERSIONS_DOC = [
  "| Component | Pin | Why |",
  "| --------- | --- | --- |",
  "| `@earendil-works/pi-coding-agent`                  | `1.5.0` (exact)      | the SDK |",
  "| `@earendil-works/pi-agent-core`, `pi-ai`, `pi-tui` | `1.5.0` (exact)      | family  |",
  "| `typebox`                                          | `1.3.27` (exact)     | types   |",
  "| `electron`                                         | `44.4.3`             | chrome  |",
].join("\n");

describe("readPiPins", () => {
  it("reads the family and typebox pins from package.json", () => {
    expect(readPiPins(MANIFEST)).toEqual({
      family: {
        "@earendil-works/pi-coding-agent": "1.5.0",
        "@earendil-works/pi-agent-core": "1.5.0",
        "@earendil-works/pi-ai": "1.5.0",
        "@earendil-works/pi-tui": "1.5.0",
      },
      typebox: "1.3.27",
    });
  });

  it("reports a missing pin as null instead of throwing", () => {
    const pins = readPiPins({ dependencies: { [PI_AGENT_PACKAGE]: "1.5.0" } });
    expect(pins.family[PI_AGENT_PACKAGE]).toBe("1.5.0");
    expect(pins.family["@earendil-works/pi-ai"]).toBeNull();
    expect(pins.typebox).toBeNull();
    expect(readPiPins(null).family[PI_AGENT_PACKAGE]).toBeNull();
  });
});

describe("npm invocation", () => {
  it("goes through cmd.exe on Windows", () => {
    expect(npmInvocation("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({
      cmd: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm"],
    });
  });

  it("uses npm directly on POSIX", () => {
    expect(npmInvocation("linux", {})).toEqual({ cmd: "npm", args: [] });
  });
});

describe("version shapes", () => {
  it("accepts only exact versions as pins", () => {
    expect(isExactVersion("1.5.0")).toBe(true);
    expect(isExactVersion("v1.5.0")).toBe(true);
    expect(isExactVersion("1.5.0-beta.1")).toBe(true);
    expect(isExactVersion("^1.5.0")).toBe(false);
    expect(isExactVersion("latest")).toBe(false);
    expect(isExactVersion(undefined)).toBe(false);
  });

  it("reports the major of a parseable version", () => {
    expect(majorOf("1.5.0")).toBe(1);
    expect(majorOf("v2.0.0-beta.1")).toBe(2);
    expect(majorOf("^1.5.0")).toBeNull();
  });
});

describe("classifyPiStatus", () => {
  it("separates a safe patch/minor bump from a major one", () => {
    expect(classifyPiStatus("1.5.0", "1.5.0")).toBe("in-sync");
    expect(classifyPiStatus("1.5.0", "1.5.1")).toBe("behind");
    expect(classifyPiStatus("1.5.0", "1.6.0")).toBe("behind");
    expect(classifyPiStatus("1.5.0", "2.0.0")).toBe("major-behind");
  });

  it("never proposes a downgrade", () => {
    expect(classifyPiStatus("1.6.0", "1.5.0")).toBe("local-ahead");
    expect(classifyPiStatus("2.0.0", "1.9.9")).toBe("local-ahead");
  });

  it("treats a stable release as newer than its pre-release", () => {
    expect(classifyPiStatus("1.5.0-beta.1", "1.5.0")).toBe("behind");
    expect(classifyPiStatus("1.5.0", "1.5.0-beta.1")).toBe("in-sync");
  });

  it("reports an unparseable side as a registry error", () => {
    expect(classifyPiStatus("nope", "1.5.0")).toBe("registry-error");
    expect(classifyPiStatus("1.5.0", null)).toBe("registry-error");
  });
});

describe("resolveTargetPins", () => {
  it("takes the family and typebox from the SDK's own manifest", () => {
    expect(resolveTargetPins({ sdkVersion: "1.6.0", sdkDependencies: SDK_DEPS })).toEqual(PINS);
  });

  it("refuses a family that does not move together", () => {
    expect(() =>
      resolveTargetPins({
        sdkVersion: "1.6.0",
        sdkDependencies: { ...SDK_DEPS, "@earendil-works/pi-ai": "1.5.0" },
      }),
    ).toThrow(/must move together/);
    expect(() =>
      resolveTargetPins({
        sdkVersion: "1.6.0",
        sdkDependencies: { ...SDK_DEPS, "@earendil-works/pi-tui": undefined },
      }),
    ).toThrow(/does not pin @earendil-works\/pi-tui/);
  });

  it("refuses a typebox that is no longer exact", () => {
    expect(() =>
      resolveTargetPins({
        sdkVersion: "1.6.0",
        sdkDependencies: { ...SDK_DEPS, [TYPEBOX_PACKAGE]: "^1.3.30" },
      }),
    ).toThrow(/typebox/);
  });

  it("refuses a non-exact target and a missing dependency block", () => {
    expect(() => resolveTargetPins({ sdkVersion: "1.6", sdkDependencies: SDK_DEPS })).toThrow(
      /not exact/,
    );
    expect(() => resolveTargetPins({ sdkVersion: "1.6.0" })).toThrow(/dependencies/);
    expect(() => resolveTargetPins({ sdkVersion: "1.6.0", sdkDependencies: [] })).toThrow(
      /dependencies/,
    );
  });
});

describe("rewritePiPins", () => {
  it("moves all five pins and leaves every other dependency alone", () => {
    const { manifest, changed } = rewritePiPins(MANIFEST, PINS);

    expect(manifest.dependencies[PI_AGENT_PACKAGE]).toBe("1.6.0");
    expect(manifest.dependencies["@earendil-works/pi-tui"]).toBe("1.6.0");
    expect(manifest.dependencies[TYPEBOX_PACKAGE]).toBe("1.3.30");
    expect(manifest.dependencies.react).toBe("19.3.0");
    expect(changed).toHaveLength(5);
    expect(changed).toContainEqual({
      name: TYPEBOX_PACKAGE,
      from: "1.3.27",
      to: "1.3.30",
    });
  });

  it("does not mutate the input and preserves dependency order", () => {
    const before = structuredClone(MANIFEST);
    const { manifest } = rewritePiPins(MANIFEST, PINS);
    expect(MANIFEST).toEqual(before);
    expect(Object.keys(manifest.dependencies)).toEqual(Object.keys(MANIFEST.dependencies));
  });

  it("is idempotent", () => {
    const first = rewritePiPins(MANIFEST, PINS);
    const second = rewritePiPins(first.manifest, PINS);
    expect(second.changed).toEqual([]);
    expect(second.manifest).toEqual(first.manifest);
  });

  it("refuses an incomplete target", () => {
    expect(() =>
      rewritePiPins(MANIFEST, { family: { [PI_AGENT_PACKAGE]: "1.6.0" }, typebox: "1.3.30" }),
    ).toThrow(PiAgentError);
    expect(() => rewritePiPins({ name: "x" }, PINS)).toThrow(/dependencies/);
  });
});

describe("renderVersionsDoc", () => {
  it("rewrites the three pin rows and nothing else", () => {
    const text = renderVersionsDoc(VERSIONS_DOC, PINS);

    expect(text).toContain("| `@earendil-works/pi-coding-agent`");
    expect(text).toContain("`1.6.0` (exact)");
    expect(text).toContain("`1.3.30` (exact)");
    expect(text).toContain("| `electron`                                         | `44.4.3`");
    expect(text).not.toContain("`1.5.0` (exact)");
    expect(text).not.toContain("`1.3.27` (exact)");
    // The row count and the header are untouched.
    expect(text.split("\n")).toHaveLength(VERSIONS_DOC.split("\n").length);
  });

  it("is idempotent for the same pins", () => {
    const once = renderVersionsDoc(VERSIONS_DOC, PINS);
    expect(renderVersionsDoc(once, PINS)).toBe(once);
  });

  it("refuses a document that lost a row", () => {
    expect(() => renderVersionsDoc("| Component | Pin |\n| --- | --- |\n", PINS)).toThrow(
      /missing the `@earendil-works\/pi-coding-agent` row/,
    );
  });

  it("refuses an incomplete target", () => {
    expect(() =>
      renderVersionsDoc(VERSIONS_DOC, { family: {}, typebox: null } as unknown as TargetPins),
    ).toThrow(/incomplete/);
  });
});

describe("the bundled Node floor", () => {
  it("parses the comparators the SDK uses", () => {
    expect(enginesFloor(">=22.19.0")).toEqual({ operator: ">=", version: "22.19.0" });
    expect(enginesFloor(">22.19.0")).toEqual({ operator: ">", version: "22.19.0" });
    expect(enginesFloor("^24.1.0")).toEqual({ operator: "^", version: "24.1.0" });
    expect(enginesFloor("~24.1")).toEqual({ operator: "~", version: "24.1.0" });
    expect(enginesFloor(">=24")).toEqual({ operator: ">=", version: "24.0.0" });
    expect(enginesFloor("24.22.2")).toEqual({ operator: "=", version: "24.22.2" });
    expect(enginesFloor("garbage")).toBeNull();
    expect(enginesFloor(undefined)).toBeNull();
  });

  it("answers whether the bundled Node satisfies it, and null when it cannot", () => {
    expect(satisfiesFloor("24.22.2", ">=22.19.0")).toBe(true);
    expect(satisfiesFloor("22.0.0", ">=22.19.0")).toBe(false);
    expect(satisfiesFloor("22.19.0", ">22.19.0")).toBe(false);
    expect(satisfiesFloor("24.22.2", "^24.1.0")).toBe(true);
    expect(satisfiesFloor("25.0.0", "^24.1.0")).toBe(false);
    expect(satisfiesFloor("24.22.2", "~24.1.0")).toBe(false);
    expect(satisfiesFloor("24.22.2", "nonsense")).toBeNull();
    expect(satisfiesFloor(undefined, ">=22.19.0")).toBeNull();
  });

  it("covers every package the family constant names", () => {
    expect(PI_AGENT_FAMILY).toHaveLength(4);
    expect(new Set(PI_AGENT_FAMILY).size).toBe(4);
    expect(PI_AGENT_FAMILY).toContain(PI_AGENT_PACKAGE);
  });
});
