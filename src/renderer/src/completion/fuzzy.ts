/**
 * Fuzzy matching for completion (plan step 7), mirroring `pi-tui`'s
 * `fuzzyMatch`/`fuzzyFilter` semantics so `@` and `/` rank the same way in the
 * desktop app as they do in terminal Pi:
 *
 *  - a query matches when its characters appear **in order**, not necessarily
 *    adjacent; consecutive runs, word-boundary hits and exact matches score better
 *    while gaps and late matches cost; lower score wins;
 *  - `fuzzyFilter` splits the query on whitespace and `/`, and every token must
 *    match — which is what makes `@src/ren` find `src/renderer/app.ts`;
 *  - a query like `png1` also tries the swapped `1png` reading, as Pi does.
 *
 * `tests/completion/fuzzy.test.ts` compares this module against the real
 * `pi-tui` implementation over a corpus, so the two cannot drift silently.
 */

export interface FuzzyMatch {
  matches: boolean;
  score: number;
}

/** Scores one alignment (positions of the matched characters). Lower is better. */
function scorePositions(textLower: string, positions: readonly number[]): number {
  let score = 0;
  let lastMatchIndex = -1;
  let consecutiveMatches = 0;
  for (const index of positions) {
    if (lastMatchIndex === index - 1) {
      consecutiveMatches += 1;
      score -= consecutiveMatches * 5;
    } else {
      consecutiveMatches = 0;
      if (lastMatchIndex >= 0) score += (index - lastMatchIndex - 1) * 2;
    }
    if (index === 0 || /[\s\-_./:]/.test(textLower[index - 1]!)) score -= 10;
    score += index * 0.1;
    lastMatchIndex = index;
  }
  return score;
}

function matchQuery(normalizedQuery: string, textLower: string): FuzzyMatch {
  if (normalizedQuery.length === 0) return { matches: true, score: 0 };
  if (normalizedQuery.length > textLower.length) return { matches: false, score: 0 };

  // Greedy alignment first: each query character at its first occurrence after
  // the previous one (pi-tui 1.5.0 does the same).
  const positions: number[] = [];
  let lastMatchIndex = -1;
  for (const character of normalizedQuery) {
    const index = textLower.indexOf(character, lastMatchIndex + 1);
    if (index === -1) return { matches: false, score: 0 };
    positions.push(index);
    lastMatchIndex = index;
  }

  let score = scorePositions(textLower, positions);
  // The greedy alignment can scatter the query over an earlier, unrelated part
  // of the text ("opus" in "openrouter openrouter/anthropic/claude-opus" reads
  // o, p, u from "openrouter"). Also score every contiguous occurrence and keep
  // the best alignment.
  for (
    let start = textLower.indexOf(normalizedQuery);
    start !== -1;
    start = textLower.indexOf(normalizedQuery, start + 1)
  ) {
    for (let offset = 0; offset < positions.length; offset += 1) {
      positions[offset] = start + offset;
    }
    score = Math.min(score, scorePositions(textLower, positions));
  }

  if (normalizedQuery === textLower) score -= 100;
  return { matches: true, score };
}

/** True when all query characters appear in `text` in order. Lower is better. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  const primary = matchQuery(queryLower, textLower);
  if (primary.matches) return primary;

  // `model3` also reads as `3model`; a single digit/letter transposition is common
  // in versioned names, and Pi's matcher forgives it too.
  const alphaNumeric = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/.exec(queryLower);
  const numericAlpha = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/.exec(queryLower);
  const swapped = alphaNumeric
    ? `${alphaNumeric.groups?.["digits"] ?? ""}${alphaNumeric.groups?.["letters"] ?? ""}`
    : numericAlpha
      ? `${numericAlpha.groups?.["letters"] ?? ""}${numericAlpha.groups?.["digits"] ?? ""}`
      : "";
  if (swapped.length === 0) return primary;

  const swappedMatch = matchQuery(swapped, textLower);
  return swappedMatch.matches ? { matches: true, score: swappedMatch.score + 5 } : primary;
}

/** Filters and ranks items best-first; an empty query keeps the input order. */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  if (query.trim().length === 0) return [...items];
  const tokens = query
    .trim()
    .split(/[\s/]+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return [...items];

  const scored: Array<{ item: T; total: number }> = [];
  for (const item of items) {
    const text = getText(item);
    let total = 0;
    let allMatch = true;
    for (const token of tokens) {
      const match = fuzzyMatch(token, text);
      if (!match.matches) {
        allMatch = false;
        break;
      }
      total += match.score;
    }
    if (allMatch) scored.push({ item, total });
  }
  scored.sort((left, right) => left.total - right.total);
  return scored.map((entry) => entry.item);
}
