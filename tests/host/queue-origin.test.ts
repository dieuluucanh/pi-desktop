import { describe, expect, it } from "vitest";
import {
  createQueueOriginTracker,
  DEFAULT_MAX_QUEUED_ORIGINS,
  DEFAULT_QUEUE_ORIGIN_TTL_MS,
} from "../../src/host/queue-origin";

const MINUTE = 60_000;

/** A tracker driven by a mutable clock, so TTL tests never sleep. */
function trackerAt(clock: { now: number }, options: { ttlMs?: number; maxTexts?: number } = {}) {
  return createQueueOriginTracker({
    now: () => clock.now,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.maxTexts === undefined ? {} : { maxTexts: options.maxTexts }),
  });
}

describe("queue origin tracker: classification", () => {
  it("marks a claimed text user and an unknown text extension, preserving order and length", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("steering", ["mine"]);

    const origins = tracker.classify(["theirs", "mine", "another"], []);
    expect(origins.steering).toEqual(["extension", "user", "extension"]);
    expect(origins.followUp).toEqual([]);
    expect(origins.steering).toHaveLength(3);
  });

  it("does not consume a claim: a second classify of the same queue still says user", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("followUp", ["mine"]);

    expect(tracker.classify([], ["mine"]).followUp).toEqual(["user"]);
    clock.now += 1_000;
    expect(tracker.classify([], ["mine"]).followUp).toEqual(["user"]);
    expect(tracker.pendingCount()).toBe(1);
  });

  it("refreshes the TTL on observation, so a live claim outlives its original deadline", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("steering", ["mine"]);

    clock.now = 9 * MINUTE;
    expect(tracker.classify(["mine"], []).steering).toEqual(["user"]);

    // 19 minutes after the claim, past the original 10-minute deadline, but
    // only 10 minutes after the observed frame refreshed it.
    clock.now = 19 * MINUTE;
    expect(tracker.classify(["mine"], []).steering).toEqual(["user"]);
  });

  it("prunes a claim only when its queue stops containing the text", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("followUp", ["mine"]);

    expect(tracker.classify([], ["mine"]).followUp).toEqual(["user"]);
    expect(tracker.classify([], []).followUp).toEqual([]);
    expect(tracker.pendingCount()).toBe(0);
    // A later reappearance is not the user's: the earlier claim was pruned.
    expect(tracker.classify([], ["mine"]).followUp).toEqual(["extension"]);
  });

  it("keeps a claim while its own queue still lists the text", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("followUp", ["mine"]);

    // A later frame with the same queue state, plus unrelated steering text.
    const origins = tracker.classify(["other"], ["mine"]);
    expect(origins.followUp).toEqual(["user"]);
    expect(origins.steering).toEqual(["extension"]);
  });
});

describe("queue origin tracker: duplicates", () => {
  it("marks both copies user for two claims of the same text", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("followUp", ["dup"]);
    tracker.claim("followUp", ["dup"]);

    expect(tracker.classify([], ["dup", "dup"]).followUp).toEqual(["user", "user"]);
    expect(tracker.pendingCount()).toBe(2);
  });

  it("clamps the count down after one copy is delivered", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("followUp", ["dup", "dup"]);

    expect(tracker.classify([], ["dup"]).followUp).toEqual(["user"]);
    expect(tracker.pendingCount()).toBe(1);
    expect(tracker.classify([], []).followUp).toEqual([]);
    expect(tracker.pendingCount()).toBe(0);
  });

  it("marks the last occurrence user when one claim sees two copies", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("steering", ["dup"]);

    // The SDK appends: the user's insert is the newest copy.
    expect(tracker.classify(["dup", "dup"], []).steering).toEqual(["extension", "user"]);
  });
});

describe("queue origin tracker: kinds", () => {
  it("never lets a followUp claim mark a steering entry or vice versa", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("followUp", ["x"]);
    expect(tracker.classify(["x"], []).steering).toEqual(["extension"]);

    tracker.claim("steering", ["y"]);
    expect(tracker.classify([], ["y"]).followUp).toEqual(["extension"]);
  });

  it("tracks the same text independently in both kinds", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("steering", ["same"]);
    tracker.claim("followUp", ["same"]);

    expect(tracker.classify(["same"], ["same"])).toEqual({
      steering: ["user"],
      followUp: ["user"],
    });
  });
});

describe("queue origin tracker: bounds", () => {
  it("expires a claim that is never observed after the TTL", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("steering", ["mine"]);
    expect(tracker.pendingCount()).toBe(1);

    clock.now = DEFAULT_QUEUE_ORIGIN_TTL_MS + 1;
    expect(tracker.classify([], []).steering).toEqual([]);
    expect(tracker.pendingCount()).toBe(0);
    expect(tracker.classify(["mine"], []).steering).toEqual(["extension"]);
  });

  it(`drops the oldest text once more than ${DEFAULT_MAX_QUEUED_ORIGINS} are claimed`, () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    const texts = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
    tracker.claim("followUp", texts);
    expect(tracker.pendingCount()).toBe(DEFAULT_MAX_QUEUED_ORIGINS);

    const origins = tracker.classify([], texts).followUp;
    expect(origins[0]).toBe("extension");
    expect(origins.slice(1)).toEqual(texts.slice(1).map(() => "user"));
  });

  it("drops the oldest stamp first when over the cap", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock, { maxTexts: 2 });
    tracker.claim("steering", ["first"]);
    clock.now = 10;
    tracker.claim("steering", ["second"]);
    clock.now = 20;
    tracker.claim("steering", ["third"]);

    expect(tracker.classify(["first", "second", "third"], []).steering).toEqual([
      "extension",
      "user",
      "user",
    ]);
  });

  it("keeps the later insertion on an `at` tie when over the cap", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock, { maxTexts: 1 });
    clock.now = 10;
    tracker.claim("steering", ["first", "second"]);

    expect(tracker.classify(["first", "second"], []).steering).toEqual(["extension", "user"]);
  });
});

describe("queue origin tracker: lifecycle and robustness", () => {
  it("counts claimed copies across kinds and clears on reset", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("steering", ["a", "b"]);
    tracker.claim("followUp", ["b"]);
    expect(tracker.pendingCount()).toBe(3);

    tracker.reset();
    expect(tracker.pendingCount()).toBe(0);
    expect(tracker.classify(["a", "b"], ["b"])).toEqual({
      steering: ["extension", "extension"],
      followUp: ["extension"],
    });
  });

  it("ignores empty strings", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("steering", ["", "mine"]);
    expect(tracker.pendingCount()).toBe(1);
    expect(tracker.classify(["", "mine"], []).steering).toEqual(["extension", "user"]);
  });

  it("treats non-array input as an empty queue and never throws", () => {
    const clock = { now: 0 };
    const tracker = trackerAt(clock);
    tracker.claim("steering", ["mine"]);

    expect(
      tracker.classify(
        undefined as unknown as readonly string[],
        null as unknown as readonly string[],
      ),
    ).toEqual({ steering: [], followUp: [] });
    expect(tracker.pendingCount()).toBe(0);
  });
});
