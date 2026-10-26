import { createContext, useContext } from "react";

/**
 * The active transcript-find pattern (2026-10-26 session-parity plan step 11).
 *
 * A context keeps the pattern out of every row component's props: a message,
 * tool card and notice all highlight from the same source, and a find keystroke
 * does not re-create the transcript's prop tree.
 */
export const FindPatternContext = createContext<RegExp | null>(null);

export function useFindPattern(): RegExp | null {
  return useContext(FindPatternContext);
}
