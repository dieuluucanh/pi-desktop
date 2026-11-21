import { describe, expect, it, vi } from "vitest";
import {
  createRelatedSessionService,
  isWithinRoot,
  type RelatedSessionPort,
} from "../../src/main/related-sessions";

/**
 * Main-process related-session policy (orchestrator step 12): the parent comes
 * from the host subscription, the child stays inside the project, and request
 * ids/dedupe keys make retries safe.
 */

const PARENT = "tab-parent";

function bootstrap() {
  return [
    {
      customType: "workflow-managed-session" as const,
      content: '{"version":1}',
      display: false,
    },
  ];
}

function createRequest(over: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    operation: "create",
    ownerCommand: "workflow",
    ownerKey: "C:/profile/extensions/workflow/index.ts",
    spec: {
      requestId: "req-1",
      parentSessionRef: "parent-session",
      relation: "child",
      title: "Task 2",
      cwd: "C:/work/app",
      dedupeKey: "task-2",
      bootstrap: bootstrap(),
    },
    ...over,
  };
}

function harness(over: Partial<RelatedSessionPort> = {}) {
  const port: RelatedSessionPort = {
    parent: () => ({ cwd: "C:/work/app" }),
    create: vi.fn(async () => ({ sessionRef: "tab-child" })),
    focus: vi.fn(async () => true),
    inspect: vi.fn(async () => ({ title: "Task 2", running: false })),
    interrupt: vi.fn(async () => true),
    close: vi.fn(async () => true),
    ownerOf: (ref) => (ref === "tab-child" ? PARENT : null),
    ...over,
  };
  const service = createRelatedSessionService({ port, caseInsensitive: true });
  return { port, service };
}

describe("isWithinRoot", () => {
  it("handles Windows and POSIX separators, roots and escapes", () => {
    expect(isWithinRoot("C:\\work\\app\\sub", "C:/work/app", true)).toBe(true);
    expect(isWithinRoot("C:/work/app", "C:/work/app", true)).toBe(true);
    expect(isWithinRoot("C:/work/app-other", "C:/work/app", true)).toBe(false);
    expect(isWithinRoot("/work/app/sub", "/work/app", false)).toBe(true);
    expect(isWithinRoot("/WORK/app", "/work/app", false)).toBe(false);
    expect(isWithinRoot("/", "/work/app", false)).toBe(false);
  });
});

describe("related-session create", () => {
  it("creates a normal tab inside the parent project", async () => {
    const { port, service } = harness();
    const result = await service.handle(createRequest(), PARENT);

    expect(result).toMatchObject({ ok: true, sessionRef: "tab-child", reused: false });
    expect(port.create).toHaveBeenCalledWith({
      cwd: "C:/work/app",
      title: "Task 2",
      parentTabId: PARENT,
      relation: "child",
      dedupeKey: "task-2",
      bootstrap: bootstrap(),
    });
  });

  it("reuses a session for the same parent + dedupe key and focuses it", async () => {
    const { port, service } = harness();
    await service.handle(createRequest(), PARENT);

    const again = await service.handle(
      createRequest({ requestId: "req-2", spec: { ...createRequest().spec, dedupeKey: "task-2" } }),
      PARENT,
    );
    expect(again).toMatchObject({ ok: true, sessionRef: "tab-child", reused: true });
    expect(port.create).toHaveBeenCalledTimes(1);
    expect(port.focus).toHaveBeenCalledWith("tab-child");
  });

  it("is idempotent per request id even with a different dedupe key", async () => {
    const { port, service } = harness();
    await service.handle(createRequest(), PARENT);
    const replay = await service.handle(
      createRequest({ spec: { ...createRequest().spec, dedupeKey: "another" } }),
      PARENT,
    );

    expect(replay).toMatchObject({ ok: true, sessionRef: "tab-child" });
    expect(port.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a child outside the parent project before creating anything", async () => {
    const { port, service } = harness();
    const result = await service.handle(
      createRequest({ spec: { ...createRequest().spec, cwd: "C:/somewhere/else" } }),
      PARENT,
    );

    expect(result).toMatchObject({ ok: false, code: "rejected" });
    expect(port.create).not.toHaveBeenCalled();
  });

  it("refuses a request that did not come through a source-bound owner", async () => {
    const { port, service } = harness();
    const result = await service.handle(createRequest({ ownerKey: "" }), PARENT);

    expect(result).toMatchObject({ ok: false, code: "rejected" });
    expect(port.create).not.toHaveBeenCalled();
  });

  it("refuses a closed parent", async () => {
    const { service } = harness({ parent: () => null });
    const result = await service.handle(createRequest(), PARENT);
    expect(result).toMatchObject({ ok: false, code: "rejected" });
  });
});

describe("related-session navigation and lifecycle", () => {
  it("refuses to touch a session another parent created", async () => {
    const { port, service } = harness({ ownerOf: () => "tab-other" });
    for (const operation of ["open", "focus", "inspect", "interrupt", "close"]) {
      const result = await service.handle(
        {
          requestId: `req-${operation}`,
          operation,
          ownerCommand: "workflow",
          ownerKey: "x",
          sessionRef: "tab-child",
        },
        PARENT,
      );
      expect(result, operation).toMatchObject({ ok: false, code: "rejected" });
    }
    expect(port.close).not.toHaveBeenCalled();
  });

  it("focuses, inspects, interrupts and closes its own child", async () => {
    const { port, service } = harness();
    const base = { ownerCommand: "workflow", ownerKey: "x", sessionRef: "tab-child" };

    await expect(
      service.handle({ ...base, requestId: "f", operation: "focus" }, PARENT),
    ).resolves.toMatchObject({ ok: true, focused: true });
    await expect(
      service.handle({ ...base, requestId: "i", operation: "inspect" }, PARENT),
    ).resolves.toMatchObject({ ok: true, title: "Task 2", running: false });
    await expect(
      service.handle({ ...base, requestId: "x", operation: "interrupt" }, PARENT),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      service.handle({ ...base, requestId: "c", operation: "close" }, PARENT),
    ).resolves.toMatchObject({ ok: true });

    expect(port.focus).toHaveBeenCalledWith("tab-child");
    expect(port.interrupt).toHaveBeenCalledWith("tab-child");
    expect(port.close).toHaveBeenCalledWith("tab-child");
  });

  it("forgets dedupe state when the parent closes", async () => {
    const { port, service } = harness();
    await service.handle(createRequest(), PARENT);
    service.forget(PARENT);
    await service.handle(createRequest({ requestId: "req-2" }), PARENT);
    expect(port.create).toHaveBeenCalledTimes(2);
  });
});
