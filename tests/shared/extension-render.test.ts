import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_PAD,
  isRenderTarget,
  sanitizeMarkdownTransformRequest,
  sanitizeMarkdownTransformResult,
  sanitizeRenderRequest,
  sanitizeRenderedFrame,
} from "../../src/shared/extension-render";

/**
 * The extension-renderer wire model (plan step 18). The renderer is untrusted
 * input on this path (the host runs whatever an extension registered), so the
 * sanitizers are the contract: a malformed request is refused, never rendered.
 */

describe("render targets", () => {
  it("recognises only the three renderer kinds", () => {
    expect(isRenderTarget("message")).toBe(true);
    expect(isRenderTarget("entry")).toBe(true);
    expect(isRenderTarget("tool")).toBe(true);
    expect(isRenderTarget("toolCall")).toBe(false);
    expect(isRenderTarget(null)).toBe(false);
  });
});

describe("sanitizeRenderRequest", () => {
  it("keeps a well-formed tool request and forwards the raw args/result", () => {
    const args = { command: "npm test" };
    const result = { content: [{ type: "text", text: "ok" }] };
    const request = sanitizeRenderRequest({
      target: "tool",
      type: "bash",
      toolCallId: "t1",
      width: 80,
      expanded: true,
      isPartial: true,
      args,
      result,
    });
    expect(request).toMatchObject({
      target: "tool",
      type: "bash",
      toolCallId: "t1",
      width: 80,
      expanded: true,
      isPartial: true,
      args,
      result,
    });
  });

  it("defaults expanded to false and drops absent optionals", () => {
    const request = sanitizeRenderRequest({ target: "message", type: "todo", width: 40 });
    expect(request).toEqual({ target: "message", type: "todo", width: 40, expanded: false });
  });

  it("refuses a missing target, type or width", () => {
    expect(sanitizeRenderRequest({ type: "x", width: 10 })).toBeNull();
    expect(sanitizeRenderRequest({ target: "nope", type: "x", width: 10 })).toBeNull();
    expect(sanitizeRenderRequest({ target: "tool", type: "  ", width: 10 })).toBeNull();
    expect(sanitizeRenderRequest({ target: "tool", type: "bash", width: 0 })).toBeNull();
    expect(sanitizeRenderRequest({ target: "tool", type: "bash" })).toBeNull();
    expect(sanitizeRenderRequest(null)).toBeNull();
  });

  it("clamps the width and output pad to their supported ranges", () => {
    expect(sanitizeRenderRequest({ target: "tool", type: "bash", width: 99_999 })?.width).toBe(
      1000,
    );
    expect(
      sanitizeRenderRequest({ target: "message", type: "x", width: 10, outputPad: 99 })?.outputPad,
    ).toBe(20);
    expect(
      sanitizeRenderRequest({ target: "message", type: "x", width: 10 })?.outputPad,
    ).toBeUndefined();
    expect(DEFAULT_OUTPUT_PAD).toBe(1);
  });
});

describe("sanitizeRenderedFrame", () => {
  it("keeps the frame and its lines", () => {
    expect(
      sanitizeRenderedFrame({ rendered: true, width: 80, lines: ["a", "b"], error: "boom" }),
    ).toEqual({ rendered: true, width: 80, lines: ["a", "b"], error: "boom" });
  });

  it("refuses a frame without a rendered flag or width", () => {
    expect(sanitizeRenderedFrame({ width: 80, lines: [] })).toBeNull();
    expect(sanitizeRenderedFrame({ rendered: false })).toBeNull();
  });

  it("caps the number of lines and their length", () => {
    const frame = sanitizeRenderedFrame({
      rendered: true,
      width: 80,
      lines: Array.from({ length: 1500 }, (_, index) => (index === 0 ? "x".repeat(9000) : "line")),
    });
    expect(frame?.lines).toHaveLength(1000);
    expect(frame?.lines[0]).toHaveLength(4000);
  });
});

describe("markdown transform wire", () => {
  it("accepts the three message types and defaults the width", () => {
    expect(
      sanitizeMarkdownTransformRequest({
        text: "# hi",
        messageType: "assistant",
        isStreaming: true,
      }),
    ).toEqual({ text: "# hi", messageType: "assistant", isStreaming: true, width: 80 });
    expect(
      sanitizeMarkdownTransformRequest({ text: "x", messageType: "nope", width: 10 }),
    ).toBeNull();
    expect(sanitizeMarkdownTransformRequest({ messageType: "user" })).toBeNull();
  });

  it("round-trips a transform result", () => {
    expect(sanitizeMarkdownTransformResult({ text: "done", transformed: true })).toEqual({
      text: "done",
      transformed: true,
    });
    expect(sanitizeMarkdownTransformResult({ transformed: true })).toBeNull();
  });
});
