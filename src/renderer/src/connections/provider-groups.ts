import type { ProviderSummary } from "../../../shared/providers";

/**
 * Grouping and labelling for the Connections view (plan step 9, slice 4).
 *
 * Pure on purpose: the grouping rule and the status labels are what the view
 * asserts in tests, and neither needs a DOM.
 */

export type ProviderGroupId = "subscription" | "apiKey" | "local";

export interface ProviderGroup {
  id: ProviderGroupId;
  label: string;
  description: string;
  providers: ProviderSummary[];
}

/**
 * Local runtimes are recognised by a small, documented id list plus a name
 * match. There is no `local` flag in Pi's provider descriptor, so this is the
 * honest best effort — a provider never lands in the wrong group silently,
 * because the id is shown in the row.
 */
const LOCAL_PROVIDER_IDS = new Set([
  "llama.cpp",
  "ollama",
  "lmstudio",
  "lm-studio",
  "vllm",
  "local",
]);

export function isLocalProvider(provider: ProviderSummary): boolean {
  if (LOCAL_PROVIDER_IDS.has(provider.id)) return true;
  return /\b(llama|ollama|lm ?studio|vllm|localhost|local)\b/i.test(
    `${provider.id} ${provider.label}`,
  );
}

export function providerGroupOf(provider: ProviderSummary): ProviderGroupId {
  if (provider.subscription === true) return "subscription";
  if (isLocalProvider(provider)) return "local";
  return "apiKey";
}

/** Providers grouped for display; empty groups are dropped, order is stable. */
export function groupProviders(providers: readonly ProviderSummary[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [
    {
      id: "subscription",
      label: "Subscriptions",
      description: "Signed in with a plan (OAuth); usage is billed by the provider.",
      providers: [],
    },
    {
      id: "apiKey",
      label: "API keys",
      description: "Paid per token with a key, or detected from an environment variable.",
      providers: [],
    },
    {
      id: "local",
      label: "Local servers",
      description: "Run on this machine; no credential leaves it.",
      providers: [],
    },
  ];
  for (const provider of providers) {
    const group = groups.find((entry) => entry.id === providerGroupOf(provider));
    group?.providers.push(provider);
  }
  return groups.filter((group) => group.providers.length > 0);
}

/** What the row badge says about a provider's credential state. */
export function statusLabel(provider: ProviderSummary): string {
  if (provider.configured) {
    if (provider.source === "stored") return "signed in";
    if (provider.source === "runtime") return "this run only";
    if (provider.source === "environment") return "from environment";
    return provider.statusLabel ?? provider.source ?? "configured";
  }
  if (provider.envAvailable) return "env var set";
  return "not set up";
}

export function statusTone(provider: ProviderSummary): "ok" | "accent" | "neutral" {
  if (provider.configured) return "ok";
  if (provider.envAvailable) return "accent";
  return "neutral";
}

/** Whether the provider can be signed in through a browser (OAuth). */
export function canSignIn(provider: ProviderSummary): boolean {
  return provider.authTypes.includes("oauth");
}

/** Whether the provider accepts an API key written to `auth.json`. */
export function canAddKey(provider: ProviderSummary): boolean {
  return provider.authTypes.includes("api_key") && !isLocalProvider(provider);
}
