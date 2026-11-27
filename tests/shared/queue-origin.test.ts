import { describe, expect, it } from "vitest";

import {
  QUEUE_ENTRY_ORIGINS,
  readQueueOriginList,
  type QueueEntryOrigin,
  type QueueOrigins,
} from "../../src/shared/queue-origin";

/**
 * The shared queue-origin contract (2026-11-26 queue-bar plan, step 1).
 *
 * `readQueueOriginList` is the renderer's only reader of the host annotation.
 * Every rule here is fail-open: junk, a missing annotation or a length mismatch
 * must read as the user's own message, never as an extension's.
 */

describe("QUEUE_ENTRY_ORIGINS", () => {
  it("lists both origins, user first", () => {
    expect(QUEUE_ENTRY_ORIGINS).toEqual(["user", "extension"]);
  });

  it("types the entries and the per-queue shape", () => {
    const origins: QueueOrigins = {
      steering: ["user", "extension"],
      followUp: ["extension"],
    };
    const first: QueueEntryOrigin | undefined = origins.steering[0];
    expect(first).toBe("user");
    expect(origins.followUp).toEqual(["extension"]);
  });
});

describe("readQueueOriginList", () => {
  it("maps a valid mixed list positionally", () => {
    expect(readQueueOriginList(["user", "extension", "user"], 3)).toEqual([
      "user",
      "extension",
      "user",
    ]);
    expect(readQueueOriginList(["extension"], 1)).toEqual(["extension"]);
    expect(readQueueOriginList(["user", "user"], 2)).toEqual(["user", "user"]);
  });

  it("defaults every entry to user when the annotation is missing", () => {
    expect(readQueueOriginList(undefined, 2)).toEqual(["user", "user"]);
    expect(readQueueOriginList(undefined, 0)).toEqual([]);
  });

  it("defaults the tail to user when the list is shorter than the queue", () => {
    expect(readQueueOriginList(["extension"], 3)).toEqual(["extension", "user", "user"]);
    expect(readQueueOriginList([], 2)).toEqual(["user", "user"]);
  });

  it("truncates a list longer than the queue", () => {
    expect(readQueueOriginList(["extension", "user", "extension"], 2)).toEqual([
      "extension",
      "user",
    ]);
    expect(readQueueOriginList(["extension"], 0)).toEqual([]);
  });

  it("reads wrong element types as user", () => {
    expect(readQueueOriginList([1, null, "EXTENSION", "exetension"], 4)).toEqual([
      "user",
      "user",
      "user",
      "user",
    ]);
    expect(readQueueOriginList([true, "extension ", " extension", ""], 4)).toEqual([
      "user",
      "user",
      "user",
      "user",
    ]);
    expect(readQueueOriginList([{ origin: "extension" }, ["extension"]], 2)).toEqual([
      "user",
      "user",
    ]);
  });

  it("reads non-array input as all user", () => {
    expect(readQueueOriginList("ext", 1)).toEqual(["user"]);
    expect(readQueueOriginList("extension", 3)).toEqual(["user", "user", "user"]);
    expect(readQueueOriginList({}, 2)).toEqual(["user", "user"]);
    expect(readQueueOriginList({ steering: ["extension"] }, 1)).toEqual(["user"]);
    expect(readQueueOriginList(null, 2)).toEqual(["user", "user"]);
    expect(readQueueOriginList(42, 1)).toEqual(["user"]);
  });

  it("never throws on a sparse array", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(readQueueOriginList(["extension", , "user"], 3)).toEqual(["extension", "user", "user"]);
  });

  it("clamps the count and always returns exactly that many entries", () => {
    expect(readQueueOriginList(["extension"], 0)).toHaveLength(0);
    expect(readQueueOriginList(["extension"], -3)).toEqual([]);
    expect(readQueueOriginList(["extension"], Number.NaN)).toEqual([]);
    expect(readQueueOriginList(["extension"], Number.POSITIVE_INFINITY)).toEqual([]);
    expect(readQueueOriginList(["extension"], 1.9)).toEqual(["extension"]);
    expect(readQueueOriginList(["extension", "extension"], 2.9)).toEqual([
      "extension",
      "extension",
    ]);
    expect(readQueueOriginList(undefined, 5.9)).toHaveLength(5);
  });
});
