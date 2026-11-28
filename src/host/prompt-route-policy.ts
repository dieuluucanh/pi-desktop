import { resolveAttachmentCapability, type AttachmentReason } from "../shared/attachments";

/**
 * Host-owned eligibility policy for Desktop prompt routes that are not the
 * managed attachment path (plan step 9).
 *
 * The rule is deliberately narrow: plain text stays available on any model, but
 * a route that would send images — new legacy blocks or images already in the
 * active context — must target a model that actually accepts images. A session
 * whose history contains images therefore cannot silently dispatch to a
 * text-only model; the user must switch back or start a new/text-only context.
 * Nothing here strips history: the check refuses the route instead.
 */
export interface PromptRouteContext {
  readonly model: unknown;
  /** Image blocks already in the active context; null when unboundable. */
  readonly historyImageCount: number | null;
  /** Whether this request itself carries legacy inline image blocks. */
  readonly addingImages: boolean;
}

export function evaluatePromptRoute(context: PromptRouteContext): readonly AttachmentReason[] {
  const historyImages = context.historyImageCount;
  const hasImages = context.addingImages || (historyImages ?? 0) > 0;
  if (!hasImages) return [];
  // Unboundable history with new images cannot prove eligibility; fail closed
  // rather than guess that the existing context is image-free.
  if (historyImages === null && !context.addingImages) return [];
  const imageCapability = resolveAttachmentCapability(context.model, "image");
  if (imageCapability.state !== "supported") return [imageCapability.reason];
  if (historyImages !== null && historyImages > 1_000) return ["image_limit_exceeded"];
  return [];
}

/**
 * A Desktop model change is refused only while it would corrupt an *active*
 * multimodal run. When idle the switch is allowed, and the route policy above
 * blocks dispatch until the context/model pair is compatible again.
 */
export function evaluateModelChange(input: {
  readonly model: unknown;
  readonly historyImageCount: number | null;
  readonly streaming: boolean;
}): readonly AttachmentReason[] {
  if (input.streaming !== true) return [];
  if ((input.historyImageCount ?? 0) === 0) return [];
  const imageCapability = resolveAttachmentCapability(input.model, "image");
  if (imageCapability.state !== "supported") return [imageCapability.reason];
  return [];
}
