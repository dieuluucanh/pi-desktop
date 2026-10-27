import { describe, expect, it } from "vitest";
import {
  createPromptOriginTracker,
  DEFAULT_MAX_PENDING_ORIGINS,
  DEFAULT_PROMPT_ORIGIN_TTL_MS,
  DEFAULT_STALE_ORIGIN_GRACE_MS,
} from "../../src/host/prompt-origin";

function trackerAt(clock: { now: number }, ttlMs?: number) {
  return createPromptOriginTracker({
    now: () => clock.now,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
}

describe("prompt origin tracker: matching", () => {
  it("consumes an exact sent text without tagging (a plain prompt)", () => {
    const tracker = createPromptOriginTracker();
    tracker.rememberPrompt(null, "please fix the bug");
    expect(tracker.consumeUserMessage("please fix the bug")).toBeNull();
    expect(tracker.pendingCount()).toBe(0);
  });

  it("tags a template expansion with the raw command", () => {
    const tracker = createPromptOriginTracker();
    tracker.rememberPrompt("/commit", "/commit");
    expect(tracker.consumeUserMessage("The user ran /commit and wants a message.")).toBe("/commit");
  });

  it("tags an extension command's injected message", () => {
    const tracker = createPromptOriginTracker();
    tracker.rememberCommand("/commit -a");
    expect(tracker.consumeUserMessage("You are committing staged changes…")).toBe("/commit -a");
  });

  it("treats an exact plain prompt as sent even while a command is pending", () => {
    const tracker = createPromptOriginTracker();
    tracker.rememberCommand("/commit");
    tracker.rememberPrompt(null, "hello");

    expect(tracker.consumeUserMessage("hello")).toBeNull();
    // The command entry survives its own message, which arrives separately.
    expect(tracker.pendingCount()).toBe(1);
    expect(tracker.consumeUserMessage("The user ran /commit…")).toBe("/commit");
  });

  it("considers prefix matches before the earliest entry", () => {
    const tracker = createPromptOriginTracker();
    tracker.rememberCommand("/commit");
    tracker.rememberPrompt(null, "hello");
    // The SDK appends image hints after the prompt text.
    expect(tracker.consumeUserMessage("hello\n\n[image attached]")).toBeNull();
    expect(tracker.pendingCount()).toBe(1);
  });

  it("uses the longest sent text the message starts with", () => {
    const tracker = createPromptOriginTracker();
    tracker.rememberPrompt("/a", "/a");
    tracker.rememberPrompt("/a b", "/a b");
    expect(tracker.consumeUserMessage("/a b extra")).toBe("/a b");
    expect(tracker.pendingCount()).toBe(1);
  });

  it("falls back to the earliest entry when nothing matches", () => {
    const tracker = createPromptOriginTracker();
    tracker.rememberPrompt("/first", "/first");
    tracker.rememberPrompt("/second", "/second");
    expect(tracker.consumeUserMessage("expanded first body")).toBe("/first");
    expect(tracker.consumeUserMessage("expanded second body")).toBe("/second");
  });

  it("returns null for a matched plain entry whose text was transformed", () => {
    const tracker = createPromptOriginTracker();
    tracker.rememberPrompt(null, "hello");
    expect(tracker.consumeUserMessage("hello, transformed by an input hook")).toBeNull();
  });
});

describe("prompt origin tracker: lifecycle", () => {
  it("expires entries after the TTL", () => {
    const clock = { now: 1_000 };
    const tracker = trackerAt(clock);
    tracker.rememberCommand("/commit");
    clock.now += DEFAULT_PROMPT_ORIGIN_TTL_MS + 1;
    expect(tracker.consumeUserMessage("anything")).toBeNull();
    expect(tracker.pendingCount()).toBe(0);
  });

  it("keeps entries inside the TTL", () => {
    const clock = { now: 1_000 };
    const tracker = trackerAt(clock, 5_000);
    tracker.rememberCommand("/commit");
    clock.now += 4_999;
    expect(tracker.consumeUserMessage("injected")).toBe("/commit");
  });

  it("settle and reset drop every pending origin", () => {
    const tracker = createPromptOriginTracker();
    tracker.rememberCommand("/one");
    tracker.rememberCommand("/two");
    tracker.settle();
    expect(tracker.pendingCount()).toBe(0);

    tracker.rememberCommand("/three");
    tracker.reset();
    expect(tracker.pendingCount()).toBe(0);
  });

  it("forgets exactly one entry when a prompt was rejected", () => {
    const tracker = createPromptOriginTracker();
    const rejected = tracker.rememberPrompt(null, "hello");
    tracker.rememberCommand("/keep");
    tracker.forget(rejected);
    expect(tracker.consumeUserMessage("The user ran /keep…")).toBe("/keep");
  });

  it("bounds the queue and drops the oldest entries", () => {
    const tracker = createPromptOriginTracker();
    for (let index = 0; index < DEFAULT_MAX_PENDING_ORIGINS + 5; index += 1) {
      tracker.rememberCommand(`/command-${index}`);
    }
    expect(tracker.pendingCount()).toBe(DEFAULT_MAX_PENDING_ORIGINS);
    expect(tracker.consumeUserMessage("injected")).toBe("/command-5");
  });

  it("drops unconsumed entries after the idle grace but keeps fresh ones", () => {
    const clock = { now: 1_000 };
    const tracker = trackerAt(clock);
    tracker.rememberCommand("/commit");
    clock.now += DEFAULT_STALE_ORIGIN_GRACE_MS + 1;
    tracker.dropStale();
    expect(tracker.pendingCount()).toBe(0);

    tracker.rememberCommand("/plan");
    clock.now += DEFAULT_STALE_ORIGIN_GRACE_MS - 1;
    tracker.dropStale();
    expect(tracker.consumeUserMessage("The user ran /plan…")).toBe("/plan");
  });

  it("a stale notify-only command cannot label the next command's message", () => {
    const clock = { now: 1_000 };
    const tracker = trackerAt(clock);
    tracker.rememberCommand("/commit");
    clock.now += 5_000;
    tracker.dropStale();
    tracker.rememberCommand("/plan");
    expect(tracker.consumeUserMessage("The user ran /plan…")).toBe("/plan");
  });

  it("ignores an empty command and treats whitespace as no raw origin", () => {
    const tracker = createPromptOriginTracker();
    tracker.rememberPrompt("   ", "hello");
    expect(tracker.consumeUserMessage("hello")).toBeNull();
    expect(tracker.consumeUserMessage("anything else")).toBeNull();
  });
});
