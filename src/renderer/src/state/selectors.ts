import type { AppStateShape } from "./app-store";
import type { DefaultModelProblem } from "../../../shared/model-default";

/**
 * Store selectors that a view reads with `useAppStore(selector)`.
 *
 * Kept in their own module so the selector's types are imported rather than
 * re-derived at the call site (`import type` is erased, so there is no runtime
 * cycle with the store).
 */

/** The saved default names a model the catalogue does not contain (step 12). */
export const selectDefaultModelProblem = (state: AppStateShape): DefaultModelProblem | null =>
  state.defaultModelProblem;
