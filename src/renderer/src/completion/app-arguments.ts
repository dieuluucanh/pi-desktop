/**
 * App-owned argument completions (2026-10-24 command parity plan).
 *
 * Terminal Pi defines argument completers for `/model`, `/thinking` and
 * `/login` in the interactive layer, not on the command object. These are the
 * desktop equivalents. They are pure: the store supplies the current model
 * catalog, thinking levels and provider list.
 *
 * Values are complete replacements for the typed argument prefix and never get
 * an automatic trailing space (`appendSpace: false`), matching the extension
 * command contract.
 */

import type { ProviderSummary } from "../../../shared/providers";
import { findAppCommand } from "./app-commands";
import { fuzzyFilter } from "./fuzzy";
import type { ModelCatalogEntry } from "../session/model-catalog";
import type { CompletionItem } from "./types";

export interface AppArgumentSources {
  models: readonly ModelCatalogEntry[];
  thinkingLevels: readonly string[];
  providers: readonly ProviderSummary[];
}

export function completeModelArgument(
  models: readonly ModelCatalogEntry[],
  prefix: string,
): CompletionItem[] {
  return fuzzyFilter(models, prefix, (entry) => `${entry.provider}/${entry.id} ${entry.label}`).map(
    (entry) => ({
      value: entry.key,
      label: entry.id,
      description: entry.provider,
      source: "app",
      appendSpace: false,
    }),
  );
}

export function completeThinkingArgument(
  levels: readonly string[],
  prefix: string,
): CompletionItem[] {
  return fuzzyFilter(levels, prefix, (level) => level).map((level) => ({
    value: level,
    label: level,
    source: "app",
    appendSpace: false,
  }));
}

export function completeLoginArgument(
  providers: readonly ProviderSummary[],
  prefix: string,
): CompletionItem[] {
  return fuzzyFilter(providers, prefix, (provider) => `${provider.id} ${provider.label}`).map(
    (provider) => ({
      value: provider.id,
      label: provider.id,
      description: provider.label,
      source: "app",
      appendSpace: false,
    }),
  );
}

/**
 * Dispatches by the command's `argumentKind`. Unknown commands and commands
 * without an argument kind return null, so the menu stays closed.
 */
export function appArgumentItems(
  name: string,
  prefix: string,
  sources: AppArgumentSources,
): CompletionItem[] | null {
  const kind = findAppCommand(name)?.argumentKind;
  if (!kind) return null;
  const items =
    kind === "model"
      ? completeModelArgument(sources.models, prefix)
      : kind === "thinking"
        ? completeThinkingArgument(sources.thinkingLevels, prefix)
        : completeLoginArgument(sources.providers, prefix);
  return items.length > 0 ? items : null;
}
