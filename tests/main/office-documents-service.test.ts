import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOfficeDocumentsService,
  DEFAULT_DOCUMENTS_POLL_MS,
} from "../../src/main/office/documents-service";
import type { FetchLike, VerifyDeps } from "../../src/main/office/verify";
import type { OfficeDocumentsView } from "../../src/shared/office-documents";

/**
 * The live pane registry (plan step 20). It polls the bridge's `/health` and
 * only emits when the projected view actually changed, so a quiet bridge does
 * not wake the renderer every interval.
 */

function healthBody(panes: unknown[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    service: "pi-office-bridge",
    serverVersion: "0.5.0",
    protocolVersion: 3,
    catalogVersion: 3,
    capabilities: ["http-health", "agent-deltas"],
    panes,
    ...overrides,
  });
}

const excelPane = {
  host: "excel",
  document: { id: "url_sha256:aaaa", name: "Book1.xlsx" },
  targetId: "url_sha256:aaaa",
  focused: true,
  visible: true,
  windows: 1,
  ops: ["excel.read_range"],
  lastSeen: 1_000,
};

function scriptedDeps(bodies: readonly (string | Error)[]): {
  deps: VerifyDeps;
  probes: () => number;
} {
  let index = 0;
  let clock = 10_000;
  const fetchImpl: FetchLike = async () => {
    const step = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    if (step instanceof Error) throw step;
    return { ok: true, status: 200, text: async () => step ?? "" };
  };
  return {
    deps: { fetch: fetchImpl, now: () => clock++, sleep: async () => undefined },
    probes: () => index,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createOfficeDocumentsService", () => {
  it("starts unavailable and projects a healthy bridge on refresh", async () => {
    const { deps } = scriptedDeps([healthBody([excelPane])]);
    const seen: OfficeDocumentsView[] = [];
    const service = createOfficeDocumentsService({
      verify: deps,
      now: () => 1_700_000_000_000,
      onView: (view) => seen.push(view),
    });

    expect(service.get().available).toBe(false);
    expect(service.get().panes).toEqual([]);

    const view = await service.refresh();

    expect(view.available).toBe(true);
    expect(view.status).toBe("ok");
    expect(view.port).toBe(38617);
    expect(view.compatibility?.shape).toBe("current");
    expect(view.panes).toHaveLength(1);
    expect(view.panes[0]?.documentName).toBe("Book1.xlsx");
    expect(view.panes[0]?.mention).toBe("Book1.xlsx");
    expect(seen).toHaveLength(1);
  });

  it("reports an unreachable bridge without panes", async () => {
    const { deps } = scriptedDeps([new Error("ECONNREFUSED")]);
    const service = createOfficeDocumentsService({ verify: deps });

    const view = await service.refresh();

    expect(view.available).toBe(false);
    expect(view.status).toBe("unreachable");
    expect(view.panes).toEqual([]);
    expect(view.error).toMatch(/unreachable|ECONNREFUSED/i);
  });

  it("does not trust panes from a different service on the port", async () => {
    const { deps } = scriptedDeps([
      JSON.stringify({ service: "someone-else", panes: [excelPane] }),
    ]);
    const service = createOfficeDocumentsService({ verify: deps });

    const view = await service.refresh();

    expect(view.available).toBe(false);
    expect(view.status).toBe("not-our-bridge");
    expect(view.panes).toEqual([]);
  });

  it("emits only when the registry changed", async () => {
    const { deps } = scriptedDeps([
      healthBody([excelPane]),
      healthBody([excelPane]),
      healthBody([
        excelPane,
        { ...excelPane, host: "word", document: { id: "id-w", name: "Doc.docx" } },
      ]),
    ]);
    const seen: OfficeDocumentsView[] = [];
    const service = createOfficeDocumentsService({
      verify: deps,
      now: () => 1_700_000_000_000,
      onView: (view) => seen.push(view),
    });

    await service.refresh();
    await service.refresh();
    await service.refresh();

    expect(seen).toHaveLength(2);
    expect(seen[1]?.panes).toHaveLength(2);
  });

  it("re-emits when the bridge owner moves between tabs", async () => {
    const ownerA = {
      pid: 11,
      sessionId: "tab-a",
      client: "desktop",
      cwd: "/work/app",
    };
    const body = (owner: unknown): string =>
      healthBody([excelPane], {
        serverVersion: "0.6.0",
        capabilities: ["http-health", "agent-deltas", "manual-lifecycle"],
        owner,
      });
    const { deps } = scriptedDeps([
      body(ownerA),
      body(ownerA),
      body({ ...ownerA, sessionId: "tab-b" }),
    ]);
    const seen: OfficeDocumentsView[] = [];
    const service = createOfficeDocumentsService({
      verify: deps,
      now: () => 1_700_000_000_000,
      onView: (view) => seen.push(view),
    });

    await service.refresh();
    await service.refresh();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.owner?.sessionId).toBe("tab-a");
    expect(seen[0]?.manualLifecycle).toBe(true);

    await service.refresh();
    expect(seen).toHaveLength(2);
    expect(seen[1]?.owner?.sessionId).toBe("tab-b");
  });

  it("polls on its interval and stops cleanly", async () => {
    vi.useFakeTimers();
    const { deps, probes } = scriptedDeps([healthBody([excelPane])]);
    const service = createOfficeDocumentsService({ verify: deps, intervalMs: 1_000 });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(probes()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(probes()).toBe(2);

    service.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probes()).toBe(2);

    service.dispose();
  });

  it("never polls after dispose", async () => {
    vi.useFakeTimers();
    const { deps, probes } = scriptedDeps([healthBody([excelPane])]);
    const service = createOfficeDocumentsService({
      verify: deps,
      intervalMs: DEFAULT_DOCUMENTS_POLL_MS,
    });

    service.dispose();
    service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(probes()).toBe(0);
  });

  it("carries the configured fact through every probe", async () => {
    const { deps } = scriptedDeps([new Error("ECONNREFUSED"), healthBody([excelPane])]);
    const service = createOfficeDocumentsService({
      verify: deps,
      now: () => 1_700_000_000_000,
      configured: () => true,
    });

    // The initial view is built before the first probe and still knows the
    // install fact, so the rail's menu can be present on the first frame.
    expect(service.get().configured).toBe(true);
    expect(service.get().available).toBe(false);

    const down = await service.refresh();
    expect(down.available).toBe(false);
    expect(down.configured).toBe(true);

    const up = await service.refresh();
    expect(up.available).toBe(true);
    expect(up.configured).toBe(true);
  });

  it("re-emits when the configured fact changes even if the payload does not", async () => {
    // The wizard can install the package while the bridge is down, so the
    // signature that gates pushes must include the install fact.
    const { deps } = scriptedDeps([new Error("ECONNREFUSED")]);
    let configured = false;
    const seen: OfficeDocumentsView[] = [];
    const service = createOfficeDocumentsService({
      verify: deps,
      now: () => 1_700_000_000_000,
      configured: () => configured,
      onView: (view) => seen.push(view),
    });

    await service.refresh();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.configured).toBe(false);

    configured = true;
    await service.refresh();

    expect(seen).toHaveLength(2);
    expect(seen[1]?.configured).toBe(true);
    expect(seen[1]?.available).toBe(false);
  });
});
