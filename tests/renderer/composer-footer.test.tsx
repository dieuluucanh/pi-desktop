import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ComposerFooter,
  compactPath,
  contextFooterText,
  sessionFactsText,
} from "../../src/renderer/src/session/ComposerFooter";
import { parseWorkflowStatus } from "../../src/shared/workflow-mode";

/**
 * The composer footer (2026-10-19 UI rework).
 *
 * The facts row replaces what the global status bar used to carry for a session,
 * and the status row is where extension statuses (`ctx.ui.setStatus`) now show —
 * including the Office bridge's "attached" line. Two properties matter:
 *
 *  - third-party status text arrives with ANSI colour (the workflow extension
 *    wraps its label in `theme.fg`), so colours must survive **without** leaking
 *    raw escape bytes into the accessible text; and
 *  - a footer with nothing to say renders nothing at all, so a session view is
 *    not padded with empty chrome.
 */

const CONTEXT = { percent: 42, tokens: 12_345, contextWindow: 200_000 };

describe("composer footer facts", () => {
  it("renders the path, model, thinking and context budget", () => {
    render(
      <ComposerFooter
        facts={{
          cwd: "C:\\Users\\Lenovo\\Projects\\pi-desktop",
          branch: "main",
          model: "claude-sonnet-4",
          thinking: "medium",
          context: CONTEXT,
          cost: 0.0432,
        }}
      />,
    );

    expect(screen.getByTestId("composer-footer")).toBeInTheDocument();
    expect(
      screen.getByText(
        "C:\\Users\\Lenovo\\Projects\\pi-desktop (main) · claude-sonnet-4 · thinking medium",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("42% of 200.0k · 12.3k tokens · $0.0432")).toBeInTheDocument();
  });

  it("shows a short path with the full value in the title", () => {
    const long =
      "C:\\Users\\someone\\AppData\\Roaming\\pi-desktop\\workspace\\nested\\project-folder";
    render(<ComposerFooter facts={{ cwd: long }} />);

    const label = screen.getByTitle(long);
    expect(label.textContent).not.toBe(long);
    expect(label.textContent).toContain("project-folder");
  });

  it("omits the branch when the folder is not a repository", () => {
    render(<ComposerFooter facts={{ cwd: "/work/app", model: "m" }} />);
    expect(screen.getByText("/work/app · m")).toBeInTheDocument();
  });

  it("reports an unknown context window as '?' rather than as 0%", () => {
    // Right after compaction Pi reports `tokens: null`; "unknown" and "empty"
    // must not look the same.
    render(
      <ComposerFooter
        facts={{ cwd: "/w", context: { percent: null, tokens: null, contextWindow: 200_000 } }}
      />,
    );
    expect(screen.getByText("? of 200.0k")).toBeInTheDocument();
    expect(screen.queryByText(/0%/)).toBeNull();
  });

  it("renders nothing when there are no facts and no statuses", () => {
    const { container } = render(<ComposerFooter facts={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("composer footer extension statuses", () => {
  it("renders one entry per status, sorted by key", () => {
    render(
      <ComposerFooter
        facts={{ cwd: "/w" }}
        statuses={{
          workflow: "▶ build 3/8",
          "office-bridge": "office: Excel attached (bridge :38617)",
          autocompact: "idle",
        }}
      />,
    );

    const items = screen
      .getByTestId("composer-footer-statuses")
      .querySelectorAll("[data-testid^='extension-status-']");
    expect([...items].map((node) => node.getAttribute("data-testid"))).toEqual([
      "extension-status-autocompact",
      "extension-status-office-bridge",
      "extension-status-workflow",
    ]);
    expect(screen.getByTestId("extension-status-office-bridge")).toHaveTextContent(
      "office: Excel attached (bridge :38617)",
    );
  });

  it("keeps ANSI colour without leaking escape codes into the text", () => {
    render(<ComposerFooter facts={{}} statuses={{ workflow: "\x1b[33m⏸ plan\x1b[0m" }} />);

    const entry = screen.getByTestId("extension-status-workflow");
    // The label is visible and coloured…
    expect(entry.textContent).toBe("⏸ plan");
    expect(entry.textContent).not.toContain("\x1b");
    expect(entry.querySelector("[style]")).not.toBeNull();
    // …and the title carries the sanitised plain text.
    expect(entry).toHaveAttribute("title", "Extension status: workflow\n⏸ plan");
  });

  it("renders the status row even when there are no session facts", () => {
    // An extension status with no session snapshot (e.g. a resumed tab) must
    // still be visible rather than silently dropped.
    render(<ComposerFooter facts={{}} statuses={{ "server-logs": "tailing app.log" }} />);
    expect(screen.getByTestId("composer-footer-statuses")).toBeInTheDocument();
    expect(screen.getByText("tailing app.log")).toBeInTheDocument();
  });

  it("flattens a status containing newlines into one readable title", () => {
    render(<ComposerFooter facts={{}} statuses={{ odd: "line one\nline two" }} />);
    const entry = screen.getByTestId("extension-status-odd");
    expect(entry).toHaveAttribute("title", "Extension status: odd\nline one line two");
  });
});

describe("composer footer helpers", () => {
  it("compacts only long paths and keeps the tail", () => {
    expect(compactPath("/work/app")).toBe("/work/app");
    const long = "C:\\Users\\someone\\very\\deeply\\nested\\workspace\\project-folder";
    expect(compactPath(long)).toBe("…\\workspace\\project-folder");
    expect(compactPath("")).toBe("");
  });

  it("builds the facts line from whatever is present", () => {
    expect(sessionFactsText({})).toBeNull();
    expect(sessionFactsText({ model: "m" })).toBe("m");
    expect(sessionFactsText({ thinking: "high" })).toBe("thinking high");
    expect(sessionFactsText({ cwd: "/w", branch: "dev" })).toBe("/w (dev)");
  });

  it("returns null for the context line when there is no usage", () => {
    expect(contextFooterText(null, null)).toBeNull();
    expect(contextFooterText(undefined, 1)).toBeNull();
    expect(contextFooterText(CONTEXT, null)).toBe("42% of 200.0k · 12.3k tokens");
  });
});

describe("composer footer mode chip (2026-10-19)", () => {
  const PLAN = parseWorkflowStatus("\u23f8 plan");
  const BUILD = parseWorkflowStatus("\u25b6 build 1/2");
  const DEFAULT = parseWorkflowStatus("\u25e6 commits:never");

  it("names every recognised mode as text", () => {
    for (const [mode, label] of [
      [PLAN, "Plan"],
      [BUILD, "Build"],
      [DEFAULT, "Default"],
    ] as const) {
      const view = render(<ComposerFooter facts={{ workflow: mode }} />);
      expect(screen.getByTestId("composer-mode")).toHaveTextContent(`mode: ${label}`);
      view.unmount();
    }
  });

  it("announces the mode to assistive tech", () => {
    render(<ComposerFooter facts={{ workflow: PLAN }} />);
    const chip = screen.getByTestId("composer-mode");
    expect(chip).toHaveAttribute("role", "status");
    expect(chip).toHaveAttribute("aria-live", "polite");
  });

  it("shows no chip for an absent or unrecognised status", () => {
    for (const workflow of [null, undefined, parseWorkflowStatus("office: attached")]) {
      const view = render(<ComposerFooter facts={{ workflow }} />);
      expect(screen.queryByTestId("composer-mode")).toBeNull();
      view.unmount();
    }
  });

  it("coexists with the facts and status rows", () => {
    render(
      <ComposerFooter
        facts={{ cwd: "/w", workflow: PLAN }}
        statuses={{ workflow: "\u23f8 plan" }}
      />,
    );
    expect(screen.getByTestId("composer-mode")).toBeInTheDocument();
    expect(screen.getByText("/w")).toBeInTheDocument();
    expect(screen.getByTestId("extension-status-workflow")).toBeInTheDocument();
  });
});
