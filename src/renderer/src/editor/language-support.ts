/**
 * Lazy CodeMirror language loading.
 *
 * Each official language package is a separate dynamic import, so the editor
 * chunk (and the startup bundle) does not carry grammars the user never opens.
 * Unknown or unsupported languages return an empty extension: plain text is a
 * valid editor state, not an error.
 */

import type { Extension } from "@codemirror/state";
import type { LanguageId } from "../../../shared/languages";

const cache = new Map<LanguageId, Extension>();
const pending = new Map<LanguageId, Promise<Extension>>();

async function load(languageId: LanguageId): Promise<Extension> {
  switch (languageId) {
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "typescriptreact":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
        jsx: true,
      });
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "javascriptreact":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "json":
    case "jsonc":
      return (await import("@codemirror/lang-json")).json();
    case "css":
    case "scss":
    case "less":
      return (await import("@codemirror/lang-css")).css();
    case "html":
    case "vue":
    case "svelte":
      return (await import("@codemirror/lang-html")).html();
    case "markdown":
    case "mdx":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "c":
    case "cpp":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "php":
      return (await import("@codemirror/lang-php")).php();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "xml":
      return (await import("@codemirror/lang-xml")).xml();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "shellscript": {
      const [{ StreamLanguage }, { shell }] = await Promise.all([
        import("@codemirror/language"),
        import("@codemirror/legacy-modes/mode/shell"),
      ]);
      return StreamLanguage.define(shell);
    }
    default:
      return [];
  }
}

/** Returns the language extension, loading it once per language. */
export function languageExtension(languageId: LanguageId): Promise<Extension> {
  const cached = cache.get(languageId);
  if (cached) return Promise.resolve(cached);
  const inFlight = pending.get(languageId);
  if (inFlight) return inFlight;
  const run = load(languageId)
    .then((extension) => {
      cache.set(languageId, extension);
      pending.delete(languageId);
      return extension;
    })
    .catch((error: unknown) => {
      pending.delete(languageId);
      throw error;
    });
  pending.set(languageId, run);
  return run;
}
