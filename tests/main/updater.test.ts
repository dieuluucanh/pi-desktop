import { describe, expect, it } from "vitest";
import { createUpdateService, type UpdatePort } from "../../src/main/updater";
import { initialUpdateState, type UpdateEvent, type UpdateState } from "../../src/shared/updates";

/**
 * The update service (plan step 26) is Electron-free: `electron-updater` is a
 * fake port here, so the policy — "never download without asking", "one check at
 * a time", "a rejected call becomes an error state" — is pinned without a network
 * or an Electron process.
 */

function fakePort() {
  const listeners = new Set<(event: UpdateEvent) => void>();
  const calls: string[] = [];
  let checkImpl: () => void | Promise<void> = () => undefined;
  let installImpl: () => void = () => undefined;

  const port: UpdatePort = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check: () => {
      calls.push("check");
      return checkImpl();
    },
    download: () => {
      calls.push("download");
    },
    install: () => {
      calls.push("install");
      installImpl();
    },
  };

  return {
    port,
    calls,
    emit: (event: UpdateEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
    setCheck: (impl: () => void | Promise<void>) => {
      checkImpl = impl;
    },
    setInstall: (impl: () => void) => {
      installImpl = impl;
    },
    listenerCount: () => listeners.size,
  };
}

function build(options: { supported?: boolean; withPort?: boolean } = {}) {
  const fake = fakePort();
  const changes: UpdateState[] = [];
  const service = createUpdateService({
    port: options.withPort === false ? null : fake.port,
    supported: options.supported ?? true,
    now: () => 123,
    onChange: (state) => changes.push(state),
  });
  return { ...fake, service, changes };
}

describe("createUpdateService (plan step 26)", () => {
  it("reports unsupported without a port and does nothing on a check", async () => {
    const { service, calls } = build({ withPort: false });
    expect(service.state()).toEqual(initialUpdateState(false));
    await service.check();
    expect(service.state().phase).toBe("unsupported");
    expect(calls).toEqual([]);
    expect(service.install()).toBe(false);
  });

  it("reports unsupported when the build has no feed, even with a port", () => {
    const { service, calls } = build({ supported: false });
    expect(service.state().supported).toBe(false);
    void service.check();
    expect(calls).toEqual([]);
  });

  it("subscribes to the port and reflects events", () => {
    const { service, emit, changes, listenerCount } = build();
    expect(listenerCount()).toBe(1);
    emit({ type: "available", version: "1.2.0" });
    expect(service.state()).toMatchObject({ phase: "available", version: "1.2.0" });
    emit({ type: "progress", percent: 40 });
    emit({ type: "downloaded" });
    expect(service.state().phase).toBe("downloaded");
    // One callback per event, in order.
    expect(changes.map((state) => state.phase)).toEqual(["available", "downloading", "downloaded"]);
  });

  it("shows a check immediately, then lets the port's events win", async () => {
    const { service, calls, emit, setCheck } = build();
    setCheck(() => {
      emit({ type: "not-available" });
    });
    await service.check();
    expect(calls).toEqual(["check"]);
    expect(service.state().phase).toBe("up-to-date");
  });

  it("does not start a second check while one is in flight", async () => {
    const calls: string[] = [];
    let release = (): void => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = createUpdateService({
      port: {
        subscribe: () => () => undefined,
        check: () => {
          calls.push("check");
          return pending;
        },
        download: () => undefined,
        install: () => undefined,
      },
      supported: true,
    });
    const first = gate.check();
    void gate.check();
    release();
    await first;
    expect(calls.filter((call) => call === "check")).toHaveLength(1);
  });

  it("maps a rejected check into an error state", async () => {
    const { service, setCheck } = build();
    setCheck(() => Promise.reject(new Error("feed down")));
    await service.check();
    expect(service.state()).toMatchObject({ phase: "error", error: "feed down" });
  });

  it("downloads only through the port and installs only when ready", async () => {
    const { service, calls, emit } = build();
    await service.download();
    expect(calls).toEqual(["download"]);
    // Nothing is downloaded yet, so install is refused.
    expect(service.install()).toBe(false);
    expect(calls).toEqual(["download"]);

    emit({ type: "available", version: "2.0.0" });
    emit({ type: "downloaded" });
    expect(service.install()).toBe(true);
    expect(calls).toEqual(["download", "install"]);
  });

  it("surfaces a failing install instead of throwing", () => {
    const { service, emit, setInstall } = build();
    setInstall(() => {
      throw new Error("installer missing");
    });
    emit({ type: "downloaded", version: "2.0.0" });
    expect(service.install()).toBe(false);
    expect(service.state()).toMatchObject({ phase: "error", error: "installer missing" });
  });

  it("stops forwarding events and callbacks after dispose", () => {
    const { service, emit, changes, listenerCount } = build();
    service.dispose();
    expect(listenerCount()).toBe(0);
    const before = changes.length;
    emit({ type: "available", version: "3.0.0" });
    expect(changes.length).toBe(before);
  });

  it("keeps the injected clock in the state", async () => {
    const { service } = build();
    await service.check();
    expect(service.state().checkedAt).toBe(123);
  });
});
