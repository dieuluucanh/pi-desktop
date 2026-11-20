/**
 * The host-run extension completion providers (plan step 16).
 *
 * Pi's `ctx.ui.addAutocompleteProvider(factory)` hands the host a *function*
 * that wraps the provider built so far. A function cannot cross the JSONL frame
 * boundary, so the host runs the provider chain and the renderer asks it for the
 * result. That keeps the extension's `factory(current)` semantics intact: the
 * host applies the factories in registration order, with a proxy `current` that
 * returns whatever the renderer's built-in sources produced for this keystroke.
 *
 * The renderer's own `/`, `@` and `#` sources still run first and locally; the
 * host is consulted after them and wins only when it returns suggestions. A
 * `!`/`!!` shell line has no built-in source (the local result is null), but the
 * host is still consulted so an extension can opt into `!` completion just as it
 * can in terminal Pi.
 */

import {
  applyCompletionInPlace,
  type ExtensionCompletionApplyRequest,
  type ExtensionCompletionRequest,
  type ExtensionCompletionResult,
  type ExtensionCompletionSuggestions,
} from "../../../shared/extension-ui";
import { toCompletionSource } from "./command-source";
import type { CompletionProvider } from "./types";

/** The host calls the renderer makes for extension completion. */
export interface ExtensionCompletionBridge {
  suggest(request: ExtensionCompletionRequest): Promise<ExtensionCompletionSuggestions | null>;
  apply(request: ExtensionCompletionApplyRequest): Promise<ExtensionCompletionResult | null>;
}

/**
 * Wraps a built-in provider with the host's extension chain. `getSuggestions`
 * forwards the built-in result as the chain's `current`, so an extension that
 * delegates (the Office bridge does exactly that for anything that is not a `#`
 * mention) still sees the app's `/`, `@` and `#` behaviour.
 */
export function createExtensionCompletionProvider(
  base: CompletionProvider,
  bridge: ExtensionCompletionBridge,
): CompletionProvider {
  return {
    id: "pi-desktop-extension-completion",
    triggerCharacters: ["/", "@", "#"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const local = await base.getSuggestions(lines, cursorLine, cursorCol, options);
      const remote = await bridge.suggest({
        lines,
        cursorLine,
        cursorCol,
        ...(options.force ? { force: true } : {}),
        base: local
          ? {
              prefix: local.prefix,
              items: local.items.map((item) => ({
                value: item.value,
                label: item.label,
                ...(item.description === undefined ? {} : { description: item.description }),
                ...(item.source === undefined ? {} : { source: item.source }),
                ...(item.appendSpace === undefined ? {} : { appendSpace: item.appendSpace }),
              })),
            }
          : null,
      });
      if (!remote) return local;
      return {
        prefix: remote.prefix,
        items: remote.items.map((item) => ({
          ...item,
          // A delegating provider returns the base items unchanged; preserve
          // their provenance and apply semantics. Extension-created items have
          // no source and are treated as extension items.
          source: toCompletionSource(item.source) ?? ("extension" as const),
          remote: true,
        })),
      };
    },
    // The composer prefers the async `apply` (see `ComposerCompletion`); this is
    // the synchronous fallback for a host that cannot answer.
    applyCompletion: applyCompletionInPlace,
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return base.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
