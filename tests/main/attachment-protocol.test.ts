import { describe, expect, it } from "vitest";
import { attachmentHostStatus } from "../../src/main/attachment-protocol";
import {
  ATTACHMENT_AVAILABILITY_ENV,
  resolveAttachmentAvailability,
} from "../../src/main/attachment-availability";

describe("attachment host negotiation", () => {
  it("accepts only the exact supported protocol version", () => {
    expect(attachmentHostStatus({ attachmentDeliveryVersion: 1 })).toEqual({
      supported: true,
      version: 1,
    });
  });

  it("distinguishes a missing, old, newer and malformed greeting", () => {
    expect(attachmentHostStatus(undefined)).toEqual({ supported: false, reason: "missing" });
    expect(attachmentHostStatus({})).toEqual({ supported: false, reason: "missing" });
    expect(attachmentHostStatus({ attachmentDeliveryVersion: null })).toEqual({
      supported: false,
      reason: "missing",
    });
    expect(attachmentHostStatus({ attachmentDeliveryVersion: 0 })).toEqual({
      supported: false,
      reason: "old",
    });
    expect(attachmentHostStatus({ attachmentDeliveryVersion: 2 })).toEqual({
      supported: false,
      reason: "newer",
    });
    for (const value of ["1", 1.5, -1, Number.NaN, {}, [], true]) {
      expect(attachmentHostStatus({ attachmentDeliveryVersion: value })).toEqual({
        supported: false,
        reason: "malformed",
      });
    }
  });
});

describe("attachment release availability", () => {
  it("keeps packaged builds gated until the milestone-A gate is enabled", () => {
    expect(resolveAttachmentAvailability({ packaged: true, env: {} })).toEqual({
      available: false,
      reason: "release_unavailable",
    });
    expect(resolveAttachmentAvailability({ packaged: false, env: {} })).toEqual({
      available: true,
      reason: null,
    });
  });

  it("honours only an explicit trusted environment override", () => {
    expect(
      resolveAttachmentAvailability({
        packaged: true,
        env: { [ATTACHMENT_AVAILABILITY_ENV]: "1" },
      }),
    ).toEqual({ available: true, reason: null });
    expect(
      resolveAttachmentAvailability({
        packaged: false,
        env: { [ATTACHMENT_AVAILABILITY_ENV]: "off" },
      }),
    ).toEqual({ available: false, reason: "release_unavailable" });
    expect(
      resolveAttachmentAvailability({
        packaged: true,
        env: { [ATTACHMENT_AVAILABILITY_ENV]: "maybe" },
      }),
    ).toEqual({ available: false, reason: "release_unavailable" });
  });

  it("is independent of protocol support", () => {
    const host = attachmentHostStatus({ attachmentDeliveryVersion: 1 });
    expect(host.supported).toBe(true);
    // A supporting host is still gated in a packaged build without an override.
    expect(resolveAttachmentAvailability({ packaged: true, env: {} }).available).toBe(false);
    // And an enabled build cannot turn an unsupported host into a sender.
    expect(attachmentHostStatus({}).supported).toBe(false);
    expect(resolveAttachmentAvailability({ packaged: false, env: {} }).available).toBe(true);
  });
});
