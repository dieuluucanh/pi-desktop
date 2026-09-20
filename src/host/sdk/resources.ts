/**
 * The Extensions hub's control-host inspection (plan step 13).
 *
 * A control host owns no `AgentSession`, but the hub must still work with no
 * session tab open. This adapter builds a real `DefaultResourceLoader` for the
 * requested project — the same loader a session would use — and hands back its
 * four collections. The result is cached per project and rebuilt on an explicit
 * refresh, because loading extensions executes their factories.
 *
 * Project resources load only when the app's trust store says the project is
 * trusted, mirroring every other path in the host (plan step 10).
 */

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ResourceInspector, ResourceLoaderSource } from "../resources";

export interface SdkResourceInspectorOptions {
  /** `~/.pi/agent`, resolved by the composition root. */
  agentDir: string;
  /** The cwd used when a caller does not pass one (the host's own cwd). */
  cwd: string;
  /** The app's stored trust decision for a project folder. */
  isProjectTrusted?: (cwd: string) => boolean;
}

export function createSdkResourceInspector(
  options: SdkResourceInspectorOptions,
): ResourceInspector {
  const cache = new Map<string, ResourceLoaderSource>();

  return {
    async load(cwd, loadOptions) {
      const target = cwd ?? options.cwd;
      const key = target;
      if (loadOptions?.refresh !== true) {
        const cached = cache.get(key);
        if (cached) return cached;
      }

      const settingsManager = SettingsManager.create(target, options.agentDir);
      const loader = new DefaultResourceLoader({
        cwd: target,
        agentDir: options.agentDir,
        settingsManager,
      });
      await loader.reload({
        // Answer from the app's store instead of prompting: the hub is not a
        // place to answer a trust question, and an untrusted project simply
        // keeps its project resources hidden, exactly as Pi does.
        resolveProjectTrust: async () => options.isProjectTrusted?.(target) ?? false,
      });

      const source: ResourceLoaderSource = {
        extensions: loader.getExtensions(),
        skills: loader.getSkills(),
        prompts: loader.getPrompts(),
        themes: loader.getThemes(),
      };
      cache.set(key, source);
      return source;
    },
  };
}
