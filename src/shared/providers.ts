/**
 * The provider/credential wire shapes (plan step 9).
 *
 * These live in `src/shared` because both sides need them: the host builds the
 * summaries and login events, and the renderer's Connections view renders them.
 * The host-side implementation (`src/host/providers.ts`) re-exports these so the
 * host keeps one import site, and the renderer never imports a host module.
 */

/** Pi's credential state for one provider (`AuthStatus`). */
export interface ProviderAuthStatus {
  configured: boolean;
  /** `stored` | `runtime` | `environment` | `fallback` | `models_json_key` | … */
  source?: string;
  label?: string;
}

/** A provider as Pi's runtime describes it. */
export interface ProviderDescriptor {
  id: string;
  label?: string;
  /** Credential kinds the provider accepts, e.g. `oauth`, `api_key`. */
  authTypes?: readonly string[];
  /** True for a subscription provider (OAuth) rather than a metered key. */
  subscription?: boolean;
  /** Environment variables that can supply a credential. */
  envVars?: readonly string[];
}

/** Everything the app may know about a provider. Deliberately credential-free. */
export interface ProviderSummary {
  id: string;
  label: string;
  authTypes: string[];
  subscription: boolean;
  configured: boolean;
  source?: string;
  statusLabel?: string;
  modelCount: number;
  envVars: string[];
  /** True when one of `envVars` is set in the host's environment. */
  envAvailable: boolean;
}

/**
 * Pi's login prompts, mirrored structurally so the host modules stay SDK-free
 * (`src/host/sdk/*` converts them). Same shapes as pi-ai's `AuthPrompt`.
 */
export type ProviderAuthPrompt = { signal?: AbortSignal } & (
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }
  | { type: "manual_code"; message: string; placeholder?: string }
);

/** Login progress Pi reports while a flow runs (pi-ai's `AuthEvent`). */
export type ProviderAuthEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

/**
 * What Pi's login flow may ask of the app: a blocking prompt and non-blocking
 * progress. The credential the flow ends with never reaches the app.
 */
export interface ProviderAuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: ProviderAuthPrompt): Promise<string>;
  notify(event: ProviderAuthEvent): void;
}

/** Host event name carrying provider-login lifecycle and progress. */
export const PROVIDER_LOGIN_EVENT = "providers.login";

/**
 * One provider-login lifecycle update. Progress is `phase: "progress"` with the
 * event Pi reported; the terminal phases are `done`, `error` and `cancelled`.
 */
export type ProviderLoginEvent =
  | { phase: "started"; loginId: string; providerId: string }
  | { phase: "progress"; loginId: string; providerId: string; event: ProviderAuthEvent }
  | { phase: "done"; loginId: string; providerId: string; provider: ProviderSummary | null }
  | { phase: "error"; loginId: string; providerId: string; message: string }
  | { phase: "cancelled"; loginId: string; providerId: string };

/** `oi.request` params that carry a provider-login prompt (routed by `source`). */
export interface ProviderLoginPromptRequest {
  source: "provider-login";
  loginId: string;
  providerId: string;
  prompt: ProviderAuthPrompt;
}

/** True for the `oi.request` params shape the provider-login flow sends. */
export function isProviderLoginPrompt(value: unknown): value is ProviderLoginPromptRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.source === "provider-login" && typeof record.loginId === "string";
}
