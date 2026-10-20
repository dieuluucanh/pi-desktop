import { describe, expect, it } from "vitest";

import {
  parseWorkflowStatus,
  statusLineText,
  workflowBorderClass,
  workflowModeLabel,
  WORKFLOW_MODES,
} from "../../src/shared/workflow-mode";

/**
 * The workflow mode decoder (2026-10-19 UI rework).
 *
 * The status text is written by the third-party Workflow extension, which this
 * repo does not pin, so the tests that matter most are the degradation ones: an
 * unknown or restyled value must yield null (a neutral border), never throw and
 * never mis-colour the composer.
 */

/** `ctx.ui.theme.fg("accent", text)` as it reaches the status map. */
function colored(text: string, code = 36): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

describe("parseWorkflowStatus", () => {
  it("decodes each shipped build status", () => {
    expect(parseWorkflowStatus("▶ build")).toEqual({
      mode: "build",
      browserReview: false,
      done: null,
      total: null,
    });
    expect(parseWorkflowStatus("▶ build 3/8")).toEqual({
      mode: "build",
      browserReview: false,
      done: 3,
      total: 8,
    });
  });

  it("decodes each shipped plan status", () => {
    expect(parseWorkflowStatus("⏸ plan")).toEqual({
      mode: "plan",
      browserReview: false,
      done: null,
      total: null,
    });
    expect(parseWorkflowStatus("⏸ plan 2/8")).toEqual({
      mode: "plan",
      browserReview: false,
      done: 2,
      total: 8,
    });
  });

  it("flags the plannotator plan variant as a browser-review sub-state of plan", () => {
    expect(parseWorkflowStatus("⏸ plan — reviewing in browser")).toEqual({
      mode: "plan",
      browserReview: true,
      done: null,
      total: null,
    });
    expect(parseWorkflowStatus("⏸ plan — reviewing in browser 1/4")).toMatchObject({
      mode: "plan",
      browserReview: true,
      done: 1,
      total: 4,
    });
  });

  it("decodes the default (workflow off) status", () => {
    expect(parseWorkflowStatus("◦ 3/8")).toEqual({
      mode: "default",
      browserReview: false,
      done: 3,
      total: 8,
    });
    expect(parseWorkflowStatus("◦ commits:never")).toEqual({
      mode: "default",
      browserReview: false,
      done: null,
      total: null,
    });
  });

  it("strips ANSI colours before decoding", () => {
    // The extension wraps the label in theme colours (`index.ts:919/928`), and
    // the status map carries those escape codes verbatim.
    expect(parseWorkflowStatus(colored("▶ build 3/8"))?.mode).toBe("build");
    expect(parseWorkflowStatus(colored("⏸ plan", 33))?.mode).toBe("plan");
    expect(parseWorkflowStatus(colored("◦ commits:never", 90))?.mode).toBe("default");
  });

  it("keeps the mode when trailing decorations follow it", () => {
    // `…⏸ plan | ⚡ profile | planner · commits:never`
    expect(parseWorkflowStatus("⏸ plan 2/8 | ⚡ work | planner · commits:never")).toMatchObject({
      mode: "plan",
      done: 2,
      total: 8,
    });
    expect(parseWorkflowStatus("▶ build ⚠ | builder")).toMatchObject({ mode: "build" });
  });

  it("returns null for the office-bridge status", () => {
    // A real, unrelated status from `@dieulc/pi-office-bridge` (`setStatus`).
    expect(parseWorkflowStatus("office: Excel attached (bridge :38617)")).toBeNull();
    expect(parseWorkflowStatus("office bridge on :38617 — no app attached")).toBeNull();
  });

  it("degrades to null for unknown, empty and missing text", () => {
    for (const value of [
      "",
      "   ",
      "\x1b[0m\x1b[0m",
      "workflow",
      "building",
      "plan",
      "▶plan",
      "server-logs: tailing /var/log/app.log",
      "autocompact: waiting",
      "▶",
      "⏸",
      "◦",
      "\u0000nonsense",
      "\n\n",
    ]) {
      expect(parseWorkflowStatus(value), JSON.stringify(value)).toBeNull();
    }
    expect(parseWorkflowStatus(null)).toBeNull();
    expect(parseWorkflowStatus(undefined)).toBeNull();
  });

  it("never throws on malformed input", () => {
    const weird = ["\x1b[", "\x1b]0;title", "▶ build 1/", "▶ build a/b", "◦ //", "\ud800"];
    for (const value of weird) {
      expect(() => parseWorkflowStatus(value)).not.toThrow();
    }
  });

  it("ignores a non-numeric progress pair instead of guessing", () => {
    expect(parseWorkflowStatus("▶ build a/b")).toMatchObject({ done: null, total: null });
  });
});

describe("workflowBorderClass", () => {
  it("mirrors the extension's own status colours", () => {
    // `index.ts:919` build → accent, `:928` plan → warning.
    expect(workflowBorderClass(parseWorkflowStatus("▶ build"))).toBe("border-accent");
    expect(workflowBorderClass(parseWorkflowStatus("⏸ plan"))).toBe("border-warn");
    expect(workflowBorderClass(parseWorkflowStatus("⏸ plan — reviewing in browser"))).toBe(
      "border-warn",
    );
  });

  it("stays neutral for default mode and for no mode", () => {
    expect(workflowBorderClass(parseWorkflowStatus("◦ commits:never"))).toBe("border-line");
    expect(workflowBorderClass(null)).toBe("border-line");
  });

  it("only ever returns a complete Tailwind utility", () => {
    // A concatenated `border-${tone}` compiles to no CSS at all (Tailwind scans
    // source text), so the return set is pinned.
    const classes = new Set(
      [...WORKFLOW_MODES, null].map((mode) =>
        workflowBorderClass(
          mode === null
            ? null
            : parseWorkflowStatus(
                mode === "build" ? "▶ build" : mode === "plan" ? "⏸ plan" : "◦ 1/2",
              ),
        ),
      ),
    );
    expect([...classes].sort()).toEqual(["border-accent", "border-line", "border-warn"]);
  });
});

describe("workflowModeLabel", () => {
  it("labels build and plan, keeping Plan for the browser-review sub-state", () => {
    expect(workflowModeLabel(parseWorkflowStatus("▶ build 3/8"))).toBe("Build");
    expect(workflowModeLabel(parseWorkflowStatus("⏸ plan"))).toBe("Plan");
    // The plannotator "reviewing in browser" phrase is a Plan sub-state, not a
    // mode: the badge always reads Plan (2026-10-20 startup-tab-cycle plan).
    expect(workflowModeLabel(parseWorkflowStatus("⏸ plan — reviewing in browser"))).toBe("Plan");
  });

  it("names the default mode instead of returning nothing", () => {
    // 2026-10-19: an empty label for Default left the only workflow-off state
    // with no textual indicator at all. Every recognised mode is named; only an
    // absent/unrecognised status has no label.
    expect(workflowModeLabel(parseWorkflowStatus("◦ 3/8"))).toBe("Default");
    expect(workflowModeLabel(parseWorkflowStatus("◦ commits:never"))).toBe("Default");
  });

  it("shows no badge for no mode", () => {
    expect(workflowModeLabel(null)).toBeNull();
    expect(workflowModeLabel(parseWorkflowStatus("office: Excel attached"))).toBeNull();
    expect(workflowModeLabel(parseWorkflowStatus(""))).toBeNull();
  });
});

describe("statusLineText", () => {
  it("removes escape sequences and collapses whitespace", () => {
    expect(statusLineText(colored("▶ build 3/8"))).toBe("▶ build 3/8");
    expect(statusLineText("  line one\n\tline two  ")).toBe("line one line two");
    expect(statusLineText("a\r\nb")).toBe("a b");
  });

  it("caps the length so a huge status cannot blow up a title attribute", () => {
    const long = "x".repeat(500);
    const capped = statusLineText(long);
    expect(capped.length).toBe(160);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("returns an empty string for empty input", () => {
    expect(statusLineText("")).toBe("");
    expect(statusLineText("\x1b[0m")).toBe("");
    expect(statusLineText("   ")).toBe("");
  });
});
