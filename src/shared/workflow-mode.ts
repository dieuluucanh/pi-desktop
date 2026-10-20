/**
 * Workflow mode, decoded from an extension status line (2026-10-19 UI rework).
 *
 * The Workflow extension (`@dieulc/workflow`) lives outside this repo and tells
 * the app about its mode in exactly one way: `ctx.ui.setStatus("workflow", …)`
 * (`~/.pi/agent/extensions/workflow/index.ts:892–943`). Tab cycling is
 * deliberately silent (`quiet: true`, `index.ts:2087–2094`), so this status text
 * **is** the mode signal — there is no other channel.
 *
 * Two consequences shape this module:
 *
 *  - **It must be tolerant.** The text is written by third-party code that this
 *    repo does not pin, so an unrecognised or restyled value degrades to "no
 *    mode" rather than throwing or mis-colouring the composer.
 *  - **It must be pure and shared.** The node project renders nothing, but the
 *    parsing table is the contract; keeping it free of React, DOM and SDK
 *    imports lets `tests/shared/**` pin it exactly.
 *
 * The status carries ANSI colour (`ctx.ui.theme.fg(...)`), so every entry point
 * strips escapes first.
 */

import { stripAnsi } from "./ansi";

/**
 * A workflow mode as the app needs it.
 *
 * `default` is the extension's "workflow off" state (it renders `◦ …`); it is a
 * real mode with an explicit neutral presentation, not an unknown value.
 */
export const WORKFLOW_MODES = ["plan", "build", "default"] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

export interface WorkflowModeView {
  mode: WorkflowMode;
  /**
   * True while the plan is under review in the browser (`⏸ plan — reviewing
   * in browser`). This is a sub-state of Plan, not a mode: it must never
   * rename the mode (2026-10-20 startup-tab-cycle plan). The phrase is
   * Plannotator's phase label, rendered by the Workflow extension merely
   * because the Plannotator package is installed — not a Workflow mode.
   */
  browserReview: boolean;
  /** Completed steps from an `n/m` progress status, or null when absent. */
  done: number | null;
  /** Total steps from an `n/m` progress status, or null when absent. */
  total: number | null;
}

/** Longest status string kept for a `title`/copy path. */
const MAX_STATUS_CHARS = 160;

/** Progress suffix in build/plan/default statuses: `▶ build 3/8`, `◦ 3/8`. */
const PROGRESS = /(\d+)\s*\/\s*(\d+)/;

/**
 * The glyph prefix each mode renders (`index.ts:892–943`).
 *
 * Matching is by glyph **and** mode word, never glyph alone: another extension
 * could legitimately push `▶ running tests`, and misreading that as build mode
 * would recolour the composer wrongly — a worse failure than showing no mode.
 */
const BUILD_STATUS = /^\u25b6\s*build\b/; // ▶ build
const PLAN_STATUS = /^\u23f8\s*plan\b/; // ⏸ plan
/** Default (workflow off): `◦ 3/8` or `◦ commits:never`. */
const DEFAULT_STATUS = /^\u25e6\s*(?:\d+\s*\/\s*\d+|commits\b)/;

/** The plannotator phase label rendered as a Plan sub-state (never a mode). */
const REVIEWING_MARKER = "reviewing in browser";

function progressOf(text: string): { done: number | null; total: number | null } {
  const match = PROGRESS.exec(text);
  if (!match) return { done: null, total: null };
  const done = Number.parseInt(match[1] ?? "", 10);
  const total = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(done) || !Number.isFinite(total)) return { done: null, total: null };
  return { done, total };
}

/**
 * Decodes the Workflow extension's status text into a mode view, or null when
 * the text is absent or unrecognised.
 *
 * Recognised shapes (all after ANSI stripping):
 *   `⏸ plan` · `⏸ plan 2/8` · `⏸ plan — reviewing in browser` (+ `n/m`)
 *   `▶ build` · `▶ build 3/8`
 *   `◦ 3/8` · `◦ commits:never`
 * Anything else — including another extension's text — yields null.
 */
export function parseWorkflowStatus(text: string | null | undefined): WorkflowModeView | null {
  if (typeof text !== "string") return null;
  const plain = stripAnsi(text).trim();
  if (plain.length === 0) return null;

  const progress = progressOf(plain);

  if (BUILD_STATUS.test(plain)) {
    return { mode: "build", browserReview: false, ...progress };
  }
  if (PLAN_STATUS.test(plain)) {
    return {
      mode: "plan",
      browserReview: plain.includes(REVIEWING_MARKER),
      ...progress,
    };
  }
  if (DEFAULT_STATUS.test(plain)) {
    return { mode: "default", browserReview: false, ...progress };
  }
  return null;
}

/**
 * The composer border for a mode, mirroring the colour the extension itself uses
 * for that mode's status (`index.ts:919` plan → `warning`, `:928` build →
 * `accent`).
 *
 * Returns a complete Tailwind utility, never a concatenated one: Tailwind scans
 * source text, so `"border-" + tone` would compile to nothing.
 */
export function workflowBorderClass(mode: WorkflowModeView | null): string {
  if (!mode) return "border-line";
  if (mode.mode === "build") return "border-accent";
  if (mode.mode === "plan") return "border-warn";
  return "border-line";
}

/**
 * Short label for the composer's mode badge.
 *
 * Every *recognised* mode has a label, including `Default`: the badge is the
 * app's primary textual mode indicator and must never be empty for a known
 * mode. Only an absent/unrecognised status returns null (no badge).
 */
export function workflowModeLabel(mode: WorkflowModeView | null): string | null {
  if (!mode) return null;
  if (mode.mode === "build") return "Build";
  if (mode.mode === "plan") return "Plan";
  return "Default";
}

/**
 * Plain-text form of a status line, for `title` attributes and copy paths: no
 * escape sequences, no line breaks, single-spaced, trimmed and length-capped.
 *
 * Extension statuses are arbitrary strings and can carry newlines (Pi's own
 * footer sanitises them the same way), so a raw value must never reach a
 * single-line attribute.
 */
export function statusLineText(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  const plain = stripAnsi(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
  return plain.length > MAX_STATUS_CHARS ? `${plain.slice(0, MAX_STATUS_CHARS - 1)}…` : plain;
}
