import { ATTACHMENT_DELIVERY_VERSION } from "../shared/attachments";

/**
 * Main-side interpretation of a host's attachment capability.
 *
 * The greeting is untrusted input: an old host omits the field, a newer host may
 * advertise a higher version, and a malformed build may send anything. Only the
 * exact supported version is usable, and the reason matters to the UI: "stale
 * host, restart it" is different from "this build is newer than the app".
 *
 * This says nothing about whether the *product* enables attachments; the
 * release gate is a separate, trusted main-process decision.
 */
export type AttachmentHostStatus =
  | { readonly supported: true; readonly version: number }
  | {
      readonly supported: false;
      readonly reason: "missing" | "old" | "newer" | "malformed";
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function attachmentHostStatus(capabilities: unknown): AttachmentHostStatus {
  const value = record(capabilities)?.attachmentDeliveryVersion;
  if (value === undefined || value === null) return { supported: false, reason: "missing" };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return { supported: false, reason: "malformed" };
  }
  if (value < ATTACHMENT_DELIVERY_VERSION) return { supported: false, reason: "old" };
  if (value > ATTACHMENT_DELIVERY_VERSION) return { supported: false, reason: "newer" };
  return { supported: true, version: value };
}
