import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A deterministic, OpenAI-compatible provider (plan step 25).
 *
 * The host integration harness and the Playwright-Electron E2E suite both need a
 * model that never touches the network and always answers the same way. Rather
 * than injecting a fake `streamFn` (which `AgentSession` hard-wires to
 * `ModelRuntime.streamSimple`), this is a real HTTP server speaking the Chat
 * Completions SSE wire format: `models.json` points a custom provider at it, and
 * the SDK does the whole request → SSE parse → AgentSession loop for real. Only
 * the bytes are scripted.
 *
 * Responses are queued in order. An empty queue answers `ok`, so a test that does
 * not care about the reply still gets a working session.
 */

export interface FakeUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** One scripted model turn. A tool call can carry leading text. */
export type FakeStep =
  | { kind: "text"; text: string; usage?: FakeUsage }
  /** Streams word-by-word with a pause between chunks, so a test can abort mid-run. */
  | { kind: "slowText"; text: string; delayMs?: number; usage?: FakeUsage }
  | { kind: "thinking"; thinking: string; text?: string; usage?: FakeUsage }
  | {
      kind: "toolCall";
      name: string;
      arguments: Record<string, unknown>;
      id?: string;
      text?: string;
      usage?: FakeUsage;
    }
  /**
   * Streams one tool call whose JSON arguments arrive in many small deltas
   * (plan 2026-11-09 step 29). The 1.4.0 parser re-parsed the accumulated text
   * on every delta, so a large argument froze the stream; 1.5.0 parses each
   * delta once.
   */
  | {
      kind: "streamedToolCall";
      name: string;
      /** Argument JSON, streamed in `chunkSize`-character deltas. */
      arguments: Record<string, unknown>;
      id?: string;
      chunkSize?: number;
      usage?: FakeUsage;
    }
  | { kind: "error"; status: number; message?: string }
  /**
   * Streams optional text and then closes without a terminal `finish_reason`
   * (and without `[DONE]`). This is the gateway cut that Pi reports as
   * `Stream ended without finish_reason`.
   */
  | { kind: "cut"; text?: string; usage?: FakeUsage };

export interface FakeRequest {
  /** The decoded JSON body the SDK sent. */
  body: Record<string, unknown>;
  /** The path the request was made to (always `/v1/chat/completions`). */
  path: string;
}

export interface FakeProvider {
  /** Provider base URL (ends in `/v1`) to write into `models.json`. */
  baseUrl: string;
  /** Every request received, in order — assertions read this. */
  requests: FakeRequest[];
  /** Queue responses for the next requests (in order). */
  enqueue(...steps: FakeStep[]): void;
  /** How many scripted steps are still queued. */
  queued(): number;
  /** Clears the queue and the request log. */
  reset(): void;
  /** Stops the server. */
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function writeChunk(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunk(delta: Record<string, unknown>, finish: string | null, model: string): unknown {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

export async function createFakeProvider(): Promise<FakeProvider> {
  const queue: FakeStep[] = [];
  const requests: FakeRequest[] = [];

  const server: Server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      let body: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
      } catch {
        body = {};
      }
      requests.push({ body, path: request.url ?? "" });

      const step: FakeStep = queue.shift() ?? { kind: "text", text: "ok" };
      const model = typeof body.model === "string" ? body.model : "fake-1";

      if (step.kind === "error") {
        response.writeHead(step.status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: step.message ?? "scripted provider failure", type: "server_error" },
          }),
        );
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      if (step.kind === "cut") {
        if (step.text) {
          for (const word of step.text.split(" ")) {
            writeChunk(response, chunk({ content: `${word} ` }, null, model));
          }
        }
        response.end();
        return;
      }

      if ((step.kind === "thinking" || step.kind === "toolCall") && step.text) {
        for (const word of step.text.split(" ")) {
          writeChunk(response, chunk({ content: `${word} ` }, null, model));
        }
      }
      if (step.kind === "thinking") {
        writeChunk(response, chunk({ reasoning_content: step.thinking }, null, model));
      }
      if (step.kind === "text" || step.kind === "slowText") {
        // Word-by-word so the stream is exercised, not one fat delta.
        const words = step.text.split(" ");
        const delay = step.kind === "slowText" ? (step.delayMs ?? 25) : 0;
        for (let index = 0; index < words.length; index += 1) {
          const suffix = index === words.length - 1 ? "" : " ";
          writeChunk(response, chunk({ content: `${words[index]}${suffix}` }, null, model));
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      if (step.kind === "streamedToolCall") {
        const text = JSON.stringify(step.arguments);
        const size = Math.max(1, step.chunkSize ?? 64);
        for (let offset = 0; offset < text.length; offset += size) {
          writeChunk(
            response,
            chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    ...(offset === 0 ? { id: step.id ?? "call_fake_big", type: "function" } : {}),
                    function: {
                      ...(offset === 0 ? { name: step.name } : {}),
                      arguments: text.slice(offset, offset + size),
                    },
                  },
                ],
              },
              null,
              model,
            ),
          );
        }
      }
      if (step.kind === "toolCall") {
        writeChunk(
          response,
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: step.id ?? "call_fake_1",
                  type: "function",
                  function: { name: step.name, arguments: JSON.stringify(step.arguments) },
                },
              ],
            },
            null,
            model,
          ),
        );
      }

      const finish =
        step.kind === "toolCall" || step.kind === "streamedToolCall" ? "tool_calls" : "stop";
      const final: Record<string, unknown> = {
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
      };
      if (step.usage) final.usage = step.usage;
      writeChunk(response, final);
      response.write("data: [DONE]\n\n");
      response.end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fake provider crashed" } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    enqueue: (...steps: FakeStep[]) => {
      queue.push(...steps);
    },
    queued: () => queue.length,
    reset: () => {
      queue.length = 0;
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
