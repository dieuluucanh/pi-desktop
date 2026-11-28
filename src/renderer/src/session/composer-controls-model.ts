/**
 * Non-component values of the generic composer-control row (step 21).
 *
 * Kept out of `ComposerControls.tsx` so the component file only exports
 * components (React Fast Refresh) while the view and tests can import the
 * stable key format and the presentation constants.
 */

/** Visible controls before the row folds the rest into a `+N` chip. */
export const MAX_VISIBLE_COMPOSER_CONTROLS = 4;

/** The one-shot contract, repeated whenever a control is armed. */
export const COMPOSER_ARMED_HINT = "Send refines, does not run";

/**
 * Stable key for one publisher's control: owner + id, never the label or a
 * status string.
 */
export function composerControlKey(control: { ownerId: string; id: string }): string {
  return `${control.ownerId}\u0000${control.id}`;
}
