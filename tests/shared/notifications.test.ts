import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_PREFS,
  MAX_MUTE_RULES,
  MAX_NOTIFICATION_SAMPLE,
  NOTIFICATION_REPEAT_WINDOW_MS,
  isNotificationMuted,
  matchingMuteRule,
  muteRuleFor,
  normalizeNotificationText,
  notificationRuleId,
  notificationRuleLabel,
  notificationSignature,
  removeMuteRule,
  removeMutesForNotification,
  sanitizeNotificationPrefs,
  shouldCollapseNotification,
  withMuteRule,
  type NotificationMuteRule,
} from "../../src/shared/notifications";

const THINKING_HIGH =
  "Workflow plan: thinking xhigh → high (opencode-go/deepseek-v4.1-flash does not support xhigh).";
const THINKING_MEDIUM =
  "Workflow plan: thinking medium → high (synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash does not support medium).";

const warning = (message: string) => ({ message, type: "warning" as const });

function rule(overrides: Partial<NotificationMuteRule> = {}): NotificationMuteRule {
  return {
    id: "rule-1",
    scope: "exact",
    type: "warning",
    value: normalizeNotificationText(THINKING_HIGH),
    sample: THINKING_HIGH,
    createdAt: 1000,
    ...overrides,
  };
}

describe("normalizeNotificationText", () => {
  it("collapses whitespace and matches case-insensitively", () => {
    expect(normalizeNotificationText("  Hello\n\n World  ")).toBe("hello world");
    expect(normalizeNotificationText("HELLO   WORLD")).toBe("hello world");
  });
});

describe("notificationSignature", () => {
  it("treats changing thinking levels and model refs as the same template", () => {
    expect(notificationSignature(THINKING_HIGH)).toBe(notificationSignature(THINKING_MEDIUM));
    expect(notificationSignature(THINKING_HIGH)).toContain("thinking * → *");
    expect(notificationSignature(THINKING_HIGH)).not.toContain("xhigh");
    expect(notificationSignature(THINKING_HIGH)).not.toContain("deepseek");
  });

  it("replaces quoted values and numbers", () => {
    const signature = notificationSignature('Opened "Book1.xlsx" with 12 panes');
    expect(signature).toBe("opened * with * panes");
  });
});

describe("mute rules", () => {
  it("matches an exact rule after normalization", () => {
    const created = muteRuleFor(warning(THINKING_HIGH), "exact");
    expect(
      matchingMuteRule(
        warning(
          "  workflow PLAN: thinking xhigh → high (opencode-go/deepseek-v4.1-flash does not support xhigh). ",
        ),
        [created],
      ),
    ).not.toBeNull();
  });

  it("matches only notifications of the same type", () => {
    const created = muteRuleFor(warning(THINKING_HIGH), "exact");
    expect(
      isNotificationMuted({ message: THINKING_HIGH, type: "error" }, { muted: [created] }),
    ).toBe(false);
  });

  it("a template rule covers the level variants", () => {
    const created = muteRuleFor(warning(THINKING_MEDIUM), "template");
    expect(isNotificationMuted(warning(THINKING_HIGH), { muted: [created] })).toBe(true);
    expect(isNotificationMuted(warning("Something else entirely"), { muted: [created] })).toBe(
      false,
    );
  });

  it("a type rule covers every message of that type", () => {
    const created = muteRuleFor(warning("first"), "type");
    expect(created.value).toBe("warning");
    expect(isNotificationMuted(warning("anything at all"), { muted: [created] })).toBe(true);
    expect(isNotificationMuted({ message: "an error", type: "error" }, { muted: [created] })).toBe(
      false,
    );
  });

  it("labels each scope for the Settings list", () => {
    expect(notificationRuleLabel(rule({ scope: "type", value: "warning" }))).toBe(
      "All warning notifications",
    );
    expect(notificationRuleLabel(rule())).toContain("Workflow plan");
    expect(notificationRuleLabel(rule({ scope: "template" }))).toMatch(/^Notifications like/);
  });

  it("builds a bounded sample and a deterministic id", () => {
    const long = "x".repeat(MAX_NOTIFICATION_SAMPLE + 50);
    const created = muteRuleFor(warning(long), "exact", 42);
    expect(created.sample).toHaveLength(MAX_NOTIFICATION_SAMPLE);
    expect(created.createdAt).toBe(42);
    expect(created.id).toBe(notificationRuleId("exact", "warning", created.value));
  });
});

describe("withMuteRule and removal", () => {
  it("puts the newest rule first and replaces a duplicate id", () => {
    const first = muteRuleFor(warning("one"), "exact", 1);
    const second = muteRuleFor(warning("two"), "exact", 2);
    const once = withMuteRule(DEFAULT_NOTIFICATION_PREFS, first);
    const twice = withMuteRule(once, second);
    expect(twice.muted.map((entry) => entry.sample)).toEqual(["two", "one"]);
    const replaced = withMuteRule(twice, { ...first, sample: "updated", createdAt: 3 });
    expect(replaced.muted).toHaveLength(2);
    expect(replaced.muted[0]?.sample).toBe("updated");
  });

  it("caps the list", () => {
    let prefs = DEFAULT_NOTIFICATION_PREFS;
    for (let index = 0; index < MAX_MUTE_RULES + 5; index += 1) {
      prefs = withMuteRule(prefs, muteRuleFor(warning(`message ${index}`), "exact", index));
    }
    expect(prefs.muted).toHaveLength(MAX_MUTE_RULES);
    expect(prefs.muted[0]?.sample).toBe(`message ${MAX_MUTE_RULES + 4}`);
  });

  it("removes one rule by id", () => {
    const created = muteRuleFor(warning("one"), "exact");
    expect(removeMuteRule({ muted: [created] }, created.id).muted).toHaveLength(0);
    expect(removeMuteRule({ muted: [created] }, "missing").muted).toHaveLength(1);
  });

  it("removes every rule that silences a notification", () => {
    const exact = muteRuleFor(warning(THINKING_HIGH), "exact");
    const template = muteRuleFor(warning(THINKING_HIGH), "template");
    const other = muteRuleFor(warning("other"), "exact");
    const remaining = removeMutesForNotification(
      { muted: [exact, template, other] },
      warning(THINKING_MEDIUM),
    );
    // The exact rule names the other level, so it stays; the template rule is
    // the one that covers both levels.
    expect(remaining.muted.map((entry) => entry.id)).toEqual([exact.id, other.id]);
  });
});

describe("sanitizeNotificationPrefs", () => {
  it("returns an empty list for malformed input", () => {
    expect(sanitizeNotificationPrefs(null)).toEqual({ muted: [] });
    expect(sanitizeNotificationPrefs("warning")).toEqual({ muted: [] });
    expect(sanitizeNotificationPrefs({ muted: "nope" })).toEqual({ muted: [] });
  });

  it("drops malformed rules and recomputes ids", () => {
    const created = muteRuleFor(warning("one"), "exact");
    const result = sanitizeNotificationPrefs({
      muted: [
        { ...created, id: "hand-edited" },
        { scope: "exact", type: "warning", value: "" },
        { scope: "nope", type: "warning", value: "x" },
        { scope: "exact", type: "danger", value: "x" },
        "not a rule",
      ],
    });
    expect(result.muted).toHaveLength(1);
    expect(result.muted[0]?.id).toBe(created.id);
  });

  it("dedupes and caps the persisted list", () => {
    const entries = Array.from({ length: MAX_MUTE_RULES + 3 }, (_, index) =>
      muteRuleFor(warning(`message ${index}`), "exact", index),
    );
    const result = sanitizeNotificationPrefs({ muted: [...entries, entries[0]] });
    expect(result.muted).toHaveLength(MAX_MUTE_RULES);
    expect(new Set(result.muted.map((entry) => entry.id)).size).toBe(MAX_MUTE_RULES);
  });

  it("keeps a valid sample and clamps the timestamp", () => {
    const result = sanitizeNotificationPrefs({
      muted: [
        {
          scope: "exact",
          type: "warning",
          value: "x",
          sample: "  sample  ",
          createdAt: -12,
        },
      ],
    });
    expect(result.muted[0]).toMatchObject({ sample: "sample", createdAt: 0 });
  });
});

describe("shouldCollapseNotification", () => {
  it("suppresses inside the window and allows after it", () => {
    const now = 10_000_000;
    expect(shouldCollapseNotification(undefined, now)).toBe(false);
    expect(shouldCollapseNotification(now - 1000, now)).toBe(true);
    expect(shouldCollapseNotification(now - NOTIFICATION_REPEAT_WINDOW_MS, now)).toBe(false);
    expect(shouldCollapseNotification(now - NOTIFICATION_REPEAT_WINDOW_MS - 1, now)).toBe(false);
  });

  it("does not suppress when the clock moved backwards", () => {
    expect(shouldCollapseNotification(2_000, 1_000)).toBe(false);
  });
});
