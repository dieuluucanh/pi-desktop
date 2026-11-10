/**
 * Large streamed tool calls (plan 2026-11-09, step 29).
 *
 * SDK 1.4.0 re-parsed the accumulated argument text on every delta, so a
 * ~200 KB tool call (a long file edit, a big patch) went quadratic: the run
 * stalled and the UI stopped updating. 1.5.0 parses each delta once through
 * `ToolCallArgumentsStream` (`pi-ai/dist/utils/streaming-json.js`).
 *
 * This drives the real Chat Completions transport against the fake provider, so
 * the guard is on SDK behavior, not on a comment: the deltas must arrive, the
 * final call must parse in full, and the whole stream must stay well inside a
 * wall-clock budget that 1.4.0's per-delta re-parse would blow.
 */

import { describe, expect, it } from "vitest";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

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
    reasoning: false,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      thinkingFormat: "openai",
      maxTokensField: "max_tokens",
    },
  } as never;
}

const context = {
  systemPrompt: "Edit the file.",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Write the whole file." }],
      timestamp: Date.now(),
    },
  ],
} as never;

/** ~200 KB of content, so the argument JSON is ~200 KB plus the wrapper keys. */
const CONTENT = "x".repeat(200_000);
const ARGUMENTS = { path: "src/export/csv.ts", content: CONTENT };

describe("large streamed tool calls", () => {
  it("parses a 200 KB argument streamed in many deltas without stalling", async () => {
    const provider = await createFakeProvider();
    provider.enqueue({
      kind: "streamedToolCall",
      name: "write",
      arguments: ARGUMENTS,
      // 512-character deltas → roughly 400 streamed pieces for a 200 KB call.
      chunkSize: 512,
    });

    const started = Date.now();
    const events: AssistantMessageEvent[] = [];
    try {
      for await (const event of stream(modelFor(provider.baseUrl), context, {
        apiKey: "test-key",
        maxTokens: 4096,
      })) {
        events.push(event);
      }
    } finally {
      await provider.close();
    }
    const elapsedMs = Date.now() - started;

    const deltas = events.filter((event) => event.type === "toolcall_delta");
    expect(deltas.length).toBeGreaterThan(300);
    // Every delta is a real increment: a parser that re-emits the whole
    // accumulated text would make the total far larger than the argument JSON.
    const streamed = deltas.reduce(
      (sum, event) => sum + (event.type === "toolcall_delta" ? event.delta.length : 0),
      0,
    );
    expect(streamed).toBe(JSON.stringify(ARGUMENTS).length);

    const ended = events.find((event) => event.type === "toolcall_end");
    expect(ended?.type).toBe("toolcall_end");
    if (ended?.type !== "toolcall_end") throw new Error("no toolcall_end");
    expect(ended.toolCall.name).toBe("write");
    expect(ended.toolCall.argumentsError).toBeUndefined();
    expect(ended.toolCall.arguments).toEqual(ARGUMENTS);
    expect(events.some((event) => event.type === "done")).toBe(true);

    // 1.4.0's quadratic re-parse needed several minutes for this size; 1.5.0
    // finishes in well under a second. 20 s is a generous CI ceiling that still
    // fails loudly if the linear parser regresses.
    expect(elapsedMs).toBeLessThan(20_000);
  }, 60_000);
});
