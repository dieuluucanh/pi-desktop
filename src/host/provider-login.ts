/**
 * The provider login bridge (plan step 9, slice 3).
 *
 * Pi owns the OAuth flow; the app owns the browser/tab, the progress display and
 * the prompts. This module connects the two:
 *
 * - `providers.login` **starts** the flow and returns a `loginId` immediately.
 *   It must not block a request: the supervisor's request timeout is 30 s, while
 *   an OAuth round trip (device code, browser approval) legitimately takes
 *   minutes.
 * - Progress is pushed as `providers.login` host events (auth URL, device code,
 *   progress, then `done`/`error`/`cancelled`).
 * - A prompt blocks until the app answers `oi.respond` with the same id — the
 *   same request/response shape as the extension-UI bridge, so the renderer
 *   already has the answer path.
 * - `providers.cancel` aborts an in-flight flow (and a timeout does the same),
 *   so a closed dialog never leaves a login running forever.
 *
 * The credential itself is written by Pi and never returned here.
 */

import { randomUUID } from "node:crypto";
import type { HostMethod } from "../shared/host-protocol";
import { PROVIDER_LOGIN_EVENT, type ProviderLoginEvent } from "../shared/providers";
import { collectProviders, ProviderError, type ProviderPort } from "./providers";
import type { HostHandler } from "./service";

/** The methods this bridge answers (plan step 9). */
export const PROVIDER_LOGIN_METHODS = [
  "providers.login",
  "providers.cancel",
] as const satisfies readonly HostMethod[];

/** Long enough for a device flow, short enough that nothing hangs forever. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;

export interface ProviderLoginHandlerOptions {
  /** Resolves the credential port, or null when this host cannot manage auth. */
  resolvePort(): ProviderPort | null;
  /** Pushes a `providers.login` event to the app. */
  emit(event: string, payload?: unknown): void;
  /** Asks the app a question and resolves with its `oi.respond` answer. */
  request(method: string, params?: unknown): Promise<unknown>;
  newId?: () => string;
  timeoutMs?: number;
}

export interface ProviderLoginHandlers {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
  /** Aborts every in-flight login (host shutdown). */
  dispose(): void;
}

interface ActiveLogin {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function requireProviderId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderError("a provider id is required");
  }
  return value.trim();
}

export function createProviderLoginHandlers(
  options: ProviderLoginHandlerOptions,
): ProviderLoginHandlers {
  const newId = options.newId ?? ((): string => randomUUID());
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const active = new Map<string, ActiveLogin>();

  const emitEvent = (payload: ProviderLoginEvent): void => {
    options.emit(PROVIDER_LOGIN_EVENT, payload);
  };

  const finish = (loginId: string): void => {
    const entry = active.get(loginId);
    if (!entry) return;
    clearTimeout(entry.timer);
    active.delete(loginId);
  };

  const summaryOf = async (port: ProviderPort, providerId: string) => {
    const providers = await collectProviders(port);
    return providers.find((provider) => provider.id === providerId) ?? null;
  };

  const runLogin = async (
    loginId: string,
    providerId: string,
    port: ProviderPort,
    controller: AbortController,
  ): Promise<void> => {
    try {
      await port.loginOAuth?.(providerId, {
        signal: controller.signal,
        notify: (event) => emitEvent({ phase: "progress", loginId, providerId, event }),
        prompt: async (prompt) => {
          const answer = await options.request("input", {
            source: "provider-login",
            loginId,
            providerId,
            prompt,
          });
          if (answer === undefined || answer === null) {
            // Dismissing the dialog cancels the whole flow, not just the prompt:
            // Pi's flow must not keep waiting on a code nobody will enter.
            controller.abort();
            throw new ProviderError("the sign-in dialog was dismissed", "cancelled");
          }
          return typeof answer === "string" ? answer : String(answer);
        },
      });
      emitEvent({
        phase: "done",
        loginId,
        providerId,
        provider: await summaryOf(port, providerId),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        emitEvent({ phase: "cancelled", loginId, providerId });
      } else {
        emitEvent({
          phase: "error",
          loginId,
          providerId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      finish(loginId);
    }
  };

  return {
    handlers: () => ({
      "providers.login": async (params) => {
        const input = record(params);
        const providerId = requireProviderId(input.providerId ?? input.id);
        const type = input.type === "api_key" ? "api_key" : "oauth";
        const port = options.resolvePort();
        if (!port) {
          throw new ProviderError("providers are not available in this host", "not_implemented");
        }
        if (type !== "oauth" || !port.loginOAuth) {
          throw new ProviderError(
            "this provider does not support a browser sign-in; add an API key instead",
            "no_oauth_login",
          );
        }

        const loginId = newId();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
        active.set(loginId, { controller, timer });

        emitEvent({ phase: "started", loginId, providerId });
        // Fire-and-forget: the renderer follows the `providers.login` events.
        void runLogin(loginId, providerId, port, controller);
        return { loginId, providerId };
      },

      "providers.cancel": (params) => {
        const loginId = record(params).loginId;
        if (typeof loginId !== "string" || loginId.length === 0) {
          throw new ProviderError("providers.cancel requires a loginId");
        }
        const entry = active.get(loginId);
        if (!entry) return { cancelled: false };
        entry.controller.abort();
        return { cancelled: true };
      },
    }),

    dispose: () => {
      for (const entry of active.values()) {
        clearTimeout(entry.timer);
        entry.controller.abort();
      }
      active.clear();
    },
  };
}
