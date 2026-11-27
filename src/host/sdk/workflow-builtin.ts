/**
 * `builtin:workflow` as loader input (plan step 27).
 *
 * `src/host/workflow-builtin.ts` decides *whether* the staged Workflow copy may
 * load; this adapter turns that answer into the one SDK shape that makes it a
 * named builtin:
 *
 * ```ts
 * { name: "workflow", builtin: true, replaceable, factory }
 * ```
 *
 * The SDK then treats `builtin:workflow` like a configured extension file: it
 * loads by default, appears in `pi config`, is disabled by `-builtin:workflow`
 * or `noExtensions`, and (because it is `replaceable`) steps aside when an
 * installed npm/git/profile copy registers an overlapping command/tool/flag.
 *
 * The factory is registration-only by construction: it imports the artifact and
 * calls its default export with the SDK's own `pi` API. All state, I/O and
 * background work stays inside that default export's `session_start` path
 * (Workflow plan step 25), so a builtin the SDK later omits leaves nothing live.
 *
 * Deliberately *not* used here: `additionalExtensionPaths: ["builtin:workflow"]`.
 * The SDK marks explicitly-passed paths as enabled, which would override the
 * user's `-builtin:workflow` opt-out.
 */

import { pathToFileURL } from "node:url";

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import { WORKFLOW_BUILTIN_NAME, type WorkflowBuiltinResolution } from "../workflow-builtin";

/** The module shape a staged Pi extension entry must expose. */
interface WorkflowModule {
  default?: unknown;
}

/** Loads the staged entry. Injected in tests; production uses a real import. */
export type WorkflowBuiltinModuleLoader = (entryPath: string) => Promise<WorkflowModule>;

const importModule: WorkflowBuiltinModuleLoader = async (entryPath) =>
  (await import(pathToFileURL(entryPath).href)) as WorkflowModule;

/**
 * The registration-only factory for one resolution, or null when the loader
 * must not receive it.
 *
 * Node's ESM cache means a second load in the same host process (a session and
 * then the Extensions hub) reuses the artifact module but calls the factory
 * again, exactly like any other extension the loader initializes per runtime.
 */
export function workflowBuiltinFactory(
  resolution: WorkflowBuiltinResolution,
  load: WorkflowBuiltinModuleLoader = importModule,
): InlineExtension | null {
  if (!resolution.registered || !resolution.entryPath) return null;
  const entryPath = resolution.entryPath;
  return {
    name: WORKFLOW_BUILTIN_NAME,
    builtin: true,
    replaceable: resolution.replaceable,
    factory: async (pi: ExtensionAPI) => {
      const module = await load(entryPath);
      const register = module?.default;
      if (typeof register !== "function") {
        throw new Error(`the staged Workflow entry has no default factory function: ${entryPath}`);
      }
      await (register as (api: ExtensionAPI) => void | Promise<void>)(pi);
    },
  };
}

/** The `extensionFactories` entry list for a loader, empty when not registered. */
export function workflowBuiltinExtensions(
  resolution: WorkflowBuiltinResolution,
  load?: WorkflowBuiltinModuleLoader,
): InlineExtension[] {
  const entry = workflowBuiltinFactory(resolution, load);
  return entry ? [entry] : [];
}

/**
 * The resource-loader option fragment both consumers spread:
 * `createSdkSessionRuntime` (a session's loader) and `createSdkResourceInspector`
 * (the Extensions hub's control-host loader) must register the *same* name,
 * artifact and replaceability, or the hub would describe a copy the session
 * does not have.
 */
export function workflowBuiltinLoaderOptions(
  resolution: WorkflowBuiltinResolution | null | undefined,
  load?: WorkflowBuiltinModuleLoader,
): { extensionFactories?: InlineExtension[] } {
  if (!resolution) return {};
  const extensions = workflowBuiltinExtensions(resolution, load);
  return extensions.length > 0 ? { extensionFactories: extensions } : {};
}
