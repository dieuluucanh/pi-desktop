/**
 * The published checkpoint extension identity (2026-10-30 plan).
 *
 * One name is shared by the build script, the host's installed-copy resolver and
 * the `~/.pi` package: `@dieulc/checkpoints`. The unscoped `pi-checkpoints`
 * name belongs to another author, so it must never be used for our package.
 */

export const CHECKPOINT_EXTENSION_PACKAGE_NAME = "@dieulc/checkpoints";

/** Directory name under `<profile>/extensions` and `agent/extensions`. */
export const CHECKPOINT_EXTENSION_DIR_NAME = "checkpoints";

/** The bundled entry file inside the package. */
export const CHECKPOINT_EXTENSION_ENTRY = "index.mjs";
