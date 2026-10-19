/**
 * The `CustomProviderStore` over a real `models.json` (plan step 9, slice 5).
 *
 * The write is atomic (through the injected `ModelsFileIo`) and **verified**:
 * after merging an entry, a throw-away `ModelRuntime` is built from the file and
 * asked for the provider's models. If Pi cannot load it, the previous bytes are
 * restored, so a typo can never leave the profile's `models.json` broken.
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CustomProviderInput, CustomProviderSummary } from "../../shared/custom-providers";
import {
  removeCustomProvider,
  storedCustomProviderEntry,
  summarizeCustomProvider,
  summarizeCustomProviders,
  upsertCustomProvider,
  validateCustomProvider,
  type CustomProviderStore,
  type ModelsFileIo,
} from "../custom-providers";
import { ProviderError } from "../providers";

export interface SdkCustomProviderOptions {
  /** Absolute path of the profile's `models.json`. */
  modelsPath: string;
  io: ModelsFileIo;
  /**
   * Confirms Pi can load an entry. Defaults to building a throw-away
   * `ModelRuntime` from the file; injected in tests so they stay offline.
   */
  verify?: (modelsPath: string, providerId: string) => Promise<boolean>;
}

/** Builds a throw-away runtime from the file and confirms Pi can load the entry. */
async function verifyWithPi(modelsPath: string, providerId: string): Promise<boolean> {
  try {
    const runtime = await ModelRuntime.create({ modelsPath, allowModelNetwork: false });
    return (
      runtime.getProvider(providerId) !== undefined && runtime.getModels(providerId).length > 0
    );
  } catch {
    return false;
  }
}

export function createSdkCustomProviderStore(
  options: SdkCustomProviderOptions,
): CustomProviderStore {
  const { modelsPath, io } = options;
  const verify = options.verify ?? verifyWithPi;

  return {
    async list(): Promise<CustomProviderSummary[]> {
      return summarizeCustomProviders(await io.read(modelsPath), modelsPath);
    },

    async set(input: CustomProviderInput): Promise<CustomProviderSummary> {
      const providerId = (input.id ?? "").trim();
      const entry = validateCustomProvider(input);
      const previous = await io.read(modelsPath);
      await io.write(modelsPath, upsertCustomProvider(previous, providerId, entry, modelsPath));
      try {
        if (!(await verify(modelsPath, providerId))) {
          throw new ProviderError(
            `Pi could not load "${providerId}" from models.json — check the API family and base URL`,
            "validation_failed",
          );
        }
      } catch (error) {
        // Never leave a broken file behind: restore exactly what was there.
        if (previous === null) await io.delete(modelsPath);
        else await io.write(modelsPath, previous);
        throw error;
      }
      // Summarize what the file **now holds**, not the input: the write merges
      // over any existing entry (unrendered keys, the stored key), so echoing
      // the input back would describe something the profile does not contain.
      return summarizeCustomProvider(
        providerId,
        storedCustomProviderEntry(await io.read(modelsPath), modelsPath, providerId),
      );
    },

    async remove(providerId: string): Promise<void> {
      const previous = await io.read(modelsPath);
      if (previous === null) return;
      await io.write(modelsPath, removeCustomProvider(previous, providerId, modelsPath));
    },
  };
}
