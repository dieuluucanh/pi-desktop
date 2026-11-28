/**
 * Trusted release gate for reference-based attachments (plan step 8).
 *
 * Protocol support and product availability are deliberately independent: a
 * host can implement the protocol while this build keeps the feature off. Until
 * step 16 verifies the milestone-A gates, packaged builds must not stage or
 * deliver attachments. Development and tests enable it through configuration,
 * never through renderer-supplied readiness.
 */

export interface AttachmentAvailabilityInput {
  /** `app.isPackaged`; packaged builds stay gated until step 16. */
  readonly packaged: boolean;
  /** Trusted process environment; only a positive/negative override is honored. */
  readonly env: { readonly [key: string]: string | undefined };
}

export type AttachmentAvailability =
  | { readonly available: true; readonly reason: null }
  | { readonly available: false; readonly reason: "release_unavailable" };

export const ATTACHMENT_AVAILABILITY_ENV = "PI_DESKTOP_ATTACHMENTS" as const;

export function resolveAttachmentAvailability(
  input: AttachmentAvailabilityInput,
): AttachmentAvailability {
  const override = input.env[ATTACHMENT_AVAILABILITY_ENV]?.trim().toLowerCase();
  if (override === "1" || override === "on" || override === "true")
    return { available: true, reason: null };
  if (override === "0" || override === "off" || override === "false")
    return { available: false, reason: "release_unavailable" };
  // Default: a development/test build is usable; a packaged build is not until
  // the milestone-A gate is enabled in step 16.
  return input.packaged
    ? { available: false, reason: "release_unavailable" }
    : { available: true, reason: null };
}
