/**
 * The Source Control body's three-block layout, as data.
 *
 * The panel is three vertically stacked blocks — **Source Control**, **Changes**,
 * **Commit History** — sized by two persisted fractions (`prefs.rail.split`) and
 * separated by two draggable splitters. Two numbers describe three blocks because
 * they have to fill the panel exactly: History is always the remainder.
 *
 * Everything that can be decided without rendering lives here so the panel and
 * its tests agree on the ids and on the flex weights, and so the arithmetic is
 * covered by a node-project test rather than a DOM one.
 */

import { railSplitFractions, type RailSplitPrefs } from "../../../shared/rail";

/** The blocks, top to bottom. The ids double as `data-testid` suffixes. */
export const BLOCK_IDS = ["source-control", "changes", "history"] as const;

export type SourceControlBlockId = (typeof BLOCK_IDS)[number];

/** The `data-testid` a block renders, e.g. `changes-block`. */
export function blockTestId(id: SourceControlBlockId): string {
  return `${id}-block`;
}

/** Every block's test id, in document order. */
export const BLOCK_TEST_IDS = BLOCK_IDS.map(blockTestId);

/**
 * The three blocks' `flex` shorthand, in document order.
 *
 * Flex weight rather than a percentage height: the blocks then share whatever
 * the body actually measures, so the splitters stay honest when the window is
 * resized and no block can overflow its share. `flexBasis: 0` is essential —
 * with an `auto` basis a block's content (a long change list) would set its own
 * height and the persisted split would stop meaning anything.
 */
export function blockFlex(split: RailSplitPrefs): [string, string, string] {
  const fractions = railSplitFractions(split);
  return [`${fractions.top} 1 0`, `${fractions.middle} 1 0`, `${fractions.history} 1 0`];
}
