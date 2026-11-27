/**
 * The `ProviderPort` implementation over Pi's `ModelRuntime` (plan step 9).
 *
 * This is the only place that maps Pi's credential surface onto the app's
 * structural port. The rules it exists to keep:
 *
 * - **Pi owns the credential file.** `auth.json` (0600) is written by the SDK's
 *   `ModelRuntime.login`, never by the app; `setRuntimeApiKey` is the
 *   runtime-only path and is never persisted.
 * - **A key goes in and never comes back.** Everything this adapter returns is
 *   credential-free; the port's consumers already assume that.
 * - **Classification comes from Pi, not a list we maintain.** `subscription`
 *   is the runtime's `isUsingSubscription`, status is `getProviderAuthStatus`.
 *
 * `ModelRuntime.create` runs a local availability pass (no network unless
 * `allowModelNetwork`), which is what fills the environment/status snapshot the
 * Connections view shows.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import {
  MAX_API_KEY_LENGTH,
  ProviderError,
  type ModelCompletionInput,
  type ModelCompletionPort,
  type ProviderAuthInteraction,
  type ProviderAuthStatus,
  type ProviderDescriptor,
  type ProviderPort,
} from "../providers";
import type { ModelChoice } from "../../shared/text-generation";

export interface SdkProviderPortOptions {
  /** The Pi profile directory (`~/.pi/agent`); `auth.json` lives here. */
  agentDir: string;
  /** Overrides the profile's `models.json`; `null` disables custom models. */
  modelsPath?: string | null;
  /** Allow the create-time catalog refresh to use the network (default off). */
  allowModelNetwork?: boolean;
  /** Environment lookup, injected so a test never depends on the real env. */
  env?: Record<string, string | undefined>;
}

/** The provider surface of `ModelRuntime` this adapter uses (kept structural). */
interface RuntimeProviderLike {
  id: string;
  name: string;
  auth: { apiKey?: { login?: unknown }; oauth?: { isSubscription?: boolean } };
}

function authTypesOf(provider: RuntimeProviderLike): string[] {
  const types: string[] = [];
  if (provider.auth.oauth) types.push("oauth");
  if (provider.auth.apiKey) types.push("api_key");
  return types;
}

/** The subset of Pi's `AssistantMessage` this adapter reads (kept structural). */
export interface CompletionMessageLike {
  content: readonly { type: string; text?: string }[];
  stopReason: string;
  errorMessage?: string;
  usage: { input: number; output: number };
}

/**
 * Turns one `AssistantMessage` into a result or a typed error (advisory R5).
 *
 * Pi reports provider failures as *values*, not rejections: auth, quota and
 * rate-limit errors arrive with `stopReason: "error"` and an `errorMessage`, and
 * an aborted request arrives with `stopReason: "aborted"`. Returning the joined
 * text in those cases would hand the caller an empty message and hide the cause,
 * so both become `ProviderError`s with the codes `text-generation.ts` maps.
 *
 * `"length"` is deliberately a success: the text is real, just cut off, and the
 * commit-message cleaner re-caps an over-long subject. `"toolUse"`/`"deferred"`
 * cannot arise from a request with no tools and no deferred option; they fall
 * through to the same success branch as `"stop"`.
 */
export function completionResultFromMessage(message: CompletionMessageLike): {
  text: string;
  usage: { input: number; output: number };
} {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");

  if (message.stopReason === "error") {
    throw new ProviderError(
      message.errorMessage ?? "the provider returned an error",
      "provider_error",
    );
  }
  if (message.stopReason === "aborted") {
    throw new ProviderError("generation was aborted", "aborted");
  }
  if (text.trim().length === 0) {
    throw new ProviderError("the model returned no text", "provider_error");
  }
  return { text, usage: { input: message.usage.input, output: message.usage.output } };
}

function toChoice(model: { provider: string; id: string; name: string }): ModelChoice {
  return { provider: model.provider, id: model.id, name: model.name };
}

/** The `ModelRuntime` members one-shot completion needs (kept structural). */
export interface CompletionRuntimeLike {
  getModel(
    provider: string,
    id: string,
  ): { provider: string; id: string; name: string } | undefined;
  completeSimple(
    model: { provider: string; id: string; name: string },
    context: {
      systemPrompt: string;
      messages: { role: "user"; content: string; timestamp: number }[];
    },
    options: { signal: AbortSignal; maxTokens: number; sessionId: string },
  ): Promise<CompletionMessageLike>;
}

/**
 * Builds the one-shot `complete` implementation over a lazily resolved runtime.
 *
 * **Session invariant.** This is the only place one-shot completion builds
 * request options, and pi-ai reads the request-level conversation id from
 * `options.sessionId` (`ModelRuntime.prepareRequest` → the provider's header and
 * payload builders). The id must therefore be non-empty — an empty one is
 * dropped, which is what makes OpenCode Go/Zen answer HTTP 400
 * `MissingSessionID` — and identical across calls, otherwise provider routing
 * and prompt-cache affinity degrade. One id per port (the default parameter is
 * evaluated once at `createSdkProviderPort` time) gives the whole control-host
 * process a stable conversation.
 *
 * The `x-opencode-session` header is only emitted when pi-ai's `isOpenCode()`
 * holds: provider id exactly `opencode`/`opencode-go`, or a baseUrl whose
 * hostname is exactly `opencode.ai`. A model missing from the vendored catalogue
 * must therefore resolve through an entry that keeps one of those identities —
 * a `models.json` overlay or the refreshed `models-store.json` — or it gets a
 * valid id and no header.
 */
export function createCompletion(
  getRuntime: () => Promise<CompletionRuntimeLike>,
  sessionId: string = randomUUID(),
): ModelCompletionPort["complete"] {
  // A blank id would silently drop the header/payload field, so fall back to a
  // freshly minted one instead of forwarding it.
  const conversationId = sessionId.trim().length > 0 ? sessionId : randomUUID();

  return async (input: ModelCompletionInput) => {
    const runtime = await getRuntime();
    const model = runtime.getModel(input.model.provider, input.model.id);
    if (!model) {
      throw new ProviderError(
        `unknown model ${input.model.provider}/${input.model.id}`,
        "unknown_model",
      );
    }
    const message = await runtime.completeSimple(
      model,
      {
        systemPrompt: input.system,
        messages: [{ role: "user", content: input.prompt, timestamp: Date.now() }],
      },
      { signal: input.signal, maxTokens: input.maxTokens, sessionId: conversationId },
    );
    return completionResultFromMessage(message);
  };
}

/**
 * Answers Pi's api-key login prompts with a key the app already collected.
 *
 * The built-in flows ask one `secret` question ("Enter Anthropic API key"), so a
 * write-only form can satisfy them without ever displaying the key. A provider
 * that needs more (a gateway URL, an account id) cannot be configured from a
 * single text field; it is refused with a pointer to the sign-in flow rather
 * than silently answering with a wrong value.
 */
export function keyOnlyInteraction(apiKey: string): AuthInteraction {
  let consumed = false;
  return {
    prompt: async (prompt: AuthPrompt): Promise<string> => {
      if (prompt.type === "secret" && !consumed) {
        consumed = true;
        return apiKey;
      }
      throw new ProviderError(
        "this provider needs more than an API key; use Sign in instead",
        "needs_interaction",
      );
    },
    notify: (): void => {
      // Login progress is not surfaced for a one-field key write.
    },
  };
}

export function createSdkProviderPort(options: SdkProviderPortOptions): ProviderPort {
  const env = options.env ?? process.env;
  const authPath = join(options.agentDir, "auth.json");
  const modelsPath =
    options.modelsPath === null
      ? null
      : (options.modelsPath ?? join(options.agentDir, "models.json"));

  let runtime: ModelRuntime | null = null;
  let loading: Promise<ModelRuntime> | null = null;

  const ensure = async (): Promise<ModelRuntime> => {
    if (runtime) return runtime;
    loading ??= ModelRuntime.create({
      authPath,
      ...(modelsPath === null ? { modelsPath: null } : { modelsPath }),
      allowModelNetwork: options.allowModelNetwork === true,
    });
    runtime = await loading;
    return runtime;
  };

  /**
   * The runtime after `listProviders()` has awaited it. `authStatus` and
   * `modelCount` are synchronous in the port (slice 1), and `collectProviders`
   * always lists first, so this never races in practice; before then the honest
   * answer is "nothing is configured".
   */
  const loaded = (): ModelRuntime | null => runtime;

  const descriptorOf = (provider: RuntimeProviderLike): ProviderDescriptor => {
    const status = loaded()?.getProviderAuthStatus(provider.id);
    const envVars =
      status?.source === "environment" && typeof status.label === "string" ? [status.label] : [];
    return {
      id: provider.id,
      label: provider.name,
      authTypes: authTypesOf(provider),
      subscription: loaded()?.isUsingSubscription(provider.id) === true,
      envVars,
    };
  };

  return {
    listProviders: async () => {
      const modelRuntime = await ensure();
      return modelRuntime.getProviders().map(descriptorOf);
    },

    authStatus: (providerId: string): ProviderAuthStatus => {
      const status = loaded()?.getProviderAuthStatus(providerId);
      return status ? { ...status } : { configured: false };
    },

    modelCount: (providerId: string): number => loaded()?.getModels(providerId).length ?? 0,

    setKey: async (providerId: string, apiKey: string): Promise<void> => {
      const modelRuntime = await ensure();
      if (apiKey.length > MAX_API_KEY_LENGTH) {
        throw new ProviderError(`an API key may be at most ${MAX_API_KEY_LENGTH} characters`);
      }
      const provider = modelRuntime.getProviders().find((entry) => entry.id === providerId);
      if (!provider) throw new ProviderError(`unknown provider: ${providerId}`, "unknown_provider");
      if (!provider.auth.apiKey?.login) {
        throw new ProviderError(
          `${provider.name} has no API-key login; set its environment variable or sign in with OAuth`,
          "no_api_key_login",
        );
      }
      await modelRuntime.login(providerId, "api_key", keyOnlyInteraction(apiKey));
    },

    logout: async (providerId: string): Promise<void> => {
      const modelRuntime = await ensure();
      await modelRuntime.logout(providerId);
    },

    setRuntimeKey: async (providerId: string, apiKey: string): Promise<void> => {
      const modelRuntime = await ensure();
      await modelRuntime.setRuntimeApiKey(providerId, apiKey);
    },

    clearRuntimeKey: async (providerId: string): Promise<void> => {
      const modelRuntime = await ensure();
      await modelRuntime.removeRuntimeApiKey(providerId);
    },

    refresh: async (): Promise<void> => {
      const modelRuntime = await ensure();
      await modelRuntime.refresh({ force: true });
    },

    loginOAuth: async (providerId: string, interaction: ProviderAuthInteraction): Promise<void> => {
      const modelRuntime = await ensure();
      const provider = modelRuntime.getProviders().find((entry) => entry.id === providerId);
      if (!provider) throw new ProviderError(`unknown provider: ${providerId}`, "unknown_provider");
      if (!provider.auth.oauth) {
        throw new ProviderError(`${provider.name} has no OAuth login`, "no_oauth_login");
      }
      // The interaction mirrors pi-ai's `AuthInteraction`, so it is forwarded as
      // it stands: Pi owns the flow, the app owns its prompts and progress.
      await modelRuntime.login(providerId, "oauth", interaction as AuthInteraction);
    },

    // Session-less one-shot generation (plan step 16): no `AgentSession`, no
    // JSONL, no extension, over the same lazy runtime `providers.*` uses.
    completion: {
      availableModels: async (): Promise<readonly ModelChoice[]> => {
        const modelRuntime = await ensure();
        try {
          // `getAvailable()` awaits the auth/availability pass (advisory R7), so
          // a cold control host does not report a partial catalogue and the
          // "first available" fallback cannot pick an unusable model.
          return (await modelRuntime.getAvailable()).map(toChoice);
        } catch {
          // Offline/expired profiles: Pi's availability pass can throw while the
          // static catalogue is still complete. Showing it keeps the picker
          // usable, and `defaultAvailable` still tells the truth about whether
          // the saved default is in that list.
          return modelRuntime.getModels().map(toChoice);
        }
      },

      complete: createCompletion(ensure),
    },

    envHas: (name: string): boolean => {
      const value = env[name];
      return typeof value === "string" && value.length > 0;
    },
  };
}
