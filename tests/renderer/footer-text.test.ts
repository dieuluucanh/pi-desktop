import { describe, expect, it } from "vitest";

import {
  contextTone,
  contextUsageText,
  footerDetailText,
  modelLineText,
  pwdLineText,
  usageStatsText,
} from "../../src/renderer/src/session/footer-text";

/**
 * The session footer's strings (minimal-session-ui step 6): a Pi-shaped
 * `pwd (branch)` line, a token/cost/context stats line with the model on the
 * right, and the tooltip detail. Pure functions, exact strings.
 */

const CONTEXT = { percent: 42, tokens: 12_345, contextWindow: 200_000 };

describe("pwdLineText", () => {
  it("abbreviates the home prefix and appends the branch", () => {
    expect(pwdLineText({ cwd: "C:\\Users\\me\\app", branch: "dev" }, "C:\\Users\\me")).toBe(
      "~\\app (dev)",
    );
    expect(pwdLineText({ cwd: "/home/me/app" }, "/home/me")).toBe("~/app");
  });

  it("returns null without a working directory", () => {
    expect(pwdLineText({})).toBeNull();
    expect(pwdLineText({ branch: "dev" })).toBeNull();
  });
});

describe("usageStatsText", () => {
  it("shows only the directions that exist, then the cost", () => {
    expect(
      usageStatsText({
        usage: { input: 12_340, output: 4_560, cacheRead: 1000, cacheWrite: 0 },
        cost: 0.0432,
      }),
    ).toBe("↑12.3k ↓4.6k R1.0k $0.043");
  });

  it("returns null when there is nothing to report", () => {
    expect(usageStatsText({})).toBeNull();
    expect(
      usageStatsText({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
    ).toBeNull();
  });
});

describe("contextUsageText", () => {
  it("formats the percentage against the context window", () => {
    expect(contextUsageText(CONTEXT)).toBe("42%/200.0k");
  });

  it("reports an unknown percent as '?' rather than 0%", () => {
    expect(contextUsageText({ percent: null, tokens: null, contextWindow: 200_000 })).toBe(
      "?/200.0k",
    );
  });

  it("marks auto-compaction like terminal Pi", () => {
    expect(contextUsageText(CONTEXT, true)).toBe("42%/200.0k (auto)");
  });

  it("returns null when there is no useful usage", () => {
    expect(contextUsageText(null)).toBeNull();
    expect(contextUsageText({ percent: null, tokens: null, contextWindow: null })).toBeNull();
  });
});

describe("contextTone", () => {
  it("uses Pi's 70/90 thresholds", () => {
    expect(contextTone({ percent: 69, tokens: 1, contextWindow: 100 })).toBeNull();
    expect(contextTone({ percent: 70, tokens: 1, contextWindow: 100 })).toBe("text-warn");
    expect(contextTone({ percent: 90, tokens: 1, contextWindow: 100 })).toBe("text-danger");
    expect(contextTone(null)).toBeNull();
  });
});

describe("modelLineText", () => {
  it("puts the short id and thinking level on the right", () => {
    expect(modelLineText("claude-sonnet-4", "high")).toBe("claude-sonnet-4 • high");
    expect(modelLineText("claude-sonnet-4", null)).toBe("claude-sonnet-4");
    expect(modelLineText(null, "high")).toBe("thinking high");
    expect(modelLineText(null, null)).toBeNull();
  });
});

describe("footerDetailText", () => {
  it("collects the token directions, model, provider and auto markers", () => {
    const detail = footerDetailText({
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 },
      model: "anthropic/claude",
      provider: "anthropic",
      auto: { compaction: true, retry: true },
    });
    expect(detail).toContain("in 100");
    expect(detail).toContain("out 20");
    expect(detail).toContain("cache r 5 / w 1");
    expect(detail).toContain("model anthropic/claude");
    expect(detail).toContain("provider anthropic");
    expect(detail).toContain("auto-compaction");
    expect(detail).toContain("auto-retry");
  });

  it("returns null without any detail", () => {
    expect(footerDetailText({})).toBeNull();
  });
});
