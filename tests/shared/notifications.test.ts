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
  isUpdateOfferPhase,
  matchingMuteRule,
  muteRuleFor,
  normalizeNotificationText,
  notificationClassOf,
  notificationRuleId,
  notificationRuleLabel,
  notificationSignature,
  offerNotifications,
  packageUpdateNotification,
  packageUpdateNotificationId,
  removeMuteRule,
  removeMutesForNotification,
  sanitizeNotificationPrefs,
  shouldCollapseNotification,
  updateNotification,
  updateNotificationId,
  withMuteRule,
  type NotificationMuteRule,
  type NotificationOfferInput,
  type NotificationPrefs,
} from "../../src/shared/notifications";
import { packageUpdateSignature } from "../../src/shared/packages";
import type { PackageUpdateSummary } from "../../src/shared/packages";

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

  it("defaults to showing updates, extension updates, errors and warnings, hiding info", () => {
    expect(DEFAULT_NOTIFICATION_CLASSES).toEqual({
      update: true,
      extension: true,
      error: true,
      warning: true,
      info: false,
    });
    expect(isNotificationClassEnabled(DEFAULT_NOTIFICATION_PREFS, "info")).toBe(false);
    expect(isNotificationClassEnabled(DEFAULT_NOTIFICATION_PREFS, "warning")).toBe(true);
    expect(isNotificationClassEnabled(undefined, "update")).toBe(true);
    expect(isNotificationClassEnabled(undefined, "extension")).toBe(true);
  });

  it("builds one stable extension-update row per update set", () => {
    const signature = "npm:alpha@2.0.0|npm:beta@";
    const notification = packageUpdateNotification(3, signature, 1);

    expect(notification).toEqual({
      id: packageUpdateNotificationId(signature),
      message: "3 extension updates available.",
      type: "info",
      class: "extension",
      tabId: null,
      at: 1,
      action: { kind: "open-extensions" },
    });
    expect(packageUpdateNotification(1, signature).message).toBe("1 extension update available.");
    // The id is stable for one set and changes when the set changes.
    expect(packageUpdateNotificationId(signature)).toBe(packageUpdateNotificationId(signature));
    expect(packageUpdateNotificationId(signature)).not.toBe(
      packageUpdateNotificationId("npm:alpha@2.0.1|npm:beta@"),
    );
    expect(packageUpdateNotificationId(signature)).toMatch(/^app:packages:[0-9a-f]{8}$/);
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

  it("follows the updater phase in the offer copy", () => {
    expect(updateNotification("0.8.0", 1, "downloading").message).toBe(
      "Pi Desktop v0.8.0 is downloading.",
    );
    expect(updateNotification("0.8.0", 1, "downloaded").message).toBe(
      "Pi Desktop v0.8.0 is ready to install.",
    );
    expect(isUpdateOfferPhase("available")).toBe(true);
    expect(isUpdateOfferPhase("downloading")).toBe(true);
    expect(isUpdateOfferPhase("downloaded")).toBe(true);
    expect(isUpdateOfferPhase("up-to-date")).toBe(false);
    expect(isUpdateOfferPhase("error")).toBe(false);
  });
});

const updateEntry = (overrides: Partial<PackageUpdateSummary> = {}): PackageUpdateSummary => ({
  source: "npm:@dieulc/workflow",
  name: "@dieulc/workflow",
  kind: "npm",
  scope: "user",
  latestVersion: "0.5.0",
  ...overrides,
});

function offerInput(overrides: Partial<NotificationOfferInput> = {}): NotificationOfferInput {
  return {
    prefsLoaded: true,
    prefs: DEFAULT_NOTIFICATION_PREFS,
    update: null,
    packageUpdates: [],
    packageUpdatesCheckedAt: null,
    dismissedVersion: null,
    dismissedSignature: null,
    ...overrides,
  };
}

describe("offerNotifications", () => {
  it("stays blank until the stored class switches have loaded", () => {
    const offers = offerNotifications(
      offerInput({
        prefsLoaded: false,
        update: { phase: "available", version: "0.9.0", checkedAt: 5 },
        packageUpdates: [updateEntry()],
      }),
    );
    expect(offers).toEqual([]);
  });

  it("derives one release offer per phase that still needs the user", () => {
    const cases = [
      ["available", "Pi Desktop v0.9.0 is available."],
      ["downloading", "Pi Desktop v0.9.0 is downloading."],
      ["downloaded", "Pi Desktop v0.9.0 is ready to install."],
    ] as const;
    for (const [phase, message] of cases) {
      const offers = offerNotifications(
        offerInput({ update: { phase, version: "0.9.0", checkedAt: 25 } }),
      );
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({
        id: updateNotificationId("0.9.0"),
        message,
        class: "update",
        at: 25,
        action: { kind: "open-updates" },
      });
    }
  });

  it("derives no release offer once the updater has nothing to offer", () => {
    for (const phase of [
      "idle",
      "checking",
      "up-to-date",
      "no-feed",
      "error",
      "unsupported",
    ] as const) {
      expect(
        offerNotifications(offerInput({ update: { phase, version: "0.9.0", checkedAt: 1 } })),
      ).toEqual([]);
    }
    expect(
      offerNotifications(
        offerInput({ update: { phase: "available", version: null, checkedAt: 1 } }),
      ),
    ).toEqual([]);
  });

  it("gates the release offer on its class switch and dismissal marker", () => {
    const update = { phase: "available", version: "0.9.0", checkedAt: 1 } as const;
    const muted = {
      ...DEFAULT_NOTIFICATION_PREFS,
      classes: { ...DEFAULT_NOTIFICATION_CLASSES, update: false },
    };
    expect(offerNotifications(offerInput({ update, prefs: muted }))).toEqual([]);
    expect(offerNotifications(offerInput({ update, dismissedVersion: "0.9.0" }))).toEqual([]);
    expect(offerNotifications(offerInput({ update, dismissedVersion: "0.8.0" }))).toHaveLength(1);
  });

  it("describes the current package update set, not a remembered one", () => {
    const one = offerNotifications(offerInput({ packageUpdates: [updateEntry()] }));
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({
      id: packageUpdateNotificationId(packageUpdateSignature([updateEntry()])),
      message: "1 extension update available.",
      class: "extension",
      action: { kind: "open-extensions" },
    });

    const two = offerNotifications(
      offerInput({
        packageUpdates: [updateEntry(), updateEntry({ source: "npm:other", name: "other" })],
      }),
    );
    expect(two).toHaveLength(1);
    expect(two[0]?.message).toBe("2 extension updates available.");
    expect(offerNotifications(offerInput({ packageUpdates: [] }))).toEqual([]);
  });

  it("keeps a dismissed set dismissed until the set changes", () => {
    const signature = packageUpdateSignature([updateEntry()]);
    expect(
      offerNotifications(
        offerInput({ packageUpdates: [updateEntry()], dismissedSignature: signature }),
      ),
    ).toEqual([]);
    expect(
      offerNotifications(
        offerInput({
          packageUpdates: [updateEntry()],
          dismissedSignature: packageUpdateSignature([updateEntry({ latestVersion: "0.4.0" })]),
        }),
      ),
    ).toHaveLength(1);
  });

  it("orders the release offer first and keeps `at` stable", () => {
    const input = offerInput({
      update: { phase: "available", version: "0.9.0", checkedAt: 10 },
      packageUpdates: [updateEntry()],
      packageUpdatesCheckedAt: 20,
    });
    const offers = offerNotifications(input);
    expect(offers.map((entry) => entry.class)).toEqual(["update", "extension"]);
    expect(offers.map((entry) => entry.at)).toEqual([10, 20]);
    expect(offerNotifications(input).map((entry) => entry.id)).toEqual(
      offers.map((entry) => entry.id),
    );
  });

  it("never consults per-message mute rules", () => {
    const infoRule = muteRuleFor({ message: "Server logs ready (local)", type: "info" }, "type");
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS, muted: [infoRule] };
    const offers = offerNotifications(
      offerInput({
        prefs,
        update: { phase: "available", version: "0.9.0", checkedAt: 1 },
        packageUpdates: [updateEntry()],
      }),
    );
    expect(offers).toHaveLength(2);
    // The archive predicate still hides an archived info row with the same rule.
    expect(
      isNotificationSuppressed({ message: "Server logs ready (local)", type: "info" }, prefs),
    ).toBe(true);
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
