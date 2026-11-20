import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareDirectAttachment } from "../../src/attachments/prepare";
import { createAttachmentStore, type AttachmentStore } from "../../src/attachments/store";
import { createAttachmentService } from "../../src/main/attachment-service";
import { createNodeAttachmentStoreIo } from "../../src/main/attachment-store-io";
import {
  createAttachmentDeliveryLeases,
  DELIVERY_LEASE_LIMITS,
  type AttachmentDeliveryLeases,
  type DeliveryContextFence,
} from "../../src/main/attachment-delivery-leases";
import type { SessionHostPin } from "../../src/main/session-service";
import { isAttachmentId } from "../../src/shared/attachments";

const roots: string[] = [];
const managers: AttachmentDeliveryLeases[] = [];
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const digest = async (value: Uint8Array): Promise<string> =>
  createHash("sha256").update(value).digest("hex");
function deferred<T = void>() {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  managers.splice(0).forEach((manager) => manager.dispose());
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  options: {
    store?: (store: AttachmentStore) => AttachmentStore;
    hash?: (value: Uint8Array) => Promise<string>;
    schedule?: (delay: number, callback: () => void) => () => void;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-delivery-leases-"));
  roots.push(root);
  const store = createAttachmentStore({
    profile: "a".repeat(64),
    io: createNodeAttachmentStoreIo({ root }),
    newId: randomUUID,
    now: () => 100,
  });
  const state = {
    profile: true,
    sender: true,
    host: true,
    context: true,
    failRelease: false,
    pins: 0,
  };
  const service = createAttachmentService({
    store,
    authorize: (sender, tab) => state.sender && sender === 10 && tab === "tab-1",
    newId: randomUUID,
    now: () => 100,
    createHash: () => {
      const hash = createHash("sha256");
      return {
        update: (value) => {
          hash.update(value);
        },
        digest: () => hash.digest("hex"),
      };
    },
  });
  const draft = service.openDraft(10, "tab-1");
  const owner = { kind: "draft" as const, id: draft.token };
  const data = bytes("private snapshot");
  const originalId = await store.beginOriginal({
    owner,
    name: "note.txt",
    mimeType: "text/plain",
    size: data.length,
  });
  await store.append(originalId, owner, 0, data);
  await store.commit(originalId, owner, await digest(data));
  const prepared = await prepareDirectAttachment(
    { store, encoder: { prepare: async () => null }, sha256: digest },
    owner,
    originalId,
  );
  if (prepared.status !== "ready") throw new Error("fixture preparation failed");
  const release = vi.fn();
  const acquire = vi.fn((): SessionHostPin => {
    if (!state.host) throw new Error("host unavailable");
    state.pins++;
    let released = false;
    return {
      tabId: "tab-1",
      generation: 7,
      processGeneration: 3,
      sessionId: "session-1",
      sessionEpoch: 2,
      isCurrent: () => !released && state.host,
      request: async () => ({}),
      release: () => {
        release();
        if (state.failRelease) throw new Error("native secret error");
        if (released) return;
        released = true;
        state.pins--;
      },
    };
  });
  const notice = vi.fn();
  const manager = createAttachmentDeliveryLeases({
    profileKey: "a".repeat(64),
    drafts: service,
    sessions: { pinSessionHost: acquire },
    store: options.store?.(store) ?? store,
    newAuthorityId: () => "123e4567-e89b-42d3-a456-426614174001",
    profileCurrent: () => state.profile,
    now: () => Date.now(),
    sha256: options.hash ?? digest,
    schedule:
      options.schedule ??
      ((delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      }),
    onCleanupFailure: notice,
  });
  managers.push(manager);
  const context: DeliveryContextFence = {
    sessionId: "session-1",
    sessionEpoch: 2,
    branchId: "leaf-1",
    revision: "revision-1",
    isCurrent: () => state.context,
  };
  const input = { senderId: 10, draft, context, representationIds: [prepared.asset.id] };
  return {
    manager,
    input,
    state,
    acquire,
    release,
    notice,
    service,
    store,
    data,
    id: prepared.asset.id,
  };
}

describe("bounded main-only attachment delivery leases", () => {
  it("authenticates the real draft and binds scope to the pinned host/context", async () => {
    const h = await fixture();
    const lease = await h.manager.open(h.input);
    expect(isAttachmentId(lease.id)).toBe(true);
    expect(lease.scope).toMatchObject({
      profileKey: "a".repeat(64),
      tabId: "tab-1",
      draftId: h.input.draft.token,
      hostGeneration: 7,
      processGeneration: 3,
      sessionId: "session-1",
      sessionEpoch: 2,
      branchId: "leaf-1",
      revision: "revision-1",
    });
    expect(Object.isFrozen(lease.scope)).toBe(true);
    expect(await lease.isCurrent()).toBe(true);
    expect(await lease.readChunk(h.id, 0, h.data.length)).toEqual(h.data);
    expect(h.manager.stats()).toMatchObject({
      slots: 1,
      reservedBytes: DELIVERY_LEASE_LIMITS.bytesPerSlot,
    });
    lease.close();
    lease.close();
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.manager.stats().slots).toBe(0);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.authorized()).toBe(false);
  });

  it("rejects forged senders/grants/selectors before acquiring a pin", async () => {
    const h = await fixture();
    for (const input of [
      { ...h.input, senderId: 11 },
      { ...h.input, draft: { ...h.input.draft, token: randomUUID() } },
      { ...h.input, representationIds: ["../outside"] },
      { ...h.input, representationIds: [h.id, h.id] },
      { ...h.input, representationIds: [] },
    ])
      await expect(h.manager.open(input)).rejects.toThrow();
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.manager.stats().slots).toBe(0);
  });

  it("releases a pin after stale context/session or missing ownership prevents setup", async () => {
    const h = await fixture();
    await expect(
      h.manager.open({ ...h.input, context: { ...h.input.context, sessionEpoch: 3 } }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      h.manager.open({ ...h.input, representationIds: [randomUUID()] }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(h.state.pins).toBe(0);
    expect(h.manager.stats().slots).toBe(0);
  });

  it.each(["profile", "sender", "host", "context"] as const)(
    "permanently revokes on %s invalidation",
    async (key) => {
      const h = await fixture();
      const lease = await h.manager.open(h.input);
      h.state[key] = false;
      expect(lease.authorized()).toBe(false);
      h.state[key] = true;
      expect(lease.authorized()).toBe(false);
      expect(await lease.isCurrent()).toBe(false);
      await expect(lease.readChunk(h.id, 0, 1)).rejects.toMatchObject({ code: "unavailable" });
      expect(h.state.pins).toBe(0);
    },
  );

  it("holds bounded global slot/byte reservations, including opening leases", async () => {
    const h = await fixture();
    const a = await h.manager.open(h.input);
    const b = await h.manager.open(h.input);
    expect(h.state.pins).toBe(2);
    await expect(h.manager.open(h.input)).rejects.toMatchObject({ code: "capacity" });
    expect(h.acquire).toHaveBeenCalledTimes(2);
    expect(h.manager.stats().reservedBytes).toBe(
      DELIVERY_LEASE_LIMITS.slots * DELIVERY_LEASE_LIMITS.bytesPerSlot,
    );
    a.close();
    b.close();
    expect(h.manager.stats().reservedBytes).toBe(0);
  });

  it("never renews the hard lifetime deadline through reads or liveness checks", async () => {
    const h = await fixture();
    const lease = await h.manager.open(h.input);
    await vi.advanceTimersByTimeAsync(DELIVERY_LEASE_LIMITS.lifetimeMs - 1);
    expect(lease.authorized()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(lease.authorized()).toBe(false);
    expect(h.state.pins).toBe(0);
    expect(h.manager.stats().slots).toBe(0);
  });

  it("bounds stalled reader setup, retains capacity/pin, and releases only after acquisition drains", async () => {
    const entered = deferred();
    const resume = deferred();
    const h = await fixture({
      store: (store) => ({
        ...store,
        list: async (...args) => {
          entered.resolve();
          await resume.promise;
          return store.list(...args);
        },
      }),
    });
    const opening = h.manager.open(h.input);
    const rejected = expect(opening).rejects.toMatchObject({ code: "unavailable" });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(DELIVERY_LEASE_LIMITS.setupMs);
    await rejected;
    expect(h.manager.stats()).toMatchObject({ slots: 1, draining: 1 });
    expect(h.state.pins).toBe(1);
    expect(h.release).not.toHaveBeenCalled();
    resume.resolve();
    await vi.waitFor(() => expect(h.manager.stats().slots).toBe(0));
    expect(h.state.pins).toBe(0);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each(["close", "timeout", "dispose"] as const)(
    "drains stalled reads before release on %s",
    async (cause) => {
      const entered = deferred();
      const resume = deferred();
      const h = await fixture({
        store: (store) => ({
          ...store,
          readForPreparation: async (...args) => {
            entered.resolve();
            await resume.promise;
            return store.readForPreparation(...args);
          },
        }),
      });
      const lease = await h.manager.open(h.input);
      const reading = lease.readChunk(h.id, 0, h.data.length);
      const rejected = expect(reading).rejects.toMatchObject({ code: "unavailable" });
      await entered.promise;
      if (cause === "close") lease.close();
      else if (cause === "dispose") h.manager.dispose();
      else await vi.advanceTimersByTimeAsync(DELIVERY_LEASE_LIMITS.operationMs);
      await rejected;
      expect(h.manager.stats()).toMatchObject({ slots: 1, draining: 1 });
      expect(h.state.pins).toBe(1);
      expect(h.release).not.toHaveBeenCalled();
      resume.resolve();
      await vi.waitFor(() => expect(h.manager.stats().slots).toBe(0));
      expect(h.state.pins).toBe(0);
      expect(h.release).toHaveBeenCalledOnce();
    },
  );

  it("counts stalled hashing as in-flight work and rejects overlapping reads without losing the first", async () => {
    const entered = deferred();
    const resume = deferred();
    const h = await fixture({
      hash: async (value) => {
        entered.resolve();
        await resume.promise;
        return digest(value);
      },
    });
    const lease = await h.manager.open(h.input);
    const reading = lease.readChunk(h.id, 0, h.data.length);
    await entered.promise;
    await expect(lease.readChunk(h.id, 0, 1)).rejects.toMatchObject({ code: "busy" });
    expect(lease.authorized()).toBe(true);
    resume.resolve();
    expect(await reading).toEqual(h.data);
    lease.close();
    expect(h.state.pins).toBe(0);
  });

  it("retains capacity on cleanup failure and retries/reporting even after disposal", async () => {
    const h = await fixture();
    const lease = await h.manager.open(h.input);
    h.state.failRelease = true;
    lease.close();
    expect(h.manager.stats()).toMatchObject({ slots: 1, cleanupFailed: 1 });
    expect(h.notice).toHaveBeenCalledOnce();
    h.manager.dispose();
    await vi.advanceTimersByTimeAsync(DELIVERY_LEASE_LIMITS.cleanupRetryMs);
    expect(h.state.pins).toBe(1);
    expect(h.notice).toHaveBeenCalledOnce();
    h.state.failRelease = false;
    await vi.advanceTimersByTimeAsync(DELIVERY_LEASE_LIMITS.cleanupRetryMs);
    expect(h.manager.stats()).toMatchObject({ slots: 0, cleanupFailed: 0 });
    expect(h.state.pins).toBe(0);
  });

  it("does not reuse retired identities or let a stale handle affect a subsequent lease", async () => {
    const h = await fixture();
    const ids = new Set<string>();
    const retired = await h.manager.open(h.input);
    retired.close();
    ids.add(retired.id);
    for (let index = 0; index < 20; index++) {
      const lease = await h.manager.open(h.input);
      expect(isAttachmentId(lease.id)).toBe(true);
      expect(ids.has(lease.id)).toBe(false);
      ids.add(lease.id);
      retired.close();
      expect(lease.authorized()).toBe(true);
      expect(h.state.pins).toBe(1);
      lease.close();
    }
    expect(h.manager.stats().slots).toBe(0);
  });

  it("does not strand pending work if operation deadline scheduling throws", async () => {
    let count = 0;
    const h = await fixture({
      schedule: (delay, callback) => {
        if (++count === 2) throw new Error("timer unavailable");
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    });
    await expect(h.manager.open(h.input)).rejects.toMatchObject({ code: "unavailable" });
    expect(h.manager.stats()).toMatchObject({ slots: 0, draining: 0 });
    expect(h.state.pins).toBe(0);
    expect(h.notice).toHaveBeenCalledOnce();
  });

  it("finishes accounting even if cancelling a timer throws; late deadlines cannot revoke completed work", async () => {
    const h = await fixture({
      schedule: (delay, callback) => {
        setTimeout(callback, delay);
        return () => {
          throw new Error("cancel unavailable");
        };
      },
    });
    const lease = await h.manager.open(h.input);
    await vi.advanceTimersByTimeAsync(DELIVERY_LEASE_LIMITS.setupMs + 1);
    expect(lease.authorized()).toBe(true);
    lease.close();
    expect(h.manager.stats()).toMatchObject({ slots: 0, draining: 0 });
    expect(h.state.pins).toBe(0);
    await vi.advanceTimersByTimeAsync(DELIVERY_LEASE_LIMITS.lifetimeMs);
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.notice).toHaveBeenCalledOnce();
  });

  it("permits explicit cleanup recovery if retry scheduling itself is unavailable", async () => {
    let count = 0;
    const h = await fixture({
      schedule: (delay, callback) => {
        if (++count === 3) throw new Error("retry timer unavailable");
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    });
    const lease = await h.manager.open(h.input);
    h.state.failRelease = true;
    expect(() => lease.close()).not.toThrow();
    expect(h.manager.stats()).toMatchObject({ slots: 1, cleanupFailed: 1 });
    h.state.failRelease = false;
    h.manager.retryCleanup();
    expect(h.manager.stats().slots).toBe(0);
    expect(h.state.pins).toBe(0);
  });

  it.each(["timeout", "dispose"] as const)(
    "retains the pin until stalled hashing drains on %s",
    async (cause) => {
      const entered = deferred();
      const resume = deferred();
      const h = await fixture({
        hash: async (value) => {
          entered.resolve();
          await resume.promise;
          return digest(value);
        },
      });
      const lease = await h.manager.open(h.input);
      const rejected = expect(lease.readChunk(h.id, 0, h.data.length)).rejects.toMatchObject({
        code: "unavailable",
      });
      await entered.promise;
      if (cause === "dispose") h.manager.dispose();
      else await vi.advanceTimersByTimeAsync(DELIVERY_LEASE_LIMITS.operationMs);
      await rejected;
      expect(h.manager.stats()).toMatchObject({ slots: 1, draining: 1 });
      expect(h.state.pins).toBe(1);
      resume.resolve();
      await vi.waitFor(() => expect(h.manager.stats().slots).toBe(0));
      expect(h.release).toHaveBeenCalledOnce();
    },
  );

  it("drains a stalled manifest verification before freeing capacity", async () => {
    const entered = deferred();
    const resume = deferred();
    let stalled = false;
    const h = await fixture({
      store: (store) => ({
        ...store,
        list: async (...args) => {
          if (stalled) {
            entered.resolve();
            await resume.promise;
          }
          return store.list(...args);
        },
      }),
    });
    const lease = await h.manager.open(h.input);
    stalled = true;
    const verifying = lease.isCurrent();
    await entered.promise;
    lease.close();
    expect(await verifying).toBe(false);
    expect(h.manager.stats()).toMatchObject({ slots: 1, draining: 1 });
    expect(h.release).not.toHaveBeenCalled();
    resume.resolve();
    await vi.waitFor(() => expect(h.manager.stats().slots).toBe(0));
  });

  it("counts two stalled acquisitions against the global cap and permits fresh issuance only after draining", async () => {
    const resume = deferred();
    const entered = deferred();
    let count = 0;
    let stalled = true;
    const h = await fixture({
      store: (store) => ({
        ...store,
        list: async (...args) => {
          if (stalled) {
            if (++count === 2) entered.resolve();
            await resume.promise;
          }
          return store.list(...args);
        },
      }),
    });
    const first = expect(h.manager.open(h.input)).rejects.toMatchObject({ code: "unavailable" });
    const second = expect(h.manager.open(h.input)).rejects.toMatchObject({ code: "unavailable" });
    await entered.promise;
    await expect(h.manager.open(h.input)).rejects.toMatchObject({ code: "capacity" });
    expect(h.state.pins).toBe(2);
    await vi.advanceTimersByTimeAsync(DELIVERY_LEASE_LIMITS.setupMs);
    await Promise.all([first, second]);
    expect(h.manager.stats()).toMatchObject({ slots: 2, draining: 2 });
    await expect(h.manager.open(h.input)).rejects.toMatchObject({ code: "capacity" });
    stalled = false;
    resume.resolve();
    await vi.waitFor(() => expect(h.manager.stats().slots).toBe(0));
    const next = await h.manager.open(h.input);
    expect(next.authorized()).toBe(true);
    next.close();
  });

  it.each(["profile", "sender", "host", "context"] as const)(
    "cannot revive a stalled read after observed %s revocation",
    async (key) => {
      const entered = deferred();
      const resume = deferred();
      const h = await fixture({
        hash: async (value) => {
          entered.resolve();
          await resume.promise;
          return digest(value);
        },
      });
      const lease = await h.manager.open(h.input);
      const rejected = expect(lease.readChunk(h.id, 0, h.data.length)).rejects.toMatchObject({
        code: "unavailable",
      });
      await entered.promise;
      h.state[key] = false;
      expect(lease.authorized()).toBe(false);
      h.state[key] = true;
      await rejected;
      expect(h.state.pins).toBe(1);
      resume.resolve();
      await vi.waitFor(() => expect(h.manager.stats().slots).toBe(0));
      expect(lease.authorized()).toBe(false);
    },
  );

  it("snapshots selectors but rejects mutation of the trusted context binding", async () => {
    const h = await fixture();
    const context = { ...h.input.context };
    const lease = await h.manager.open({ ...h.input, context });
    context.revision = "another-revision";
    expect(lease.authorized()).toBe(false);
    context.revision = "revision-1";
    expect(lease.authorized()).toBe(false);
    expect(h.state.pins).toBe(0);
  });

  it("does not reopen a disposed authority", async () => {
    const h = await fixture();
    h.manager.dispose();
    await expect(h.manager.open(h.input)).rejects.toMatchObject({ code: "unavailable" });
    expect(h.acquire).not.toHaveBeenCalled();
  });
});
