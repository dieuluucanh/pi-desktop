/**
 * Session-less text generation on the control host (2026-11-25 plan, step 16).
 *
 * The commit-message generator is the app's first model call that is not bound
 * to a session: it runs here, through `ModelCompletionPort` (implemented over
 * Pi's `ModelRuntime.completeSimple` in `src/host/sdk/providers.ts`), with no
 * `AgentSession`, no JSONL and no extension. That is why these handlers live in
 * the control core and why this module imports no SDK type.
 *
 * Three rules shape the module:
 *
 * - **Every failure has a code.** `bad_request`, `not_implemented`, `no_model`,
 *   `unknown_model`, `aborted`, `timeout` and `provider_error` are what the
 *   renderer branches on, so a provider that answers with an error value never
 *   looks like an empty commit message.
 * - **A generation is never replayed.** Each request carries a `requestId`, owns
 *   one `AbortController` and is aborted by `text.cancel` or the timeout; the
 *   request is deliberately absent from the session service's passive/retry
 *   sets, so a dropped frame cannot start a second model call.
 * - **The handlers always exist.** A control host without the port still
 *   registers `text.*` and answers `not_implemented`, which is what keeps
 *   `roles.test.ts`'s "handlers == CONTROL_METHODS" invariant true.
 */

import type { HostMethod } from "../shared/host-protocol";
import {
  DEFAULT_OUTPUT_TOKENS,
  resolveCatalogueDefault,
  sameModelRef,
  sanitizeTextGenerationRequest,
  type ModelChoice,
  type TextGenerationResult,
} from "../shared/text-generation";
import { ProviderError, type ModelCompletionPort } from "./providers";
import type { SettingsPort } from "./settings";
import type { HostHandler } from "./service";

/** The methods this module answers. Declared in `HOST_METHODS` (step 13). */
export const TEXT_GENERATION_METHODS = [
  "text.models",
  "text.generate",
  "text.cancel",
] as const satisfies readonly HostMethod[];

/**
 * How long one generation may run before the host aborts it. The session
 * service's request timeout is longer (120 s) so the host's own `timeout` code
 * wins over a transport-level refusal.
 */
export const GENERATION_TIMEOUT_MS = 90_000;

/** Matches the shape the host service turns into an error frame. */
export class TextGenerationError extends Error {
  readonly code: string;

  constructor(message: string, code = "bad_request") {
    super(message);
    this.name = "TextGenerationError";
    this.code = code;
  }
}

export interface TextGenerationDeps {
  /** The one-shot port, resolved lazily so a host can start without one. */
  resolvePort(): ModelCompletionPort | null;
  /** Settings scopes, for the saved default model (`text.models`). */
  settings: SettingsPort;
  /** Overrides `GENERATION_TIMEOUT_MS` (tests use a few milliseconds). */
  timeoutMs?: number;
}

export interface TextGenerationHandlers {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** True for a DOM-style abort and for Pi's own `aborted` code. */
function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const named = (error as { name?: unknown }).name;
  const coded = (error as { code?: unknown }).code;
  return named === "AbortError" || coded === "aborted";
}

/**
 * Maps whatever the port rejected with onto a `TextGenerationError`.
 *
 * Provider codes (`unknown_model`, `aborted`, …) pass through unchanged so the
 * renderer sees one vocabulary; an unknown failure is a `provider_error`, never
 * a bare `host_error`.
 */
function generationError(
  error: unknown,
  timedOut: boolean,
  timeoutMs: number,
): TextGenerationError {
  if (timedOut) {
    return new TextGenerationError(`generation timed out after ${timeoutMs} ms`, "timeout");
  }
  if (error instanceof TextGenerationError) return error;
  const message = error instanceof Error ? error.message : "text generation failed";
  if (isAbort(error)) return new TextGenerationError("generation was aborted", "aborted");
  if (error instanceof ProviderError) return new TextGenerationError(message, error.code);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) {
    return new TextGenerationError(message, code);
  }
  return new TextGenerationError(message, "provider_error");
}

/**
 * Builds the `text.*` handlers. In-flight generations are tracked by
 * `requestId` so `text.cancel` can reach one without knowing its cwd or model.
 */
export function createTextGenerationHandlers(deps: TextGenerationDeps): TextGenerationHandlers {
  const controllers = new Map<string, AbortController>();
  const timeoutMs = deps.timeoutMs ?? GENERATION_TIMEOUT_MS;

  const port = (): ModelCompletionPort => {
    const current = deps.resolvePort();
    if (!current) {
      throw new TextGenerationError(
        "text generation is not available in this host",
        "not_implemented",
      );
    }
    return current;
  };

  /** The catalogue row the result names; a copy, never the port's own object. */
  const copyChoice = (model: ModelChoice): ModelChoice => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
  });

  return {
    handlers: () => ({
      "text.models": async (params) => {
        const current = port();
        const input = record(params);
        const cwd =
          typeof input.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd.trim() : null;
        const models = (await current.availableModels()).map(copyChoice);
        const scopes = await deps.settings.read(cwd);
        // `defaultAvailable: false` is reported rather than hidden: the picker
        // has to explain a saved default the catalogue cannot resolve.
        return { models, ...resolveCatalogueDefault(scopes, models) };
      },

      "text.generate": async (params) => {
        const request = sanitizeTextGenerationRequest(params);
        if (!request) {
          throw new TextGenerationError(
            "text.generate requires a requestId, a system prompt, a prompt and a valid maxTokens",
            "bad_request",
          );
        }
        const current = port();
        const models = (await current.availableModels()).map(copyChoice);
        const scopes = await deps.settings.read(request.cwd ?? null);
        const resolved = resolveCatalogueDefault(scopes, models);

        // Explicit pick first (verified against the catalogue so the model we
        // name in the result is one the host can actually call), then the saved
        // default while it is available, then the first catalogue row (D12).
        const pickModel = (): ModelChoice | null => {
          const requested = request.model;
          if (requested) {
            const match = models.find((entry) => sameModelRef(entry, requested));
            if (!match) {
              throw new TextGenerationError(
                `unknown model ${requested.provider}/${requested.id}`,
                "unknown_model",
              );
            }
            return match;
          }
          if (resolved.defaultModel && resolved.defaultAvailable) {
            return resolved.defaultModel;
          }
          return models[0] ?? null;
        };
        const model = pickModel();
        if (!model) {
          throw new TextGenerationError(
            "no model is available for text generation; configure a provider first",
            "no_model",
          );
        }

        const controller = new AbortController();
        controllers.set(request.requestId, controller);
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        // The host process can still exit while a generation is in flight.
        timer.unref?.();

        try {
          const result = await current.complete({
            model: { provider: model.provider, id: model.id },
            system: request.system,
            prompt: request.prompt,
            maxTokens: request.maxTokens ?? DEFAULT_OUTPUT_TOKENS,
            signal: controller.signal,
          });
          if (result.text.trim().length === 0) {
            // Defence in depth: the SDK adapter already refuses an empty reply,
            // but a port is an injected dependency and the renderer must never
            // receive a "successful" empty message.
            throw new TextGenerationError("the model returned no text", "provider_error");
          }
          const output: TextGenerationResult = {
            requestId: request.requestId,
            text: result.text,
            model,
            ...(result.usage ? { usage: result.usage } : {}),
          };
          return output;
        } catch (error) {
          throw generationError(error, timedOut, timeoutMs);
        } finally {
          clearTimeout(timer);
          controllers.delete(request.requestId);
        }
      },

      "text.cancel": async (params) => {
        const requestId = record(params).requestId;
        if (typeof requestId === "string") {
          controllers.get(requestId)?.abort();
          controllers.delete(requestId);
        }
        // Idempotent by design: cancelling an unknown or already-finished
        // request is a no-op, not an error.
        return { ok: true };
      },
    }),
  };
}
