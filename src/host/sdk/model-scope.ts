/**
 * The SDK side of the model scope (Pi's `enabledModels`).
 *
 * Session creation and the model dialog's star both need the same thing: turn a
 * list of model patterns into the concrete `ScopedModel[]` the SDK stores on
 * `AgentSession` (and exposes to extensions as `ctx.scopedModels`). Pi already
 * owns that algorithm — `resolveModelScopeWithDiagnostics()` implements the
 * `--models` / `enabledModels` semantics (exact refs, globs, bare ids, an
 * optional `:thinkingLevel` suffix, auth-filtered catalogue) — so this module
 * calls it instead of re-deriving it.
 *
 * Two behaviours matter:
 *
 * - `resolveSessionScope` **never throws**: a broken/offline catalogue must not
 *   prevent a session from starting, so a failure degrades to "no scope" plus a
 *   warning (terminal Pi does the same, printing the warning).
 * - `toggleScope` **does** throw on a resolution failure. The star edit is a
 *   settings write; applying half of it (persist the new patterns but keep an
 *   empty scope) would be worse than asking the user to retry.
 *
 * The pure rewrite (materialise the live scope, keep unmatched patterns, drop
 * to `undefined` when nothing remains) lives in `src/shared/model-scope.ts` so
 * it is testable without a runtime. This module adds only the SDK calls and the
 * diagnostics mapping.
 */

import {
  resolveModelScopeWithDiagnostics,
  type ModelRuntime,
  type ModelScopeDiagnostic,
  type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import { nextScopePatterns, normalizeScopePatterns } from "../../shared/model-scope";
import type { ScopeDiagnosticInfo } from "../../shared/model-scope";

/** Re-exported so host code keeps one diagnostic shape. */
export type { ScopeDiagnosticInfo };

export interface ScopeResolution {
  scopedModels: ScopedModel[];
  diagnostics: ScopeDiagnosticInfo[];
}

/** What the injected resolver returns (structurally the SDK result). */
export interface ModelScopeResolution {
  scopedModels: readonly ScopedModel[];
  diagnostics: readonly ModelScopeDiagnostic[];
}

/**
 * Injectable seam. The real default is `resolveModelScopeWithDiagnostics`; tests
 * pass a fake so they need neither a `ModelRuntime` nor a catalogue.
 */
export type ModelScopeResolver = (
  patterns: string[],
  runtime: unknown,
  options: { signal?: AbortSignal },
) => Promise<ModelScopeResolution>;

export interface ModelScopeDeps {
  resolve?: ModelScopeResolver;
  /** Bounds the local auth/catalogue read; defaults to 15 s (terminal Pi's value). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toInfo(diagnostic: ModelScopeDiagnostic): ScopeDiagnosticInfo {
  return {
    type: "warning",
    message: diagnostic.message,
    code: diagnostic.code,
    ...(diagnostic.pattern ? { pattern: diagnostic.pattern } : {}),
  };
}

function resolverOf(deps: ModelScopeDeps): ModelScopeResolver {
  if (deps.resolve) return deps.resolve;
  return (patterns, runtime, options) =>
    resolveModelScopeWithDiagnostics(patterns, runtime as ModelRuntime, options);
}

function signalFor(deps: ModelScopeDeps, signal?: AbortSignal): AbortSignal {
  return signal ?? AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export interface ResolveSessionScopeInput {
  patterns: readonly string[] | undefined;
  /** The session's live `ModelRuntime` (`AgentSession.modelRuntime`). */
  runtime: unknown;
  signal?: AbortSignal;
}

/**
 * Resolves `enabledModels` for a session that is being created.
 *
 * No patterns means "no scoping configured" in Pi (`ctx.scopedModels` empty and
 * every available model usable), and the resolver is not called at all.
 */
export async function resolveSessionScope(
  input: ResolveSessionScopeInput,
  deps: ModelScopeDeps = {},
): Promise<ScopeResolution> {
  const patterns = normalizeScopePatterns(input.patterns);
  if (patterns.length === 0) return { scopedModels: [], diagnostics: [] };
  try {
    const result = await resolverOf(deps)(patterns, input.runtime, {
      signal: signalFor(deps, input.signal),
    });
    return {
      scopedModels: [...result.scopedModels],
      diagnostics: result.diagnostics.map(toInfo),
    };
  } catch (error) {
    return {
      scopedModels: [],
      diagnostics: [
        {
          type: "warning",
          code: "resolve-failed",
          message: `Model scope could not be resolved (${messageOf(
            error,
          )}); every available model is usable.`,
        },
      ],
    };
  }
}

/** Thrown when a scope edit cannot be resolved, so the caller writes nothing. */
export class ModelScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelScopeError";
  }
}

export interface ToggleScopeInput {
  /** The effective persisted patterns (`enabledModels`, project over global). */
  patterns: readonly string[] | undefined;
  runtime: unknown;
  provider: string;
  id: string;
  enabled: boolean;
  signal?: AbortSignal;
}

export interface ToggleScopeResult {
  /** `undefined` = no scope; the caller deletes `enabledModels`. */
  patterns: string[] | undefined;
  scopedModels: ScopedModel[];
  diagnostics: ScopeDiagnosticInfo[];
}

/**
 * One star toggle: resolve the persisted patterns to find the ones that match
 * nothing, rewrite from the **resolved persisted** scope, then resolve the
 * result once.
 *
 * - Resolved patterns (including globs) become explicit ids, so un-starring a
 *   model a glob covered really removes it.
 * - `no-match` patterns are preserved verbatim (an offline provider or a typo
 *   must survive an unrelated click).
 * - The rewrite never seeds from the session's live scope. A live-only model
 *   appended by `setModel` is not persisted state; using it as the base is what
 *   let a Desktop click erase patterns terminal Pi had added.
 */
export async function toggleScope(
  input: ToggleScopeInput,
  deps: ModelScopeDeps = {},
): Promise<ToggleScopeResult> {
  const patterns = normalizeScopePatterns(input.patterns);
  const resolve = resolverOf(deps);
  const signal = signalFor(deps, input.signal);

  let before: ModelScopeResolution | undefined;
  let preserved: string[] = [];
  if (patterns.length > 0) {
    try {
      before = await resolve(patterns, input.runtime, { signal });
    } catch (error) {
      throw new ModelScopeError(`Could not resolve the current model scope: ${messageOf(error)}.`);
    }
    preserved = before.diagnostics
      .filter((diagnostic) => diagnostic.code === "no-match")
      .map((diagnostic) => diagnostic.pattern);
  }

  const baseScoped = before?.scopedModels ?? [];

  const next = nextScopePatterns({
    baseScoped,
    preserved,
    provider: input.provider,
    id: input.id,
    enabled: input.enabled,
  });
  if (next === undefined) {
    return { patterns: undefined, scopedModels: [], diagnostics: [] };
  }

  let after: ModelScopeResolution;
  try {
    after = await resolve(next, input.runtime, { signal });
  } catch (error) {
    throw new ModelScopeError(`Could not resolve the new model scope: ${messageOf(error)}.`);
  }
  return {
    patterns: next,
    scopedModels: [...after.scopedModels],
    diagnostics: after.diagnostics.map(toInfo),
  };
}

/** What the session core consumes; structural, so the core stays SDK-free. */
export interface SdkModelScope {
  resolve(patterns: readonly string[] | undefined, runtime: unknown): Promise<ScopeResolution>;
  toggle(input: ToggleScopeInput): Promise<ToggleScopeResult>;
}

/** The composition root's adapter (one per host process). */
export function createSdkModelScope(deps: ModelScopeDeps = {}): SdkModelScope {
  return {
    resolve: (patterns, runtime) => resolveSessionScope({ patterns, runtime }, deps),
    toggle: (input) => toggleScope(input, deps),
  };
}
