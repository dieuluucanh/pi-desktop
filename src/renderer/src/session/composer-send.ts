/**
 * Composer Send routing and dispositions (2026-11-22 prompt-refinement plan
 * step 20).
 *
 * A Send used to answer one boolean: "did the text reach the host?". That is a
 * lie once an armed transform control exists — a transformation is neither a
 * chat send nor a refusal, and treating it as either would clear the draft the
 * operation is about to replace, or silently dispatch the task the user asked
 * to refine.
 *
 * Dispositions make the outcomes explicit:
 *  - `sent`             the normal prompt transport accepted the message;
 *  - `handled-command`  a slash command consumed the input (app command,
 *                       extension command or an unknown-name hint);
 *  - `refining`         an armed transformation started; the draft, its
 *                       attachments and its history stay untouched until the
 *                       candidate is applied through the CAS path;
 *  - `refined`          a candidate was applied to the draft (returned by the
 *                       apply wrapper, never by a dispatch);
 *  - `refused`          nothing was dispatched and nothing was consumed.
 *
 * Only `sent` and `handled-command` follow the composer's existing clear rules
 * (images, picked completion source, completion overlay). `refining`/`refined`
 * preserve content, and `refused` preserves everything by definition.
 *
 * The routing decision itself is pure so every entry point — the Send button,
 * Enter, Alt+Enter/Ctrl+Q, a completion-accept-and-send, an images-only draft —
 * can be tested against the same rules without a host.
 */

import type {
  ComposerControlDescriptor,
  ComposerOperationDerived,
} from "../../../shared/composer-operation";
import {
  COMPOSER_TRANSFORM_CONTRACT,
  COMPOSER_TRANSFORM_LIMITS,
  type ComposerAttachmentRef,
  type ComposerImagePayload,
  type ComposerTransformBinding,
  type ComposerTransformStartRequest,
} from "../../../shared/composer-transform";
import type { ComposerDraftSnapshot } from "./composer-draft";
import type { ImageAttachment } from "./image-attachment";

/** What one Send (or completion-and-send) actually did. */
export type ComposerSendDisposition =
  "sent" | "handled-command" | "refining" | "refined" | "refused";

/**
 * True when the composer may run its existing clear rules: the text was sent or
 * consumed by a command. A transformation and every refusal keep the draft.
 */
export function composerSendConsumesDraft(disposition: ComposerSendDisposition): boolean {
  return disposition === "sent" || disposition === "handled-command";
}

/** True for a disposition that must leave text, attachments and history alone. */
export function composerSendPreservesDraft(disposition: ComposerSendDisposition): boolean {
  return !composerSendConsumesDraft(disposition);
}

/** Why an armed Send did not become a transformation. */
export type ComposerSendRefusalReason =
  | "conflict"
  | "disabled"
  | "busy"
  | "queued"
  | "input-locked"
  | "active-operation"
  | "empty-text"
  | "images-only";

export type ComposerSendRoute =
  | { kind: "normal" }
  | { kind: "refuse"; reason: ComposerSendRefusalReason; hint: string }
  /**
   * A transformation. `control` is the one armed, enabled control; the caller
   * captures the live draft and starts the operation without clearing anything.
   */
  | { kind: "transform"; control: ComposerControlDescriptor };

export interface ComposerSendRouteInput {
  /** The submitted text, exactly as the composer holds it. */
  text: string;
  imageCount: number;
  /** The main agent is streaming (Enter would steer, Alt+Enter would queue). */
  running: boolean;
  bashRunning: boolean;
  inputLocked: boolean;
  queued: boolean;
  operation: ComposerOperationDerived;
}

/**
 * Decides how an ordinary agent-message submission routes.
 *
 * Only prose reaches this function: slash commands and `!`/`!!` shell input are
 * routed before it, so an armed toggle never refines `/model` or `git status`
 * and those paths keep their existing behavior. The armed toggle is one-shot:
 * exactly one enabled control may be armed, and a live operation or a busy
 * session refuses honestly instead of steering, queueing or prompting.
 */
export function planComposerSend(input: ComposerSendRouteInput): ComposerSendRoute {
  const { operation } = input;

  if (operation.isConflict) {
    return {
      kind: "refuse",
      reason: "conflict",
      hint:
        operation.conflict?.message ??
        "The composer controls disagree; resolve the conflict before sending.",
    };
  }

  const armed = operation.armed;
  if (armed.length === 0) return { kind: "normal" };
  if (armed.length > 1) {
    return {
      kind: "refuse",
      reason: "conflict",
      hint: "More than one transform control is armed; choose one before sending.",
    };
  }

  const control = armed[0];
  if (!control) return { kind: "normal" };
  if (!control.enabled) {
    return {
      kind: "refuse",
      reason: "disabled",
      hint: control.disabledReason ?? "This transform is not available right now.",
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
      hint: "Refine needs an idle session — wait for the run to finish or turn Refine off to send.",
    };
  }

  if (input.bashRunning) {
    return {
      kind: "refuse",
      reason: "busy",
      hint: "A shell command is running — wait for it or turn Refine off to send.",
    };
  }

  if (input.queued) {
    return {
      kind: "refuse",
      reason: "queued",
      hint: "Clear the queued messages before refining this draft.",
    };
  }

  if (input.text.trim().length === 0) {
    return input.imageCount > 0
      ? {
          kind: "refuse",
          reason: "images-only",
          // An images-only draft has no prompt to refine and must never be
          // dispatched as a side effect of the toggle: fail closed and say how
          // to send the images.
          hint: "Refine needs prompt text — write a prompt, or turn Refine off to send the images.",
        }
      : {
          kind: "refuse",
          reason: "empty-text",
          hint: "Write a prompt before refining.",
        };
  }

  return { kind: "transform", control };
}

// ── Start-request construction ───────────────────────────────────────

/** Decoded byte length of a base64 payload, or undefined when it is invalid. */
export function decodedBase64Bytes(text: string): number | undefined {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

/**
 * A bounded, non-cryptographic content fingerprint for attachment metadata.
 * It identifies one live attachment across the request/apply round trip; it is
 * not a security primitive and no bytes leave the renderer because of it.
 */
export function attachmentDigest(data: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}-${data.length.toString(16)}`;
}

export interface ComposerTransformStartInput {
  requestId: string;
  binding: ComposerTransformBinding;
  control: ComposerControlDescriptor;
  /** The live capture taken before anything is cleared. */
  draft: ComposerDraftSnapshot;
  /** The live attachment objects (identity + base64 payload). */
  attachments: readonly ImageAttachment[];
}

export type ComposerTransformStartBuild =
  { ok: true; request: ComposerTransformStartRequest } | { ok: false; message: string };

/**
 * Builds the typed start request from a live capture. Bounded locally so an
 * oversized draft/image is refused with the user's content intact instead of
 * bouncing off the host after the composer already committed to a send.
 */
export function buildComposerTransformStart(
  input: ComposerTransformStartInput,
): ComposerTransformStartBuild {
  const { draft, attachments, control, binding, requestId } = input;
  if (draft.text.length > COMPOSER_TRANSFORM_LIMITS.maxDraftTextChars) {
    return { ok: false, message: "This draft is too large to refine — turn Refine off to send." };
  }
  if (attachments.length > COMPOSER_TRANSFORM_LIMITS.maxAttachmentCount) {
    return { ok: false, message: "Too many images to refine — turn Refine off to send them." };
  }

  const refs: ComposerAttachmentRef[] = [];
  const images: ComposerImagePayload[] = [];
  let total = 0;
  for (const attachment of attachments) {
    const byteLength = decodedBase64Bytes(attachment.data);
    if (byteLength === undefined) {
      return { ok: false, message: `${attachment.name} could not be read — remove it and retry.` };
    }
    if (byteLength > COMPOSER_TRANSFORM_LIMITS.maxAttachmentBytes) {
      return {
        ok: false,
        message: `${attachment.name} is too large to refine — turn Refine off to send it.`,
      };
    }
    total += byteLength;
    if (total > COMPOSER_TRANSFORM_LIMITS.maxTotalAttachmentBytes) {
      return {
        ok: false,
        message: "These images are too large to refine — turn Refine off to send.",
      };
    }
    refs.push({
      id: attachment.id,
      digest: attachmentDigest(attachment.data),
      mimeType: attachment.mimeType,
      byteLength,
    });
    images.push({
      id: attachment.id,
      mimeType: attachment.mimeType,
      dataBase64: attachment.data,
    });
  }

  return {
    ok: true,
    request: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId,
      ownerId: control.ownerId,
      controlId: control.id,
      actionId: control.actionRef,
      transformActionId: control.transformActionRef,
      contributionRevision: control.descriptorGeneration.revision,
      binding,
      snapshot: {
        draftRevision: draft.revision,
        text: draft.text,
        expandedText: draft.expandedText,
        selection: { start: draft.selection.start, end: draft.selection.end },
        attachments: refs,
        inputState: "idle",
      },
      ...(images.length === 0 ? {} : { images }),
    },
  };
}

/**
 * The operation's request id. It must be unpredictable enough that two Sends
 * cannot collide; a runtime without a CSPRNG refuses the transformation rather
 * than falling back to a guessable counter.
 */
export function composerTransformRequestId(randomUUID?: () => string): string | null {
  const mint =
    randomUUID ??
    (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.bind(
      globalThis.crypto,
    );
  if (typeof mint !== "function") return null;
  let value: string;
  try {
    value = mint();
  } catch {
    return null;
  }
  const requestId = `cx-${value}`;
  return /^[A-Za-z0-9._-]{8,96}$/.test(requestId) ? requestId : null;
}
