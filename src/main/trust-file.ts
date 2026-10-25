/**
 * Read-only project-trust lookup for the main process.
 *
 * The host owns the SDK's `ProjectTrustStore`; main needs the same answer for
 * the project-settings toggle, but must not import `@earendil-works/*` (AGENTS
 * rule 4). This module mirrors the small, stable on-disk contract:
 *
 * - `<agentDir>/trust.json` maps canonical project paths to `true`/`false`
 *   (a `null` value is a cleared decision and means "ask").
 * - The nearest parent decision wins.
 * - A project with no trust-requiring resources is trusted without a decision.
 * - Otherwise a missing decision means untrusted; the host's trust chip/prompt
 *   is still the UI source of truth.
 *
 * Filesystem access goes through the injected `FsPort` so this stays testable.
 */

import { dirname, join, resolve } from "node:path";
import type { FsPort } from "./fs-port";

const CONFIG_DIR = ".pi";

/** The resources Pi treats as trust-requiring (mirrors `trust-manager.js`). */
const TRUST_REQUIRING_PROJECT_RESOURCES = [
  "settings.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
] as const;

function normalizeKey(target: string): string {
  const resolved = resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** One nearest-parent lookup over a normalized path map. */
function findDecision(decisions: Map<string, boolean>, cwd: string): boolean | undefined {
  let current = normalizeKey(cwd);
  for (;;) {
    const value = decisions.get(current);
    if (value !== undefined) return value;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function readDecisions(fs: FsPort, agentDir: string): Promise<Map<string, boolean>> {
  const decisions = new Map<string, boolean>();
  const text = await fs.readTextFile(join(agentDir, "trust.json"));
  if (text === null || text.trim().length === 0) return decisions;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch {
    return decisions;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return decisions;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value !== true && value !== false) continue;
    decisions.set(normalizeKey(key), value);
  }
  return decisions;
}

async function requiresTrust(fs: FsPort, cwd: string): Promise<boolean> {
  for (const name of TRUST_REQUIRING_PROJECT_RESOURCES) {
    const kind = await fs.pathKind(join(cwd, CONFIG_DIR, name));
    if (kind !== null) return true;
  }
  return false;
}

export interface TrustFile {
  isProjectTrusted(cwd: string): Promise<boolean>;
}

export function createTrustFile(options: { fs: FsPort; agentDir: string }): TrustFile {
  return {
    async isProjectTrusted(cwd: string): Promise<boolean> {
      if (!(await requiresTrust(options.fs, cwd))) return true;
      const decisions = await readDecisions(options.fs, options.agentDir);
      return findDecision(decisions, cwd) === true;
    },
  };
}
