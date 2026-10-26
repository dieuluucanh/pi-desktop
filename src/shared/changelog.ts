/**
 * Shared text for a build without Pi's packaged changelog (plan step 15).
 *
 * The renderer and the host both need the sentence, and the renderer must not
 * import from `src/host/*` (different process, different tsconfig).
 */
export const CHANGELOG_UNAVAILABLE =
  "This build does not ship Pi's changelog. `npm i -g @earendil-works/pi-coding-agent@latest` keeps the CLI's copy current.";
