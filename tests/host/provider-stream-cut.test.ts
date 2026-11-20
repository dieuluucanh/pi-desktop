/**
 * Pin the exact provider error this repo's recovery logic depends on.
 *
 * Pi's OpenAI-compatible parser throws `Stream ended without finish_reason`
 * when the gateway closes an SSE stream after content but before a terminal
 * `finish_reason`. Review Mode classifies that literal to decide whether to
 * retry on another model. If an SDK upgrade renames the error, recovery must
 * learn the new spelling (or stop matching) instead of silently degrading.
 *
 * This test drives the real `@earendil-works/pi-ai` Chat Completions transport
 * against the fake provider's `cut` step, so the literal is pinned to actual
 * SDK behavior, not to a comment.
 */

import { describe, expect, it } from "vitest";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

import { CUT_ERROR } from "../../scripts/lib/commandcode-probe.mjs";
import { createFakeProvider } from "./fixtures/fake-provider";

function modelFor(baseUrl: string) {
  return {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash (test)",
    api: "openai-completions",
    provider: "command-code",
    baseUrl,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    reasoning: true,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      thinkingFormat: "openai",
      maxTokensField: "max_tokens",
    },
  } as never;
}

const context = {
  systemPrompt: "Return the complete plan.",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Rewrite this plan completely." }],
      timestamp: Date.now(),
    },
  ],
} as never;

describe("provider stream cut", () => {
  it("reports the exact SDK literal when the stream ends without finish_reason", async () => {
    const provider = await createFakeProvider();
    provider.enqueue({ kind: "cut", text: "partial answer" });
    try {
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream(modelFor(provider.baseUrl), context, {
        apiKey: "test-key",
        maxTokens: 128,
      })) {
        events.push(event);
      }

      const failure = events.find((event) => event.type === "error");
      expect(failure).toBeDefined();
      if (failure?.type !== "error") {
        throw new Error("the SDK did not emit an error event");
      }
      expect(failure.error.errorMessage).toBe(CUT_ERROR);
      expect(CUT_ERROR).toBe("Stream ended without finish_reason");
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.path).toBe("/v1/chat/completions");
    } finally {
      await provider.close();
    }
  });
});
