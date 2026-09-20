import { describe, expect, it, vi } from "vitest";
import {
  classifyPackageFailure,
  createPackageHandlers,
  PACKAGE_METHODS,
  PackageError,
  toPackageError,
  UPDATE_ALL_SOURCE,
  type PackagePort,
  type PackageProgressSink,
} from "../../src/host/packages";
import {
  PACKAGES_CHANGED_EVENT,
  PACKAGE_PROGRESS_EVENT,
  type PackageProgressEvent,
  type PackageScope,
  type PackageSummary,
} from "../../src/shared/packages";
import type { HostMethod } from "../../src/shared/host-protocol";

/**
 * The package handlers (plan step 14).
 *
 * The two rules this file exists to pin: a bare name is normalised to `npm:`
 * before it reaches Pi's package manager, and installing/updating is refused
 * unless the caller echoed the exact source it showed the user.
 */

function summary(source: string, scope: PackageScope = "user"): PackageSummary {
  return {
    source,
    name: source.replace(/^npm:/, ""),
    kind: "npm",
    scope,
    filtered: false,
    version: null,
    pinned: false,
    installedPath: null,
    installed: false,
  };
}

interface Recorded {
  calls: Array<{ method: string; args: unknown[] }>;
  emit: (event: string, payload?: unknown) => void;
  events: Array<{ event: string; payload?: unknown }>;
  reloads: Array<string | null>;
}

function fakePort(overrides: Partial<PackagePort> = {}): { port: PackagePort } & Recorded {
  const calls: Recorded["calls"] = [];
  const events: Recorded["events"] = [];
  const reloads: Recorded["reloads"] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const port: PackagePort = {
    list: async () => [summary("npm:installed-pkg")],
    install: async (source: string, target, onProgress?: PackageProgressSink) => {
      record("install")(source, target.scope);
      onProgress?.({ action: "install", phase: "start", source, message: `Installing ${source}…` });
      onProgress?.({ action: "install", phase: "complete", source });
    },
    remove: async (source: string, target) => record("remove")(source, target.scope),
    update: async (source: string | null, target) => record("update")(source, target.scope),
    ...overrides,
  };
  return {
    port,
    calls,
    reloads,
    emit: (event, payload) => events.push({ event, payload }),
    events,
  };
}

async function call(
  handlers: ReturnType<typeof createPackageHandlers>,
  method: string,
  params: unknown,
  recorded: Recorded,
): Promise<unknown> {
  const handler = handlers.handlers()[method as HostMethod];
  if (!handler) throw new Error(`no handler for ${method}`);
  return handler(params, {
    method: method as HostMethod,
    requestId: 1,
    emit: recorded.emit,
    readBlob: async () => null,
  });
}

const CONSENT = { source: "npm:foo", systemAccess: true as const };
const PROJECT = "C:/work/app";

describe("package source failures", () => {
  it("classifies the common npm failures and leaves an unknown one alone", () => {
    expect(classifyPackageFailure("npm ERR! code ENOTFOUND").code).toBe("offline");
    expect(classifyPackageFailure("npm ERR! 404 Not Found - GET /x").code).toBe("not_found");
    expect(classifyPackageFailure("npm ERR! code E401").code).toBe("auth");
    expect(classifyPackageFailure("npm ERR! ERESOLVE unable to resolve").code).toBe(
      "peer_dependency",
    );
    expect(classifyPackageFailure("spawn node ENOENT").code).toBe("runtime_missing");
    expect(classifyPackageFailure("fatal: git not found").code).toBe("git_missing");
    const unknown = classifyPackageFailure("something entirely different");
    expect(unknown.code).toBe("package_failed");
    expect(unknown.hint).toBeNull();
  });

  it("adds a hint to a raw failure and keeps a PackageError intact", () => {
    const wrapped = toPackageError(new Error("npm ERR! code ENOTFOUND"));
    expect(wrapped.code).toBe("offline");
    expect(wrapped.message).toMatch(/offline/);

    const original = new PackageError("already a package error", "consent_required");
    expect(toPackageError(original)).toBe(original);
  });
});

describe("package handlers", () => {
  it("lists through the port with a timestamp", async () => {
    const fake = fakePort();
    const handlers = createPackageHandlers({
      resolvePort: () => fake.port,
      now: () => 1_700_000_000_000,
    });
    const result = (await call(handlers, "packages.list", { cwd: PROJECT }, fake)) as {
      packages: PackageSummary[];
      loadedAt: number;
    };
    expect(result.packages[0]?.source).toBe("npm:installed-pkg");
    expect(result.loadedAt).toBe(1_700_000_000_000);
  });

  it("reports not_implemented when no package manager is configured", async () => {
    const handlers = createPackageHandlers({ resolvePort: () => null });
    await expect(call(handlers, "packages.list", {}, fakePort())).rejects.toMatchObject({
      code: "not_implemented",
    });
  });

  it("normalises a bare name to npm: before installing", async () => {
    const fake = fakePort();
    const handlers = createPackageHandlers({ resolvePort: () => fake.port });
    await call(
      handlers,
      "packages.install",
      {
        source: "@dieulc/workflow",
        scope: "user",
        consent: { source: "npm:@dieulc/workflow", systemAccess: true },
      },
      fake,
    );
    expect(fake.calls).toContainEqual({
      method: "install",
      args: ["npm:@dieulc/workflow", "user"],
    });
  });

  it("refuses project scope without a project folder", async () => {
    const fake = fakePort();
    const handlers = createPackageHandlers({ resolvePort: () => fake.port });
    await expect(
      call(
        handlers,
        "packages.install",
        { source: "npm:foo", scope: "project", consent: CONSENT },
        fake,
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      call(handlers, "packages.remove", { source: "npm:foo", scope: "project" }, fake),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses to install without a matching consent echo", async () => {
    const fake = fakePort();
    const handlers = createPackageHandlers({ resolvePort: () => fake.port });

    await expect(
      call(handlers, "packages.install", { source: "npm:foo", scope: "user" }, fake),
    ).rejects.toMatchObject({ code: "consent_required" });
    await expect(
      call(
        handlers,
        "packages.install",
        { source: "npm:foo", scope: "user", consent: { source: "npm:bar", systemAccess: true } },
        fake,
      ),
    ).rejects.toMatchObject({ code: "consent_required" });
    await expect(
      call(
        handlers,
        "packages.install",
        { source: "npm:foo", scope: "user", consent: { source: "npm:foo" } },
        fake,
      ),
    ).rejects.toMatchObject({ code: "consent_required" });

    expect(fake.calls).toHaveLength(0);
  });

  it("emits progress frames and a packages.changed event on success", async () => {
    const fake = fakePort();
    const handlers = createPackageHandlers({ resolvePort: () => fake.port, newId: () => "op-1" });
    await call(
      handlers,
      "packages.install",
      { source: "npm:foo", scope: "user", consent: CONSENT },
      fake,
    );

    const progress = fake.events.filter((event) => event.event === PACKAGE_PROGRESS_EVENT);
    expect(progress).toHaveLength(2);
    expect(progress[0]?.payload).toMatchObject({
      operationId: "op-1",
      action: "install",
      phase: "start",
      source: "npm:foo",
      percent: 0,
    });
    expect((progress[1]?.payload as PackageProgressEvent).percent).toBe(100);

    const changed = fake.events.find((event) => event.event === PACKAGES_CHANGED_EVENT);
    expect(changed?.payload).toMatchObject({ source: "npm:foo" });
  });

  it("removes without consent but still serialises and re-lists", async () => {
    const fake = fakePort();
    const handlers = createPackageHandlers({ resolvePort: () => fake.port });
    const result = (await call(
      handlers,
      "packages.remove",
      { source: "npm:foo", scope: "project", cwd: PROJECT },
      fake,
    )) as { packages: PackageSummary[] };
    expect(fake.calls).toContainEqual({ method: "remove", args: ["npm:foo", "project"] });
    expect(result.packages).toHaveLength(1);
  });

  it("re-reads the shared settings after a successful mutation", async () => {
    const fake = fakePort();
    const reloads: Array<string | null> = [];
    const handlers = createPackageHandlers({
      resolvePort: () => fake.port,
      reloadSettings: async (cwd) => {
        reloads.push(cwd);
      },
    });
    await call(
      handlers,
      "packages.install",
      { source: "npm:foo", scope: "project", cwd: PROJECT, consent: CONSENT },
      fake,
    );
    expect(reloads).toEqual([PROJECT]);
  });

  it("does not fail the operation when the settings refresh does", async () => {
    const fake = fakePort();
    const handlers = createPackageHandlers({
      resolvePort: () => fake.port,
      reloadSettings: async () => {
        throw new Error("settings are locked");
      },
    });
    await expect(
      call(
        handlers,
        "packages.install",
        { source: "npm:foo", scope: "user", consent: CONSENT },
        fake,
      ),
    ).resolves.toMatchObject({ packages: expect.any(Array) });
  });

  it("requires the '*' consent for update-all and the exact source for one", async () => {
    const fake = fakePort();
    const handlers = createPackageHandlers({ resolvePort: () => fake.port });

    await expect(call(handlers, "packages.update", { scope: "user" }, fake)).rejects.toMatchObject({
      code: "consent_required",
    });
    await call(
      handlers,
      "packages.update",
      { source: "npm:foo", scope: "user", consent: CONSENT },
      fake,
    );
    await call(
      handlers,
      "packages.update",
      { scope: "user", consent: { source: UPDATE_ALL_SOURCE, systemAccess: true } },
      fake,
    );
    expect(fake.calls).toEqual([
      { method: "update", args: ["npm:foo", "user"] },
      { method: "update", args: [null, "user"] },
    ]);
  });

  it("runs two concurrent installs one after the other", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const fake = fakePort({
      install: async (source: string): Promise<void> => {
        order.push(`start:${source}`);
        if (source === "npm:first") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        order.push(`end:${source}`);
      },
    });
    const handlers = createPackageHandlers({ resolvePort: () => fake.port });

    const first = call(
      handlers,
      "packages.install",
      { source: "npm:first", scope: "user", consent: { source: "npm:first", systemAccess: true } },
      fake,
    );
    const second = call(
      handlers,
      "packages.install",
      {
        source: "npm:second",
        scope: "user",
        consent: { source: "npm:second", systemAccess: true },
      },
      fake,
    );
    // Let the queue reach the first install before releasing it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start:npm:first"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "start:npm:first",
      "end:npm:first",
      "start:npm:second",
      "end:npm:second",
    ]);
  });

  it("does not emit packages.changed when the operation fails", async () => {
    const fake = fakePort({
      install: async () => {
        throw new Error("npm ERR! code E401");
      },
    });
    const handlers = createPackageHandlers({ resolvePort: () => fake.port });
    await expect(
      call(
        handlers,
        "packages.install",
        { source: "npm:foo", scope: "user", consent: CONSENT },
        fake,
      ),
    ).rejects.toMatchObject({ code: "auth" });
    expect(fake.events.some((event) => event.event === PACKAGES_CHANGED_EVENT)).toBe(false);
  });

  it("declares the four protocol methods and nothing more", () => {
    const handlers = createPackageHandlers({ resolvePort: () => null });
    expect(Object.keys(handlers.handlers()).sort()).toEqual([...PACKAGE_METHODS].sort());
    expect(vi.isMockFunction(handlers.handlers)).toBe(false);
  });
});
