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

import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import {
  MAX_API_KEY_LENGTH,
  ProviderError,
  type ProviderAuthInteraction,
  type ProviderAuthStatus,
  type ProviderDescriptor,
  type ProviderPort,
} from "../providers";

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

    envHas: (name: string): boolean => {
      const value = env[name];
      return typeof value === "string" && value.length > 0;
    },
  };
}
