/**
 * Project trust (plan step 5, risk R9).
 *
 * A project can ship resources that run with the user's full privileges
 * (`<cwd>/.pi/settings.json`, extensions, skills, prompts, themes, npm packages),
 * so the app must not load them silently. The host asks once per project, mirrors
 * the SDK's trust store (`~/.pi/agent/trust.json`) and emits `project_trust` so the
 * UI can put the question to the user.
 */

import type { ProjectTrustStatus, TrustAnswer, TrustDecision } from "../shared/projects";

// The trust types live in `src/shared/projects.ts` so the renderer can type the
// trust prompt without importing host code. `TrustStatus` is the host-side alias
// the existing tests and `session-core` use.
export type { ProjectTrustStatus, TrustAnswer, TrustDecision };
export type TrustStatus = ProjectTrustStatus;

export interface TrustStoreLike {
  get(cwd: string): TrustDecision;
  set(cwd: string, decision: TrustDecision): void;
}

export interface ResolveTrustInput {
  cwd: string;
  requiresTrust: boolean;
  decision: TrustDecision;
  /** A session-only grant, already given in this process. */
  sessionTrusted?: boolean;
}

export function resolveTrust(input: ResolveTrustInput): TrustStatus {
  if (!input.requiresTrust) {
    return {
      cwd: input.cwd,
      requiresTrust: false,
      decision: input.decision,
      trusted: true,
      needsPrompt: false,
    };
  }
  if (input.sessionTrusted === true) {
    return {
      cwd: input.cwd,
      requiresTrust: true,
      decision: input.decision,
      trusted: true,
      needsPrompt: false,
    };
  }
  if (input.decision === true) {
    return {
      cwd: input.cwd,
      requiresTrust: true,
      decision: true,
      trusted: true,
      needsPrompt: false,
    };
  }
  if (input.decision === false) {
    return {
      cwd: input.cwd,
      requiresTrust: true,
      decision: false,
      trusted: false,
      needsPrompt: false,
    };
  }
  return { cwd: input.cwd, requiresTrust: true, decision: null, trusted: false, needsPrompt: true };
}

export interface ProjectTrust {
  status(cwd: string): TrustStatus;
  /** Applies the user's answer and returns the resulting status. */
  answer(cwd: string, answer: TrustAnswer): TrustStatus;
  isTrusted(cwd: string): boolean;
}

export interface ProjectTrustOptions {
  store: TrustStoreLike;
  /** Defaults to the SDK's `hasTrustRequiringProjectResources`. */
  requiresTrust(cwd: string): boolean;
}

export function createProjectTrust(options: ProjectTrustOptions): ProjectTrust {
  const sessionGrants = new Set<string>();

  const statusOf = (cwd: string): TrustStatus =>
    resolveTrust({
      cwd,
      requiresTrust: safeRequiresTrust(options, cwd),
      decision: safeDecision(options.store, cwd),
      sessionTrusted: sessionGrants.has(cwd),
    });

  return {
    status: statusOf,
    isTrusted: (cwd) => statusOf(cwd).trusted,
    answer: (cwd, answer) => {
      if (answer === "session") {
        sessionGrants.add(cwd);
        return statusOf(cwd);
      }
      safeSet(options.store, cwd, answer === "trust");
      return statusOf(cwd);
    },
  };
}

function safeRequiresTrust(options: ProjectTrustOptions, cwd: string): boolean {
  try {
    return options.requiresTrust(cwd);
  } catch {
    // A missing or unreadable project directory is not a trust question.
    return false;
  }
}

function safeDecision(store: TrustStoreLike, cwd: string): TrustDecision {
  try {
    return store.get(cwd) ?? null;
  } catch {
    return null;
  }
}

function safeSet(store: TrustStoreLike, cwd: string, decision: boolean): void {
  try {
    store.set(cwd, decision);
  } catch {
    // Failing to persist must not block the session; the choice stays session-only.
  }
}
