/**
 * `#` document completion (plan step 7).
 *
 * Documents are whatever the Office pane has open, which is step 20's registry.
 * The provider is written now, against a small port, for two reasons: the token
 * rules and ranking are testable today, and step 20 only has to supply the
 * registry instead of touching the engine.
 *
 * With no registry (`null`) the provider answers nothing — an empty `#` menu
 * would suggest the feature exists when it does not.
 */

import { fuzzyFilter } from "./fuzzy";
import { tokenAtCursor } from "./token";
import { applyCompletionInPlace, type CompletionItem, type CompletionProvider } from "./types";

export interface DocumentMention {
  id: string;
  name: string;
  kind?: string;
  description?: string;
}

export interface DocumentMentionSource {
  list(): readonly DocumentMention[] | Promise<readonly DocumentMention[]>;
}

export const DEFAULT_DOCUMENT_LIMIT = 25;

export function createDocumentProvider(
  source: DocumentMentionSource | null,
  limit = DEFAULT_DOCUMENT_LIMIT,
): CompletionProvider {
  return {
    id: "office-documents",
    triggerCharacters: ["#"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if (source === null) return null;
      const token = tokenAtCursor(lines, cursorLine, cursorCol);
      const query = token.query;
      if (!query.startsWith("#")) return null;

      const documents = await source.list();
      if (options.signal.aborted) return null;

      const ranked = fuzzyFilter(documents, query.slice(1), (document) => document.name);
      if (ranked.length === 0) return null;
      return { items: ranked.slice(0, limit).map(toItem), prefix: query };
    },
    applyCompletion: applyCompletionInPlace,
  };
}

export function toItem(document: DocumentMention): CompletionItem {
  return {
    value: `#${document.name}`,
    label: `#${document.name}`,
    ...(document.description ? { description: document.description } : {}),
    ...(document.kind ? { detail: document.kind } : {}),
    source: "document",
  };
}
