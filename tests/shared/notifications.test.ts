import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_CLASSES,
  DEFAULT_NOTIFICATION_PREFS,
  MAX_MUTE_RULES,
  MAX_NOTIFICATION_SAMPLE,
  NOTIFICATION_CLASSES,
  NOTIFICATION_CLASS_META,
  NOTIFICATION_REPEAT_WINDOW_MS,
  appNotificationFromExtension,
  isNotificationClassEnabled,
  isNotificationMuted,
  isNotificationSuppressed,
  matchingMuteRule,
  muteRuleFor,
  normalizeNotificationText,
  notificationClassOf,
  notificationRuleId,
  notificationRuleLabel,
  notificationSignature,
  removeMuteRule,
  removeMutesForNotification,
  sanitizeNotificationPrefs,
  shouldCollapseNotification,
  updateNotification,
  updateNotificationId,
  withMuteRule,
  type NotificationMuteRule,
  type NotificationPrefs,
} from "../../src/shared/notifications";

const THINKING_HIGH =
  "Workflow plan: thinking xhigh → high (opencode-go/deepseek-v4.1-flash does not support xhigh).";
const THINKING_MEDIUM =
  "Workflow plan: thinking medium → high (synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash does not support medium).";

const warning = (message: string) => ({ message, type: "warning" as const });

/** A prefs object with the default classes and the supplied rules. */
function prefsWith(muted: NotificationMuteRule[] = []): NotificationPrefs {
  return { ...DEFAULT_NOTIFICATION_PREFS, muted };
}

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
      isNotificationMuted({ message: THINKING_HIGH, type: "error" }, prefsWith([created])),
    ).toBe(false);
  });

  it("a template rule covers the level variants", () => {
    const created = muteRuleFor(warning(THINKING_MEDIUM), "template");
    expect(isNotificationMuted(warning(THINKING_HIGH), prefsWith([created]))).toBe(true);
    expect(isNotificationMuted(warning("Something else entirely"), prefsWith([created]))).toBe(
      false,
    );
  });

  it("a type rule covers every message of that type", () => {
    const created = muteRuleFor(warning("first"), "type");
    expect(created.value).toBe("warning");
    expect(isNotificationMuted(warning("anything at all"), prefsWith([created]))).toBe(true);
    expect(isNotificationMuted({ message: "an error", type: "error" }, prefsWith([created]))).toBe(
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
    expect(removeMuteRule(prefsWith([created]), created.id).muted).toHaveLength(0);
    expect(removeMuteRule(prefsWith([created]), "missing").muted).toHaveLength(1);
  });

  it("removes every rule that silences a notification", () => {
    const exact = muteRuleFor(warning(THINKING_HIGH), "exact");
    const template = muteRuleFor(warning(THINKING_HIGH), "template");
    const other = muteRuleFor(warning("other"), "exact");
    const remaining = removeMutesForNotification(
      prefsWith([exact, template, other]),
      warning(THINKING_MEDIUM),
    );
    // The exact rule names the other level, so it stays; the template rule is
    // the one that covers both levels.
    expect(remaining.muted.map((entry) => entry.id)).toEqual([exact.id, other.id]);
  });
});

describe("sanitizeNotificationPrefs", () => {
  it("returns the default classes and an empty list for malformed input", () => {
    const empty = { classes: DEFAULT_NOTIFICATION_CLASSES, muted: [] };
    expect(sanitizeNotificationPrefs(null)).toEqual(empty);
    expect(sanitizeNotificationPrefs("warning")).toEqual(empty);
    expect(sanitizeNotificationPrefs({ muted: "nope" })).toEqual(empty);
  });

  it("coerces only boolean class flags and drops unknown classes", () => {
    const result = sanitizeNotificationPrefs({
      classes: { info: true, warning: "yes", nope: true },
    });
    expect(result.classes).toEqual({ ...DEFAULT_NOTIFICATION_CLASSES, info: true });
    expect(result.classes).not.toHaveProperty("nope");
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

describe("notification classes", () => {
  it("publishes a label and description for every class", () => {
    for (const klass of NOTIFICATION_CLASSES) {
      expect(NOTIFICATION_CLASS_META[klass].label.length).toBeGreaterThan(0);
      expect(NOTIFICATION_CLASS_META[klass].description.length).toBeGreaterThan(0);
    }
  });

  it("defaults to showing updates, errors and warnings, hiding info", () => {
    expect(DEFAULT_NOTIFICATION_CLASSES).toEqual({
      update: true,
      error: true,
      warning: true,
      info: false,
    });
    expect(isNotificationClassEnabled(DEFAULT_NOTIFICATION_PREFS, "info")).toBe(false);
    expect(isNotificationClassEnabled(DEFAULT_NOTIFICATION_PREFS, "warning")).toBe(true);
    expect(isNotificationClassEnabled(undefined, "update")).toBe(true);
  });

  it("derives the class from the severity unless an app class is explicit", () => {
    expect(notificationClassOf(warning("w"))).toBe("warning");
    expect(notificationClassOf({ message: "i", type: "info" })).toBe("info");
    expect(notificationClassOf({ message: "u", type: "info", class: "update" })).toBe("update");
  });

  it("suppresses a disabled class even without a rule", () => {
    expect(
      isNotificationSuppressed({ message: "hello", type: "info" }, DEFAULT_NOTIFICATION_PREFS),
    ).toBe(true);
    expect(
      isNotificationSuppressed({ message: "hello", type: "warning" }, DEFAULT_NOTIFICATION_PREFS),
    ).toBe(false);
    expect(
      isNotificationSuppressed(
        { message: "hello", type: "info" },
        { ...DEFAULT_NOTIFICATION_PREFS, classes: { ...DEFAULT_NOTIFICATION_CLASSES, info: true } },
      ),
    ).toBe(false);
  });

  it("suppresses a rule-matched notification inside an enabled class", () => {
    const created = muteRuleFor(warning(THINKING_HIGH), "exact");
    expect(isNotificationSuppressed(warning(THINKING_HIGH), prefsWith([created]))).toBe(true);
    expect(isNotificationSuppressed(warning("other"), prefsWith([created]))).toBe(false);
  });

  it("keeps the class defaults when a rule is added or removed", () => {
    const classes = { ...DEFAULT_NOTIFICATION_CLASSES, info: true };
    const seeded: NotificationPrefs = { classes, muted: [] };
    const created = muteRuleFor(warning("one"), "exact");
    const added = withMuteRule(seeded, created);
    expect(added.classes).toEqual(classes);
    expect(removeMuteRule(added, created.id).classes).toEqual(classes);
    expect(removeMutesForNotification(added, warning("one")).classes).toEqual(classes);
  });
});

describe("app notifications", () => {
  it("wraps an extension notification in the unified archive shape", () => {
    const notification = appNotificationFromExtension({
      id: "n1",
      message: "Installed",
      type: "warning",
      tabId: "tab-1",
      at: 12,
    });
    expect(notification).toEqual({
      id: "n1",
      message: "Installed",
      type: "warning",
      class: "warning",
      tabId: "tab-1",
      at: 12,
      action: null,
    });
  });

  it("builds one stable update offer with an open-updates action", () => {
    const notification = updateNotification("0.8.0", 42);
    expect(notification.id).toBe(updateNotificationId("0.8.0"));
    expect(notification).toMatchObject({
      message: "Pi Desktop v0.8.0 is available.",
      type: "info",
      class: "update",
      tabId: null,
      at: 42,
      action: { kind: "open-updates" },
    });
    expect(updateNotification("v0.8.0").message).toBe("Pi Desktop v0.8.0 is available.");
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
