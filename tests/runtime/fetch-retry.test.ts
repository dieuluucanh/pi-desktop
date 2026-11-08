import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { FetchRetryError, fetchWithRetry } from "../../scripts/fetch-retry.mjs";

/**
 * fetch-retry (2026-11-08 release-network-resilience plan, step 3).
 *
 * The v0.8.0 release failed on a single GitHub 504. `scripts/fetch-runtime.mjs`
 * had the same single-shot exposure against nodejs.org, so this helper retries
 * transient statuses and network errors for idempotent requests. The tests use a
 * local HTTP server, never the public internet.
 */

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface TestServer {
  url: string;
  requests: () => number;
  close: () => Promise<void>;
}

async function serve(handler: Handler): Promise<TestServer> {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    requests += 1;
    handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind to a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("fetchWithRetry", () => {
  it("retries a 504 and succeeds on the third attempt", async () => {
    let attempts = 0;
    const server = await serve((_request, response) => {
      attempts += 1;
      if (attempts < 3) {
        response.writeHead(504);
        response.end("gateway");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    try {
      const result = await fetchWithRetry(`${server.url}/artifact`, {
        baseDelayMs: 0,
        jitterMs: 0,
        timeoutMs: 5000,
      });
      expect(result.status).toBe(200);
      expect(await result.text()).toBe("ok");
      expect(attempts).toBe(3);
      expect(server.requests()).toBe(3);
    } finally {
      await server.close();
    }
  });

  it("does not retry a permanent 404", async () => {
    let attempts = 0;
    const server = await serve((_request, response) => {
      attempts += 1;
      response.writeHead(404);
      response.end("missing");
    });
    try {
      const result = await fetchWithRetry(`${server.url}/missing`, {
        baseDelayMs: 0,
        jitterMs: 0,
        timeoutMs: 5000,
      });
      expect(result.status).toBe(404);
      expect(attempts).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("honours Retry-After instead of its own backoff", async () => {
    let attempts = 0;
    const server = await serve((_request, response) => {
      attempts += 1;
      if (attempts === 1) {
        response.writeHead(429, { "retry-after": "0" });
        response.end("slow down");
        return;
      }
      response.writeHead(200);
      response.end("ok");
    });
    try {
      // If the header is ignored, this would wait a full minute and the test
      // would time out instead of returning on the second request.
      const result = await fetchWithRetry(`${server.url}/limited`, {
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
        jitterMs: 0,
        timeoutMs: 5000,
      });
      expect(result.status).toBe(200);
      expect(attempts).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("does not retry a non-idempotent request", async () => {
    let attempts = 0;
    const server = await serve((_request, response) => {
      attempts += 1;
      response.writeHead(504);
      response.end("gateway");
    });
    try {
      const result = await fetchWithRetry(`${server.url}/submit`, {
        method: "POST",
        body: "payload",
        baseDelayMs: 0,
        jitterMs: 0,
        timeoutMs: 5000,
      });
      expect(result.status).toBe(504);
      expect(attempts).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("times out a stalled request instead of hanging the job", async () => {
    let attempts = 0;
    const server = await serve((request, response) => {
      attempts += 1;
      request.on("close", () => response.destroy());
    });
    try {
      const error = await fetchWithRetry(`${server.url}/hang`, {
        attempts: 1,
        baseDelayMs: 0,
        jitterMs: 0,
        timeoutMs: 50,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FetchRetryError);
      expect((error as FetchRetryError).attempts).toBe(1);
      expect(attempts).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("throws a typed error after the attempt budget is exhausted", async () => {
    let attempts = 0;
    const server = await serve((_request, response) => {
      attempts += 1;
      response.writeHead(503);
      response.end("unavailable");
    });
    try {
      const error = await fetchWithRetry(`${server.url}/unavailable`, {
        attempts: 2,
        baseDelayMs: 0,
        jitterMs: 0,
        timeoutMs: 5000,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FetchRetryError);
      expect((error as FetchRetryError).status).toBe(503);
      expect((error as FetchRetryError).attempts).toBe(2);
      expect(attempts).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("rejects an invalid attempt budget before making a request", async () => {
    await expect(fetchWithRetry("http://127.0.0.1:1/", { attempts: 0 })).rejects.toThrow(
      /attempts must be a positive integer/,
    );
  });
});
