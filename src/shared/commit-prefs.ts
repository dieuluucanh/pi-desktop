/**
 * Commit-message preferences (2026-11-25 plan, step 17).
 *
 * One choice: which model writes the AI commit message. `null` is **Default**,
 * meaning the project's then the global `defaultProvider`/`defaultModel` — the
 * same keys Workflow's Default mode mirrors (plan decision D12). The block
 * follows the house pattern used by `editor`/`rail`: a closed key set, a total
 * sanitizer for untrusted input and a one-level-deeper merge for partial patches.
 *
 * Pure and SDK-free. The ref is `ModelRef`, the app's one `{ provider, id }`
 * pair, so this block cannot drift from the text-generation wire contract.
 */

import type { ModelRef } from "./model-default";
import { MAX_MODEL_ID_LENGTH } from "./text-generation";

/** The saved pick, spelled like every other model ref on the wire. */
export type CommitMessageModelRef = ModelRef;

export interface CommitMessagePrefs {
  /** `null` = Default (resolve from the settings default, then the catalogue). */
  model: CommitMessageModelRef | null;
}

export const DEFAULT_COMMIT_MESSAGE_PREFS: CommitMessagePrefs = { model: null };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Trim, then require a non-empty string no longer than the wire bound. */
function boundedModelPart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MODEL_ID_LENGTH) return null;
  return trimmed;
}

/**
 * Coerces an untrusted block into a usable one. Never throws: a missing, junk or
 * over-long ref collapses to `null` (Default) instead of blocking startup, and
 * the renderer's picker then shows the resolved default.
 */
export function sanitizeCommitMessagePrefs(input: unknown): CommitMessagePrefs {
  const source = asRecord(input);
  const model = asRecord(source.model);
  const provider = boundedModelPart(model.provider);
  const id = boundedModelPart(model.id);
  if (!provider || !id) return { model: null };
  return { model: { provider, id } };
}

/**
 * Applies a partial patch. The block is nested one level (`{ model }`), so a
 * patch that names only the model must not drop anything else the block may
 * grow; the sanitizer still decides what survives.
 */
export function mergeCommitMessagePrefs(
  current: CommitMessagePrefs,
  patch: unknown,
): CommitMessagePrefs {
  const source = asRecord(patch);
  return sanitizeCommitMessagePrefs({ ...current, ...source });
}
