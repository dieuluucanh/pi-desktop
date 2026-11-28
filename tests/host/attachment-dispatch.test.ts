import { describe, expect, it } from "vitest";
import { createAttachmentDispatchCoordinator } from "../../src/host/attachment-dispatch";

const turn = (n = 1) => ({
  turnId: `123e4567-e89b-42d3-a456-42661417401${n}`,
  attemptId: `123e4567-e89b-42d3-a456-42661417402${n}`,
});

describe("attachment dispatch coordinator", () => {
  it("starts idle and allows ordinary work", () => {
    const c = createAttachmentDispatchCoordinator();
    expect(c.phase()).toBe("idle");
    expect(c.current()).toBeNull();
    expect(c.blocksConcurrentWork()).toBe(false);
    expect(c.blocksContextMutation()).toBe(false);
  });

  it("admits exactly one dispatch at a time", () => {
    const c = createAttachmentDispatchCoordinator();
    expect(c.beginDispatch(turn(1))).toBe(true);
    expect(c.phase()).toBe("dispatching");
    expect(c.current()).toEqual(turn(1));
    expect(c.blocksConcurrentWork()).toBe(true);
    expect(c.blocksContextMutation()).toBe(true);
    // A second managed send, or a concurrent ordinary prompt, must not start.
    expect(c.beginDispatch(turn(2))).toBe(false);
  });

  it("keeps the fence through acceptance until the run settles", () => {
    const c = createAttachmentDispatchCoordinator();
    c.beginDispatch(turn(1));
    expect(c.accept(turn(2))).toBe(false);
    expect(c.accept(turn(1))).toBe(true);
    expect(c.phase()).toBe("accepted");
    // The run continues, so context/model mutations stay fenced, but a text-only
    // steer is native Pi behavior and is not a second attachment dispatch.
    expect(c.blocksContextMutation()).toBe(true);
    expect(c.blocksConcurrentWork()).toBe(false);
    expect(c.beginDispatch(turn(2))).toBe(false);
    c.settle();
    expect(c.phase()).toBe("idle");
    expect(c.current()).toBeNull();
    expect(c.beginDispatch(turn(2))).toBe(true);
  });

  it("releases only the matching attempt", () => {
    const c = createAttachmentDispatchCoordinator();
    c.beginDispatch(turn(1));
    c.release(turn(2));
    expect(c.phase()).toBe("dispatching");
    c.release(turn(1));
    expect(c.phase()).toBe("idle");
    expect(c.blocksConcurrentWork()).toBe(false);
  });

  it("rejects malformed turns without claiming the slot", () => {
    const c = createAttachmentDispatchCoordinator();
    expect(c.beginDispatch({ turnId: "", attemptId: "x" })).toBe(false);
    expect(c.beginDispatch({ turnId: "x" } as never)).toBe(false);
    expect(c.phase()).toBe("idle");
  });

  it("does not accept a dispatch that was already released", () => {
    const c = createAttachmentDispatchCoordinator();
    c.beginDispatch(turn(1));
    c.release(turn(1));
    expect(c.accept(turn(1))).toBe(false);
    expect(c.phase()).toBe("idle");
  });
});
