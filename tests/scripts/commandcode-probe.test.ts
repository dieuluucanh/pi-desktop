/**
 * The Command Code wire probe is a diagnostic script, not app code. Its value
 * is the exact shape of what the gateway did, so these tests pin:
 *  - the request bodies for both wires;
 *  - a clean EOF without `finish_reason` is reported as a CUT, not a success;
 *  - a completed Chat Completions / Responses stream is reported as OK;
 *  - HTTP errors and timeouts are reported, never thrown;
 *  - the auth reader never returns junk.
 *
 * The loopback server keeps the suite offline and deterministic.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  CUT_ERROR,
  buildChatBody,
  buildResponsesBody,
  commandCodeKeyFromAuth,
  defaultPlanText,
  defaultReviewPrompt,
  formatProbeTable,
  runProbe,
  runProbeMatrix,
} from "../../scripts/lib/commandcode-probe.mjs";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

async function startServer(handler: Handler): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("the test server did not bind to a TCP port");
  }
  servers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${address.port}/provider/v1`;
}

function sse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chatCut(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, { choices: [{ delta: { content: "partial" } }] });
  response.write("data: [DONE]\n\n");
  response.end();
}

function chatComplete(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, { choices: [{ delta: { content: "complete" } }] });
  sse(response, { choices: [{ delta: {}, finish_reason: "stop" }] });
  response.write("data: [DONE]\n\n");
  response.end();
}

function responsesCut(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, { type: "response.output_text.delta", delta: "partial" });
  response.end();
}

function responsesComplete(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, { type: "response.output_text.delta", delta: "complete" });
  sse(response, {
    type: "response.completed",
    response: { id: "resp_test", status: "completed" },
  });
  response.end();
}

describe("Command Code probe request bodies", () => {
  it("builds a Chat Completions request with the selected reasoning effort", () => {
    const body = buildChatBody({
      model: "deepseek/deepseek-v4.1-flash",
      prompt: "rewrite the plan",
      thinking: "max",
      maxTokens: 65_536,
    });
    expect(body).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 65_536,
      reasoning_effort: "max",
    });
    expect(body.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "rewrite the plan" },
    ]);
  });

  it("omits reasoning_effort for an explicit off level", () => {
    const body = buildChatBody({
      model: "m",
      prompt: "p",
      thinking: "off",
      maxTokens: 1,
    });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("builds a Responses request with the Responses fields", () => {
    const body = buildResponsesBody({
      model: "deepseek/deepseek-v4.1-flash",
      prompt: "rewrite the plan",
      thinking: "high",
      maxTokens: 32_768,
    });
    expect(body).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      stream: true,
      store: false,
      max_output_tokens: 32_768,
      reasoning: { effort: "high", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    });
    expect(body.input).toEqual([{ role: "user", content: "rewrite the plan" }]);
    expect(body.instructions).toEqual(expect.any(String));
  });
});

describe("Command Code auth reader", () => {
  it("accepts the three provider spellings and both entry shapes", () => {
    expect(commandCodeKeyFromAuth({ "command-code": "a" })).toBe("a");
    expect(commandCodeKeyFromAuth({ commandcode: { key: "b" } })).toBe("b");
    expect(commandCodeKeyFromAuth({ command_code: { apiKey: "c" } })).toBe("c");
    expect(commandCodeKeyFromAuth({ commandcode: { api_key: "d" } })).toBe("d");
    expect(commandCodeKeyFromAuth({ commandcode: "e" })).toBe("e");
  });

  it("returns undefined for absent or malformed entries", () => {
    expect(commandCodeKeyFromAuth(null)).toBeUndefined();
    expect(commandCodeKeyFromAuth({})).toBeUndefined();
    expect(commandCodeKeyFromAuth({ "command-code": { key: "" } })).toBeUndefined();
    expect(commandCodeKeyFromAuth({ "command-code": { key: 42 } })).toBeUndefined();
  });
});

describe("Command Code probe defaults", () => {
  it("uses a plan long enough to exercise a real rewrite", () => {
    const plan = defaultPlanText();
    expect(plan.length).toBeGreaterThan(8_000);
    expect(plan).toContain("## Verification");
    expect(defaultReviewPrompt(plan)).toContain(plan);
  });
});

describe("Command Code probe outcomes", () => {
  it("reports a Chat Completions EOF without finish_reason as a cut", async () => {
    const baseUrl = await startServer(chatCut);
    const result = await runProbe({
      wire: "chat",
      baseUrl,
      apiKey: "test-key",
      model: "test-model",
      prompt: "p",
      maxTokens: 1_024,
      timeoutMs: 2_000,
    });
    expect(result.status).toBe(200);
    expect(result.outcome).toBe("CUT");
    expect(result.cut).toBe(true);
    expect(result.completed).toBe(false);
    expect(result.finishReason).toBeNull();
    expect(result.diagnostic).toBe(CUT_ERROR);
    expect(result.contentChars).toBe("partial".length);
    expect(result.doneMarker).toBe(true);
  });

  it("reports a completed Chat Completions stream as OK", async () => {
    const baseUrl = await startServer(chatComplete);
    const result = await runProbe({
      wire: "chat",
      baseUrl,
      apiKey: "test-key",
      model: "test-model",
      prompt: "p",
      maxTokens: 1_024,
      timeoutMs: 2_000,
    });
    expect(result.outcome).toBe("OK");
    expect(result.ok).toBe(true);
    expect(result.completed).toBe(true);
    expect(result.finishReason).toBe("stop");
    expect(result.diagnostic).toBeNull();
  });

  it("reports a Responses EOF without a terminal event as a cut", async () => {
    const baseUrl = await startServer(responsesCut);
    const result = await runProbe({
      wire: "responses",
      baseUrl,
      apiKey: "test-key",
      model: "test-model",
      prompt: "p",
      maxTokens: 1_024,
      timeoutMs: 2_000,
    });
    expect(result.outcome).toBe("CUT");
    expect(result.cut).toBe(true);
    expect(result.responseCompleted).toBe(false);
    expect(result.diagnostic).toBe(CUT_ERROR);
    expect(result.contentChars).toBe("partial".length);
  });

  it("reports a completed Responses stream as OK", async () => {
    const baseUrl = await startServer(responsesComplete);
    const result = await runProbe({
      wire: "responses",
      baseUrl,
      apiKey: "test-key",
      model: "test-model",
      prompt: "p",
      maxTokens: 1_024,
      timeoutMs: 2_000,
    });
    expect(result.outcome).toBe("OK");
    expect(result.ok).toBe(true);
    expect(result.responseCompleted).toBe(true);
    expect(result.finishReason).toBe("completed");
    expect(result.responseId).toBe("resp_test");
  });

  it("reports an HTTP failure instead of throwing", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "upstream unavailable" } }));
    });
    const result = await runProbe({
      wire: "chat",
      baseUrl,
      apiKey: "test-key",
      model: "test-model",
      prompt: "p",
      maxTokens: 1_024,
      timeoutMs: 2_000,
    });
    expect(result.outcome).toBe("ERROR");
    expect(result.status).toBe(502);
    expect(result.error).toContain("HTTP 502");
  });

  it("reports a timeout instead of hanging", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": waiting\n\n");
    });
    const result = await runProbe({
      wire: "chat",
      baseUrl,
      apiKey: "test-key",
      model: "test-model",
      prompt: "p",
      maxTokens: 1_024,
      timeoutMs: 100,
    });
    expect(result.outcome).toBe("ERROR");
    expect(result.error).toMatch(/timed out|abort/i);
  });
});

describe("Command Code probe matrix and table", () => {
  it("runs both wires and renders the outcome table", async () => {
    const baseUrl = await startServer((request, response) => {
      if (request.url?.endsWith("/responses")) responsesComplete(request, response);
      else chatComplete(request, response);
    });
    const results = await runProbeMatrix({
      wire: "chat",
      wires: ["chat", "responses"],
      thinkings: ["high"],
      maxTokensList: [1_024],
      runs: 1,
      baseUrl,
      apiKey: "test-key",
      model: "test-model",
      prompt: "p",
      timeoutMs: 2_000,
    });
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.outcome)).toEqual(["OK", "OK"]);
    const table = formatProbeTable(results);
    expect(table).toContain("wire");
    expect(table).toContain("outcome");
    expect(table).toContain("OK");
  });
});
