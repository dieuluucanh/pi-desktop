import { describe, expect, it, vi } from "vitest";
import {
  createProviderLoginHandlers,
  DEFAULT_LOGIN_TIMEOUT_MS,
} from "../../src/host/provider-login";
import type {
  ProviderAuthEvent,
  ProviderAuthInteraction,
  ProviderPort,
} from "../../src/host/providers";
import { PROVIDER_LOGIN_EVENT, type ProviderLoginEvent } from "../../src/shared/providers";
import type { HostMethod } from "../../src/shared/host-protocol";

/**
 * Provider login bridge (plan step 9, slice 3).
 *
 * The contract: `providers.login` returns immediately (a 30 s supervisor
 * timeout must never cancel a browser round trip), progress arrives as
 * `providers.login` events, prompts arrive as `oi.request` and are answered
 * through the same pending-request registry, and `providers.cancel` aborts.
 */

function harness(options: { loginOAuth?: ProviderPort["loginOAuth"]; timeoutMs?: number } = {}) {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const requests: Array<{ method: string; params?: unknown }> = [];
  const pendingPrompts = new Map<string, (value: unknown) => void>();
  const port: ProviderPort = {
    listProviders: async () => [{ id: "claude-max", label: "Claude Max", authTypes: ["oauth"] }],
    authStatus: () => ({ configured: false }),
    modelCount: () => 3,
    setKey: async () => undefined,
    logout: async () => undefined,
    setRuntimeKey: async () => undefined,
    clearRuntimeKey: async () => undefined,
    refresh: async () => undefined,
    ...(options.loginOAuth ? { loginOAuth: options.loginOAuth } : {}),
  };

  let counter = 0;
  const handlers = createProviderLoginHandlers({
    resolvePort: () => port,
    emit: (event, payload) =>
      emitted.push({ event, ...(payload === undefined ? {} : { payload }) }),
    request: (method, params) => {
      const id = `ui-${++counter}`;
      requests.push({ method, params });
      return new Promise((resolve) => {
        pendingPrompts.set(id, resolve);
      });
    },
    newId: () => `login-${++counter}`,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const call = async (method: HostMethod, params?: unknown): Promise<unknown> => {
    const handler = handlers.handlers()[method];
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params, {
      method,
      requestId: 1,
      emit: () => {},
      readBlob: async () => null,
    });
  };
  const phases = (): ProviderLoginEvent[] =>
    emitted
      .filter((entry) => entry.event === PROVIDER_LOGIN_EVENT)
      .map((entry) => entry.payload as ProviderLoginEvent);
  return { handlers, emitted, requests, pendingPrompts, call, phases };
}

describe("providers.login", () => {
  it("returns a loginId immediately and reports progress then done", async () => {
    const loginOAuth = vi.fn(async (_providerId: string, interaction: ProviderAuthInteraction) => {
      interaction.notify({ type: "progress", message: "Opening browser" });
    });
    const { call, phases } = harness({ loginOAuth });

    const started = (await call("providers.login", { providerId: "claude-max" })) as {
      loginId: string;
      providerId: string;
    };
    expect(started).toMatchObject({ providerId: "claude-max" });
    expect(typeof started.loginId).toBe("string");

    await vi.waitFor(() => expect(phases().some((event) => event.phase === "done")).toBe(true));
    expect(phases().map((event) => event.phase)).toEqual(["started", "progress", "done"]);
    const progress = phases().find((event) => event.phase === "progress");
    expect(progress?.phase === "progress" ? progress.event : null).toMatchObject({
      type: "progress",
      message: "Opening browser",
    });
  });

  it("carries the auth URL and the device code as progress events", async () => {
    const loginOAuth = vi.fn(async (_providerId: string, interaction: ProviderAuthInteraction) => {
      interaction.notify({ type: "auth_url", url: "https://example.test/oauth" });
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://example.test/device",
      });
    });
    const { call, phases } = harness({ loginOAuth });
    await call("providers.login", { providerId: "claude-max" });
    await vi.waitFor(() => expect(phases().some((event) => event.phase === "done")).toBe(true));

    const events = phases()
      .filter((event) => event.phase === "progress")
      .map((event) => (event.phase === "progress" ? event.event : null)) as ProviderAuthEvent[];
    expect(events).toEqual([
      { type: "auth_url", url: "https://example.test/oauth" },
      {
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://example.test/device",
      },
    ]);
  });

  it("routes a prompt through the request registry", async () => {
    let answered: string | null = null;
    const loginOAuth = vi.fn(async (_providerId: string, interaction: ProviderAuthInteraction) => {
      answered = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
    });
    const { call, requests, pendingPrompts, phases } = harness({ loginOAuth });
    await call("providers.login", { providerId: "claude-max" });

    await vi.waitFor(() => expect(pendingPrompts.size).toBe(1));
    expect(requests[0]?.method).toBe("input");
    expect(requests[0]?.params).toMatchObject({
      source: "provider-login",
      providerId: "claude-max",
      prompt: { type: "manual_code", message: "Paste the code" },
    });

    const resolve = [...pendingPrompts.values()][0]!;
    resolve("code-42");
    await vi.waitFor(() => expect(phases().some((event) => event.phase === "done")).toBe(true));
    expect(answered).toBe("code-42");
  });

  it("treats a dismissed prompt as a cancellation", async () => {
    const loginOAuth = vi.fn(async (_providerId: string, interaction: ProviderAuthInteraction) => {
      await interaction.prompt({ type: "manual_code", message: "Paste the code" });
    });
    const { call, pendingPrompts, phases } = harness({ loginOAuth });
    await call("providers.login", { providerId: "claude-max" });
    await vi.waitFor(() => expect(pendingPrompts.size).toBe(1));
    [...pendingPrompts.values()][0]!(undefined);

    await vi.waitFor(() =>
      expect(phases().some((event) => event.phase === "cancelled")).toBe(true),
    );
  });

  it("reports a failure without leaking anything", async () => {
    const loginOAuth = vi.fn(async () => {
      throw new Error("token exchange failed");
    });
    const { call, phases } = harness({ loginOAuth });
    await call("providers.login", { providerId: "claude-max" });
    await vi.waitFor(() => expect(phases().some((event) => event.phase === "error")).toBe(true));
    const error = phases().find((event) => event.phase === "error");
    expect(error).toMatchObject({ phase: "error", message: "token exchange failed" });
  });

  it("aborts the flow on providers.cancel", async () => {
    let aborted = false;
    const loginOAuth = vi.fn(
      (_providerId: string, interaction: ProviderAuthInteraction) =>
        new Promise<void>((_resolve, reject) => {
          interaction.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const { call, phases } = harness({ loginOAuth });
    const started = (await call("providers.login", { providerId: "claude-max" })) as {
      loginId: string;
    };

    const result = (await call("providers.cancel", { loginId: started.loginId })) as {
      cancelled: boolean;
    };
    expect(result.cancelled).toBe(true);
    await vi.waitFor(() => expect(aborted).toBe(true));
    await vi.waitFor(() =>
      expect(phases().some((event) => event.phase === "cancelled")).toBe(true),
    );
    // Cancelling an unknown id is a no-op, not an error.
    expect(await call("providers.cancel", { loginId: "nope" })).toEqual({ cancelled: false });
  });

  it("aborts after the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const loginOAuth = vi.fn(
        (_providerId: string, interaction: ProviderAuthInteraction) =>
          new Promise<void>((_resolve, reject) => {
            interaction.signal?.addEventListener("abort", () => reject(new Error("timeout")));
          }),
      );
      const { call, phases } = harness({ loginOAuth, timeoutMs: 1_000 });
      await call("providers.login", { providerId: "claude-max" });
      vi.advanceTimersByTime(1_001);
      await vi.waitFor(() =>
        expect(phases().some((event) => event.phase === "cancelled")).toBe(true),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a provider without an OAuth flow and a bad request", async () => {
    const { call } = harness();
    await expect(call("providers.login", { providerId: "claude-max" })).rejects.toMatchObject({
      code: "no_oauth_login",
    });
    await expect(call("providers.login", {})).rejects.toMatchObject({ code: "bad_request" });
    await expect(call("providers.cancel", {})).rejects.toMatchObject({ code: "bad_request" });
  });

  it("disposes in-flight logins", async () => {
    const loginOAuth = vi.fn(
      (_providerId: string, interaction: ProviderAuthInteraction) =>
        new Promise<void>((_resolve, reject) => {
          interaction.signal?.addEventListener("abort", () => reject(new Error("disposed")));
        }),
    );
    const { call, handlers, phases } = harness({ loginOAuth });
    await call("providers.login", { providerId: "claude-max" });
    handlers.dispose();
    await vi.waitFor(() =>
      expect(phases().some((event) => event.phase === "cancelled")).toBe(true),
    );
  });

  it("has a timeout long enough for a device flow", () => {
    expect(DEFAULT_LOGIN_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
