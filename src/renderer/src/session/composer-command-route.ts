/**
 * Typed refinement commands route through the structured operation path
 * (2026-11-22 prompt-refinement plan step 24).
 *
 * A publisher advertises two equivalent entrances to one refinement: the
 * composer control (toggle/button) and a public `/command <prompt>` prefix.
 * Desktop must not make the typed entrance a second, weaker implementation:
 * the generic extension-command path clears the composer, drops attachments and
 * hands the candidate to the old editor mirror. Instead the literal arguments
 * of the typed command are sent as the transformation input, the draft and its
 * attachments stay untouched, and the candidate returns through the same CAS
 * apply as an armed Send.
 *
 * The match is deliberately data-driven, never a command name baked into
 * Desktop:
 *   - the resolved command must come from the `extension` source, so an app
 *     command, prompt template or skill keeps its existing routing even when it
 *     shares the name;
 *   - the name must equal the transform action's advertised command exactly.
 *     An SDK collision invocation name (`prompt:2`) is never projected and
 *     never matched here: the snapshot cannot say which registration owns the
 *     suffix, and refining text the user addressed to another extension would
 *     be worse than leaving the command to its own handler;
 *   - the control must be enabled and no other transform may be live or
 *     ambiguous, so a typed command cannot queue behind or fight the toggle.
 *
 * The routing decision is pure so every entry point can be tested without a
 * host. A refusal keeps the draft and its attachments in place; it never falls
 * back to dispatch, to the generic clear rules or to a "success" receipt.
 */

import type {
  ComposerControlDescriptor,
  ComposerOperationDerived,
} from "../../../shared/composer-operation";
import type { ComposerSendRefusalReason } from "./composer-send";

/** One resolved `/command` invocation, as the host advertised it. */
export interface ComposerCommandTransformInput {
  /** The resolved command name, exactly as advertised (collision suffix included). */
  name: string;
  /** The literal argument text after the command name; the prompt to refine. */
  argument: string;
  /** The resolved command's source (`extension`, `prompt`, `skill`, …). */
  source?: string;
  /** The projected composer controls for this tab/composer. */
  controls: readonly ComposerControlDescriptor[];
  operation: ComposerOperationDerived;
  running: boolean;
  bashRunning: boolean;
  inputLocked: boolean;
  queued: boolean;
}

export type ComposerCommandTransformRoute =
  | { kind: "not-transform" }
  | { kind: "refuse"; reason: ComposerSendRefusalReason; hint: string }
  | { kind: "transform"; control: ComposerControlDescriptor; text: string };

/**
 * The controls that declare this exact command as their transform entrance.
 *
 * Equality is intentional: a suffixed registration belongs to an ambiguous
 * collision and never matches the publisher's declared base name.
 */
export function matchComposerTransformCommand(
  controls: readonly ComposerControlDescriptor[],
  name: string,
): ComposerControlDescriptor[] {
  if (name.length === 0) return [];
  return controls.filter((control) => control.transformCommand === name);
}

/**
 * Decides whether a resolved slash command is this composer's refinement and,
 * if so, whether it may start now. Everything else is `not-transform`, so the
 * caller keeps its existing command routing untouched.
 */
export function planComposerCommandTransform(
  input: ComposerCommandTransformInput,
): ComposerCommandTransformRoute {
  // App commands, prompt templates and skills are not transforms even when the
  // name happens to match an advertised command.
  if (input.source !== "extension") return { kind: "not-transform" };

  const matches = matchComposerTransformCommand(input.controls, input.name);
  if (matches.length === 0) return { kind: "not-transform" };
  if (matches.length > 1) {
    return {
      kind: "refuse",
      reason: "conflict",
      hint: `/${input.name} is offered by more than one refine control — use the composer control you mean.`,
    };
  }

  const control = matches[0];
  if (!control) return { kind: "not-transform" };
  const { operation } = input;

  if (operation.isConflict) {
    return {
      kind: "refuse",
      reason: "conflict",
      hint:
        operation.conflict?.message ??
        "The composer controls disagree; resolve the conflict before refining.",
    };
  }

  if (!control.enabled) {
    return {
      kind: "refuse",
      reason: "disabled",
      hint: control.disabledReason ?? "This refinement is not available right now.",
    };
  }

  if (operation.isRunning || operation.isAwaitingInput || operation.hasCandidate) {
    return {
      kind: "refuse",
      reason: "active-operation",
      hint: "A refinement is already active in this tab — finish or cancel it first.",
    };
  }

  if (input.inputLocked) {
    return {
      kind: "refuse",
      reason: "input-locked",
      hint: "An extension owns this turn — use its controls before refining.",
    };
  }

  if (input.running) {
    return {
      kind: "refuse",
      reason: "busy",
      hint: "Refine needs an idle session — wait for the run to finish.",
    };
  }

  if (input.bashRunning) {
    return {
      kind: "refuse",
      reason: "busy",
      hint: "A shell command is running — wait for it before refining.",
    };
  }

  if (input.queued) {
    return {
      kind: "refuse",
      reason: "queued",
      hint: "Clear the queued messages before refining.",
    };
  }

  // The command's arguments are the prompt. An empty argument is a usage error,
  // not an empty transformation: the draft (and any images) stays editable.
  if (input.argument.trim().length === 0) {
    return {
      kind: "refuse",
      reason: "empty-text",
      hint: `/${input.name} needs a prompt to refine — for example /${input.name} <your prompt>.`,
    };
  }

  return { kind: "transform", control, text: input.argument };
}
