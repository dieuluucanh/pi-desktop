/**
 * Providers, credentials and gateways (plan step 9).
 *
 * The app talks to Pi's `ModelRuntime` through this port, so the handlers below
 * are pure and the SDK stays inside `src/host/sdk/*`.
 *
 * **The rule that shapes everything here: a credential never leaves the host.**
 * Pi owns `auth.json` (0600); the app sends a key *in* and reads status *out*.
 * No handler returns a key, no summary carries one, and `tests/host/providers.test.ts`
 * walks every response for key-shaped values — a write-only UI cannot leak what it
 * never receives.
 *
 * Provider classification comes from Pi too: `subscription` vs API key is the
 * runtime's answer (`isUsingSubscription`), not a list the app maintains.
 */

import type { HostMethod } from "../shared/host-protocol";
import type { HostHandler } from "./service";

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

/** The credential surface, implemented by `src/host/sdk/*` against `ModelRuntime`. */
export interface ProviderPort {
  listProviders(): Promise<readonly ProviderDescriptor[]>;
  authStatus(providerId: string): ProviderAuthStatus;
  modelCount(providerId: string): number;
  /**
   * Persists an API key through Pi (its `auth.json`, mode 0600). Pi's `login`
   * with the API-key auth type is the write path for both OAuth and keys, so the
   * app never touches the credential file itself.
   */
  setKey(providerId: string, apiKey: string): Promise<void>;
  /** Removes the persisted credential. */
  logout(providerId: string): Promise<void>;
  /** Runtime-only key: usable now, never written to disk. */
  setRuntimeKey(providerId: string, apiKey: string): Promise<void>;
  clearRuntimeKey(providerId: string): Promise<void>;
  /** Re-reads provider/model catalogs (may touch the network). */
  refresh(): Promise<void>;
  /** Environment lookup for `envVars`, injected so tests need no real env. */
  envHas?(name: string): boolean;
}

/** The control-host methods this module answers (plan step 9). */
export const PROVIDER_METHODS = [
  "providers.list",
  "providers.setKey",
  "providers.logout",
  "providers.runtimeKey",
  "providers.refresh",
] as const satisfies readonly HostMethod[];

/** Matches the shape the host service turns into an error frame. */
export class ProviderError extends Error {
  readonly code: string;

  constructor(message: string, code = "bad_request") {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

/** Longest key accepted; long enough for any real credential, bounded anyway. */
export const MAX_API_KEY_LENGTH = 4096;

/** Normalises one provider into the credential-free summary the UI receives. */
export function summarizeProvider(
  descriptor: ProviderDescriptor,
  status: ProviderAuthStatus,
  modelCount: number,
  envHas: (name: string) => boolean = () => false,
): ProviderSummary {
  const envVars = [...(descriptor.envVars ?? [])];
  return {
    id: descriptor.id,
    label: descriptor.label ?? descriptor.id,
    authTypes: [...(descriptor.authTypes ?? [])],
    subscription: descriptor.subscription === true,
    configured: status.configured === true,
    ...(status.source ? { source: status.source } : {}),
    ...(status.label ? { statusLabel: status.label } : {}),
    modelCount,
    envVars,
    envAvailable: envVars.some((name) => envHas(name)),
  };
}

/** Every provider with its status and model count, ready for the Connections view. */
export async function collectProviders(port: ProviderPort): Promise<ProviderSummary[]> {
  const envHas = port.envHas ?? (() => false);
  const descriptors = await port.listProviders();
  return descriptors
    .filter((descriptor) => typeof descriptor.id === "string" && descriptor.id.length > 0)
    .map((descriptor) =>
      summarizeProvider(
        descriptor,
        port.authStatus(descriptor.id),
        port.modelCount(descriptor.id),
        envHas,
      ),
    )
    .sort((left, right) => left.label.localeCompare(right.label));
}

function requireProviderId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderError("a provider id is required");
  }
  return value.trim();
}

function requireApiKey(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderError("an API key is required");
  }
  const key = value.trim();
  if (key.length > MAX_API_KEY_LENGTH) {
    throw new ProviderError(`an API key may be at most ${MAX_API_KEY_LENGTH} characters`);
  }
  return key;
}

export interface ProviderHandlers {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
}

/**
 * Builds the `providers.*` handlers. The port is resolved lazily and once, so a
 * read-only host can still answer `providers.list` while a host without the port
 * reports that providers are unavailable instead of pretending.
 */
export function createProviderHandlers(
  resolvePort: () => ProviderPort | null,
  now: () => number = Date.now,
): ProviderHandlers {
  const port = (): ProviderPort => {
    const current = resolvePort();
    if (!current) {
      throw new ProviderError("providers are not available in this host", "not_implemented");
    }
    return current;
  };

  const summaryOf = async (providerId: string): Promise<ProviderSummary | null> => {
    const providers = await collectProviders(port());
    return providers.find((provider) => provider.id === providerId) ?? null;
  };

  return {
    handlers: () => ({
      "providers.list": async () => ({
        providers: await collectProviders(port()),
        refreshedAt: now(),
      }),

      "providers.setKey": async (params) => {
        const input = record(params);
        const providerId = requireProviderId(input.providerId ?? input.id);
        // The key is forwarded and dropped: it is never echoed back, logged or
        // stored anywhere the renderer can read.
        await port().setKey(providerId, requireApiKey(input.apiKey));
        return { provider: await summaryOf(providerId) };
      },

      "providers.runtimeKey": async (params) => {
        const input = record(params);
        const providerId = requireProviderId(input.providerId ?? input.id);
        if (input.apiKey === undefined || input.apiKey === null || input.apiKey === "") {
          await port().clearRuntimeKey(providerId);
          return { provider: await summaryOf(providerId), runtime: false };
        }
        await port().setRuntimeKey(providerId, requireApiKey(input.apiKey));
        return { provider: await summaryOf(providerId), runtime: true };
      },

      "providers.logout": async (params) => {
        const providerId = requireProviderId(record(params).providerId ?? record(params).id);
        await port().logout(providerId);
        return { provider: await summaryOf(providerId) };
      },

      "providers.refresh": async () => ({ providers: await collectProviders(port()) }),
    }),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
