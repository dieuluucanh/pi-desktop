/**
 * The control host's session catalog (session browser fix, 2026-11-05).
 *
 * The bug: `session.list` returned full `SessionInfo[]` including
 * `allMessagesText`; once the payload crossed the 1 MiB spill threshold the
 * renderer received `{ $blob }` and showed an empty browser. The catalog keeps
 * the full text in the host for search but only sends a bounded projection.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createSessionCatalog,
  DEFAULT_SESSION_CATALOG_TTL_MS,
} from "../../src/host/session-catalog";
import { BLOB_SPILL_THRESHOLD_BYTES } from "../../src/shared/host-protocol";

function rawSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "C:\\Users\\u\\.pi\\agent\\sessions\\--work--\\s1.jsonl",
    id: "s1",
    cwd: "C:\\work",
    name: "Fix host protocol",
    created: "2026-09-01T10:00:00.000Z",
    modified: "2026-09-02T10:00:00.000Z",
    messageCount: 12,
    firstMessage: "Fix the host protocol",
    allMessagesText: "Fix the host protocol",
    ...overrides,
  };
}

describe("createSessionCatalog", () => {
  it("coalesces concurrent loads and serves the cache within the TTL", async () => {
    let clock = 1_000;
    const loadAll = vi.fn(async () => [rawSession()]);
    const catalog = createSessionCatalog({
      loadAll,
      now: () => clock,
      ttlMs: 10_000,
    });

    const [first, second] = await Promise.all([catalog.page(), catalog.page()]);
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(first.sessions).toHaveLength(1);
    expect(second.sessions).toHaveLength(1);

    clock += DEFAULT_SESSION_CATALOG_TTL_MS;
    await catalog.page();
    expect(loadAll).toHaveBeenCalledTimes(2);
  });

  it("refreshes explicitly even when the cache is fresh", async () => {
    const loadAll = vi.fn(async () => [rawSession()]);
    const catalog = createSessionCatalog({ loadAll, ttlMs: 60_000 });

    await catalog.page();
    await catalog.page({ refresh: true });
    expect(loadAll).toHaveBeenCalledTimes(2);
  });

  it("lets a failed load be retried", async () => {
    const loadAll = vi
      .fn<() => Promise<unknown[]>>()
      .mockRejectedValueOnce(new Error("profile read failed"))
      .mockResolvedValueOnce([rawSession()]);
    const catalog = createSessionCatalog({ loadAll });

    await expect(catalog.page()).rejects.toThrow("profile read failed");
    await expect(catalog.page()).resolves.toMatchObject({ total: 1 });
    expect(loadAll).toHaveBeenCalledTimes(2);
  });

  it("searches the full message text even though the page omits it", async () => {
    const deep = `deep context ${"x".repeat(50_000)} hidden-needle`;
    const loadAll = vi.fn(async () => [
      rawSession({ path: "/p/a.jsonl", id: "a", name: undefined, allMessagesText: "alpha" }),
      rawSession({
        path: "/p/b.jsonl",
        id: "b",
        name: undefined,
        allMessagesText: deep,
      }),
    ]);
    const catalog = createSessionCatalog({ loadAll });

    const page = await catalog.page({ query: "hidden-needle" });
    expect(page.sessions.map((entry) => entry.id)).toEqual(["b"]);
    expect(JSON.stringify(page.sessions)).not.toContain("hidden-needle");
    expect(page.sessions[0]).not.toHaveProperty("allMessagesText");
    expect(page.sessions[0]).not.toHaveProperty("firstMessage");
  });

  it("keeps a large listing below the spill threshold", async () => {
    const sessions = Array.from({ length: 450 }, (_, index) =>
      rawSession({
        path: `/p/s${index}.jsonl`,
        id: `s${index}`,
        name: undefined,
        modified: 10_000 - index,
        allMessagesText: `session ${index} ${"text ".repeat(1_000)}`,
      }),
    );
    const catalog = createSessionCatalog({ loadAll: async () => sessions });

    const page = await catalog.page();
    const serialized = JSON.stringify(page);
    expect(Buffer.byteLength(JSON.stringify(sessions), "utf8")).toBeGreaterThan(
      BLOB_SPILL_THRESHOLD_BYTES,
    );
    expect(page.sessions.length).toBe(450);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(BLOB_SPILL_THRESHOLD_BYTES);
  });

  it("does not retain a listing whose text exceeds the cache budget", async () => {
    let loads = 0;
    const catalog = createSessionCatalog({
      loadAll: async () => {
        loads++;
        return [rawSession({ allMessagesText: "x".repeat(2_000) })];
      },
      maxCachedTextChars: 100,
    });

    await catalog.page();
    await catalog.page();
    expect(loads).toBe(2);
  });

  it("dispose drops the cached listing", async () => {
    const loadAll = vi.fn(async () => [rawSession()]);
    const catalog = createSessionCatalog({ loadAll, ttlMs: 60_000 });

    await catalog.all();
    catalog.dispose();
    await catalog.all();
    expect(loadAll).toHaveBeenCalledTimes(2);
  });
});
