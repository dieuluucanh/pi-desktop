import { splitByPattern } from "./transcript-search";
import { useFindPattern } from "./find-context";

/**
 * `<mark>` highlighting for plain text (pre blocks, notice details, tool
 * args/results — 2026-10-26 session-parity plan step 11).
 *
 * Markdown runs through `rehypeFindHighlight` instead; this covers everything
 * that is rendered as a string.
 */
export function HighlightText({ text }: { text: string }) {
  const pattern = useFindPattern();
  if (!pattern || text.length === 0) return <>{text}</>;
  const parts = splitByPattern(text, pattern);
  if (!parts.some((part) => part.match)) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className="pi-find">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
