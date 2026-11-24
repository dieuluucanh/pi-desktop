import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  COMPOSER_CONTROL_BEHAVIORS,
  COMPOSER_CONTROL_ICONS,
  COMPOSER_CONTROL_KIND,
  COMPOSER_TRANSFORM_CONTRACT,
  COMPOSER_TRANSFORM_LIMITS,
  COMPOSER_TRANSFORM_PRIVACY,
  composerRendezvousChannel,
  composerTransformDiagnostics,
  composerTransformFallback,
  formatComposerBootstrapArgs,
  formatComposerGrant,
  mintComposerGrant,
  negotiateComposerTransform,
  parseComposerBootstrapArgs,
  parseComposerControlContribution,
  parseComposerTransformApplyReceipt,
  parseComposerTransformCancelReceipt,
  parseComposerTransformCancelRequest,
  parseComposerTransformCandidate,
  parseComposerTransformFailure,
  parseComposerTransformProgress,
  parseComposerTransformStartRequest,
  parseComposerTransformStartedReceipt,
  parseComposerTransformStatus,
  parseComposerTransformStatusRequest,
  rememberComposerRequestId,
  resolveComposerControlTargets,
  resolveComposerOperationCommands,
  type ComposerProjectedAction,
} from "../../src/shared/composer-transform";
import {
  CONTRIBUTION_KINDS,
  CONTRIBUTION_SLOTS,
  HOST_CONTRIBUTION_LIMITS,
  parseContributionEnvelope,
} from "../../src/shared/extension-contributions";

/**
 * composer-transform-v1 conformance for the Desktop reader (row 13).
 *
 * `tests/shared/fixtures/composer-transform.conformance.json` is a verbatim
 * copy of the Workflow publisher fixture. Both suites must agree on every
 * accept/reject verdict and every error code.
 */

interface Case {
  name: string;
  expect: "ok" | "error";
  code?: string;
  input?: unknown;
}

interface Fixture {
  version: number;
  contract: string;
  limits: Record<string, number>;
  icons: string[];
  behaviors: string[];
  envelopes: Case[];
  controls: Case[];
  references: Array<
    Case & {
      controls?: Array<{ ownerId: string; control: Record<string, unknown> }>;
      entries?: ComposerProjectedAction[];
    }
  >;
  sourceBinding: Array<
    Case & {
      metadata?: unknown;
      commands?: unknown;
      expectedSource?: unknown;
    }
  >;
  requests: Case[];
  frames: Record<string, Case[]>;
  bootstrap: { grant: string; channel: string; args: string; cases: Case[] };
  negotiation: Array<Case & { capabilities?: unknown; expectFrameBytes?: number }>;
  fallback: { publicCommand: string; expect: Record<string, unknown> };
  privacy: {
    draftSentinel: string;
    imageSentinel: string;
    attachmentDigestSentinel: string;
    attachmentIdSentinel: string;
    modelSentinel: string;
    forbiddenKeys: string[];
  };
}

const FIXTURE = join(__dirname, "fixtures", "composer-transform.conformance.json");
/** Shared byte-identical checksum; the Workflow copy asserts the same value. */
const FIXTURE_SHA256 = "c2cd5a5a3ea910808bf170f7adbdff1c5d6cb4608a3dcde5c73f6777295d62f3";

function readFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
}

function baseRequest(): Record<string, unknown> {
  return {
    contract: COMPOSER_TRANSFORM_CONTRACT,
    requestId: "req_alpha_0001",
    ownerId: "fixture.alpha",
    controlId: "alpha-composer",
    actionId: "alpha-toggle",
    transformActionId: "alpha-transform",
    contributionRevision: 7,
    binding: {
      sessionId: "session-a",
      epoch: 3,
      bindingId: "binding-alpha",
      hostGeneration: 12,
    },
    snapshot: {
      draftRevision: 4,
      text: "please imporve this prompt",
      expandedText: "please imporve this prompt",
      selection: { start: 0, end: 26 },
      attachments: [],
      inputState: "idle",
    },
  };
}

function expectError(
  result: { ok: boolean; error?: { code: string } },
  code: string | undefined,
): void {
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe(code);
}

describe("composer-transform conformance with the publisher", () => {
  it("is the frozen v1 contract", () => {
    const fixture = readFixture();
    expect(fixture.version).toBe(1);
    expect(fixture.contract).toBe(COMPOSER_TRANSFORM_CONTRACT);
    const digest = createHash("sha256").update(readFileSync(FIXTURE)).digest("hex");
    expect(digest, "fixture bytes drifted from the Workflow copy").toBe(FIXTURE_SHA256);
  });

  it("matches every frozen limit", () => {
    const fixture = readFixture();
    expect(COMPOSER_TRANSFORM_LIMITS.maxDraftTextChars).toBe(fixture.limits.maxDraftTextChars);
    expect(COMPOSER_TRANSFORM_LIMITS.maxExpandedTextChars).toBe(
      fixture.limits.maxExpandedTextChars,
    );
    expect(COMPOSER_TRANSFORM_LIMITS.maxCandidateTextChars).toBe(
      fixture.limits.maxCandidateTextChars,
    );
    expect(COMPOSER_TRANSFORM_LIMITS.maxAttachmentCount).toBe(fixture.limits.maxAttachmentCount);
    expect(COMPOSER_TRANSFORM_LIMITS.maxAttachmentBytes).toBe(fixture.limits.maxAttachmentBytes);
    expect(COMPOSER_TRANSFORM_LIMITS.maxTotalAttachmentBytes).toBe(
      fixture.limits.maxTotalAttachmentBytes,
    );
    expect(COMPOSER_TRANSFORM_LIMITS.maxImageCount).toBe(fixture.limits.maxImageCount);
    expect(COMPOSER_TRANSFORM_LIMITS.maxAggregateFrameBytes).toBe(
      fixture.limits.maxAggregateFrameBytes,
    );
    expect(COMPOSER_TRANSFORM_LIMITS.maxGrantChars).toBe(fixture.limits.maxGrantChars);
    expect(COMPOSER_TRANSFORM_LIMITS.grantTtlMs).toBe(fixture.limits.grantTtlMs);
    expect(COMPOSER_TRANSFORM_LIMITS.maxRendezvousClaims).toBe(fixture.limits.maxRendezvousClaims);
    expect(COMPOSER_TRANSFORM_LIMITS.maxRetainedReceipts).toBe(fixture.limits.maxRetainedReceipts);
    // Legacy contribution args are not enlarged to transport prompts.
    expect(HOST_CONTRIBUTION_LIMITS.maxArgsChars).toBe(
      fixture.limits.legacyContributionMaxArgsChars,
    );
    expect(HOST_CONTRIBUTION_LIMITS.maxArgsChars).toBe(1_000);
  });

  it("keeps icons and behaviours closed", () => {
    const fixture = readFixture();
    expect([...COMPOSER_CONTROL_ICONS]).toEqual(fixture.icons);
    expect([...COMPOSER_CONTROL_BEHAVIORS]).toEqual(fixture.behaviors);
    expect((CONTRIBUTION_KINDS as readonly string[]).includes(COMPOSER_CONTROL_KIND)).toBe(true);
    expect((CONTRIBUTION_SLOTS as readonly string[]).includes("composer-actions")).toBe(true);
  });

  it("agrees on every contribution envelope verdict", () => {
    const fixture = readFixture();
    for (const entry of fixture.envelopes) {
      const parsed = parseContributionEnvelope(entry.input);
      expect(parsed.ok, `${entry.name}: ${parsed.ok ? "" : parsed.error}`).toBe(
        entry.expect === "ok",
      );
    }
    const additive = parseContributionEnvelope(fixture.envelopes[0]?.input);
    expect(additive.ok).toBe(true);
    if (!additive.ok) return;
    const control = additive.value.envelope.contributions.find(
      (entry) => entry.kind === COMPOSER_CONTROL_KIND,
    );
    expect(control?.kind).toBe(COMPOSER_CONTROL_KIND);
    if (control?.kind !== COMPOSER_CONTROL_KIND) return;
    expect(control.behavior).toBe("one-shot-return");
    expect(control.operation.companionCommand).toBe("alpha-refine-companion");
  });

  it("agrees on every composer-control verdict", () => {
    const fixture = readFixture();
    for (const entry of fixture.controls) {
      const parsed = parseComposerControlContribution(entry.input);
      if (entry.expect === "ok") expect(parsed.ok, entry.name).toBe(true);
      else expectError(parsed, entry.code);
    }
  });

  it("resolves same-owner references and refuses foreign actions", () => {
    const fixture = readFixture();
    for (const entry of fixture.references) {
      const entries = entry.entries ?? [];
      let last: { ok: boolean; error?: { code: string } } | undefined;
      for (const item of entry.controls ?? []) {
        const control = parseComposerControlContribution(item.control);
        expect(control.ok, entry.name).toBe(true);
        if (control.ok) {
          last = resolveComposerControlTargets(item.ownerId, control.value, entries);
        }
      }
      if (entry.expect === "ok") {
        expect(last?.ok, entry.name).toBe(true);
        for (const item of entry.controls ?? []) {
          const control = parseComposerControlContribution(item.control);
          if (!control.ok) continue;
          const resolved = resolveComposerControlTargets(item.ownerId, control.value, entries);
          expect(resolved.ok, `${entry.name}: ${item.ownerId}`).toBe(true);
          if (resolved.ok) {
            expect(resolved.value.operation.publicCommand).toBe(
              control.value.operation.publicCommand,
            );
          }
        }
      } else {
        expectError(last ?? { ok: true }, entry.code);
      }
    }
  });

  it("requires both live commands to share one extension source", () => {
    const fixture = readFixture();
    for (const entry of fixture.sourceBinding) {
      const resolved = resolveComposerOperationCommands(
        entry.metadata as never,
        entry.commands as never,
        entry.expectedSource as never,
      );
      if (entry.expect === "ok") expect(resolved.ok, entry.name).toBe(true);
      else expectError(resolved, entry.code);
    }
  });

  it("agrees on every start request verdict", () => {
    const fixture = readFixture();
    for (const entry of fixture.requests) {
      const parsed = parseComposerTransformStartRequest(entry.input);
      if (entry.expect === "ok") {
        expect(parsed.ok, entry.name).toBe(true);
        if (parsed.ok) {
          expect(parsed.value.snapshot.attachments.length).toBe(1);
          expect(parsed.value.images?.[0]?.dataBase64).toBe("aGk=");
        }
      } else {
        expectError(parsed, entry.code);
      }
    }
  });

  it("agrees on every lifecycle frame verdict", () => {
    const fixture = readFixture();
    const parsers: Array<[Case[], (raw: unknown) => { ok: boolean; error?: { code: string } }]> = [
      [fixture.frames.started ?? [], parseComposerTransformStartedReceipt],
      [fixture.frames.progress ?? [], parseComposerTransformProgress],
      [fixture.frames.candidate ?? [], parseComposerTransformCandidate],
      [fixture.frames.status ?? [], parseComposerTransformStatus],
      [
        fixture.frames.cancel ?? [],
        (raw) => {
          const record = raw as Record<string, unknown>;
          return record && typeof record === "object" && "state" in record
            ? parseComposerTransformCancelReceipt(raw)
            : parseComposerTransformCancelRequest(raw);
        },
      ],
      [fixture.frames.apply ?? [], parseComposerTransformApplyReceipt],
      [fixture.frames.failures ?? [], parseComposerTransformFailure],
    ];
    for (const [cases, parser] of parsers) {
      for (const entry of cases) {
        const parsed = parser(entry.input);
        if (entry.expect === "ok") expect(parsed.ok, entry.name).toBe(true);
        else expectError(parsed, entry.code);
      }
    }
    expect(
      parseComposerTransformStatusRequest({
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: "req_alpha_0001",
        operationId: "op_alpha_0001",
      }).ok,
    ).toBe(true);
  });

  it("parses only the grant bootstrap string", () => {
    const fixture = readFixture();
    expect(formatComposerBootstrapArgs(fixture.bootstrap.grant)).toBe(fixture.bootstrap.args);
    expect(composerRendezvousChannel(fixture.bootstrap.grant.split(".")[0] ?? "")).toBe(
      fixture.bootstrap.channel,
    );
    for (const entry of fixture.bootstrap.cases) {
      const parsed = parseComposerBootstrapArgs(entry.input);
      if (entry.expect === "ok") expect(parsed.ok, entry.name).toBe(true);
      else expectError(parsed, entry.code);
    }
  });

  it("negotiates capability and falls back safely on an old host", () => {
    const fixture = readFixture();
    for (const entry of fixture.negotiation) {
      const negotiated = negotiateComposerTransform(entry.capabilities as never);
      if (entry.expect === "ok") {
        expect(negotiated.ok, entry.name).toBe(true);
        if (negotiated.ok && entry.expectFrameBytes !== undefined) {
          expect(negotiated.value.maxFrameBytes).toBe(entry.expectFrameBytes);
        }
      } else {
        expectError(negotiated, entry.code);
      }
    }
    expect(composerTransformFallback({ publicCommand: fixture.fallback.publicCommand })).toEqual(
      fixture.fallback.expect,
    );
  });

  it("enforces oversized and aggregate frame limits", () => {
    const limits = COMPOSER_TRANSFORM_LIMITS;
    const hugeText = { ...baseRequest() } as Record<string, unknown>;
    hugeText.snapshot = {
      ...(hugeText.snapshot as Record<string, unknown>),
      text: "x".repeat(limits.maxDraftTextChars + 1),
      selection: { start: 0, end: 1 },
    };
    expectError(parseComposerTransformStartRequest(hugeText), "oversized-text");

    const tooMany = { ...baseRequest() } as Record<string, unknown>;
    tooMany.snapshot = {
      ...(tooMany.snapshot as Record<string, unknown>),
      attachments: Array.from({ length: limits.maxAttachmentCount + 1 }, (_, index) => ({
        id: `image-${index}`,
        digest: `sha256:${index}`,
        mimeType: "image/png",
        byteLength: 1,
      })),
    };
    expectError(parseComposerTransformStartRequest(tooMany), "too-many-attachments");

    const oversized = { ...baseRequest() } as Record<string, unknown>;
    oversized.snapshot = {
      ...(oversized.snapshot as Record<string, unknown>),
      attachments: [
        {
          id: "image-1",
          digest: "sha256:a",
          mimeType: "image/png",
          byteLength: limits.maxAttachmentBytes + 1,
        },
      ],
    };
    expectError(parseComposerTransformStartRequest(oversized), "oversized-attachment");
    expectError(
      parseComposerTransformStartRequest(baseRequest(), 128),
      "aggregate-frame-too-large",
    );

    // In-band bytes above the cap are refused even when the descriptor claims
    // a size inside the cap.
    const inBand = { ...baseRequest() } as Record<string, unknown>;
    inBand.snapshot = {
      ...(inBand.snapshot as Record<string, unknown>),
      attachments: [
        {
          id: "image-1",
          digest: "sha256:a",
          mimeType: "image/png",
          byteLength: limits.maxAttachmentBytes,
        },
      ],
    };
    inBand.images = [
      {
        id: "image-1",
        mimeType: "image/png",
        dataBase64: "A".repeat(Math.ceil((limits.maxAttachmentBytes + 1) / 3) * 4),
      },
    ];
    expectError(parseComposerTransformStartRequest(inBand), "oversized-attachment");
  });

  it("never exposes draft, attachment, image or model data in diagnostics", () => {
    const fixture = readFixture();
    const request = { ...baseRequest() } as Record<string, unknown>;
    request.snapshot = {
      ...(request.snapshot as Record<string, unknown>),
      text: `${fixture.privacy.draftSentinel} please refine`,
      expandedText: `${fixture.privacy.draftSentinel} expanded`,
      selection: { start: 0, end: 10 },
      attachments: [
        {
          id: fixture.privacy.attachmentIdSentinel,
          digest: fixture.privacy.attachmentDigestSentinel,
          mimeType: "image/png",
          byteLength: 21,
        },
      ],
    };
    request.images = [
      {
        id: fixture.privacy.attachmentIdSentinel,
        mimeType: "image/png",
        dataBase64: fixture.privacy.imageSentinel,
      },
    ];
    request.model = fixture.privacy.modelSentinel;
    request.context = fixture.privacy.modelSentinel;
    const parsed = parseComposerTransformStartRequest(request);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const serialized = JSON.stringify(composerTransformDiagnostics(parsed.value));
    for (const sentinel of [
      fixture.privacy.draftSentinel,
      fixture.privacy.imageSentinel,
      fixture.privacy.attachmentDigestSentinel,
      fixture.privacy.attachmentIdSentinel,
      fixture.privacy.modelSentinel,
    ]) {
      expect(serialized.includes(sentinel), `leaked ${sentinel}`).toBe(false);
    }
    expect(COMPOSER_TRANSFORM_PRIVACY.neverLogged).toContain("candidate.text");
    expect(COMPOSER_TRANSFORM_PRIVACY.neverLogged).toContain("images[].dataBase64");
  });

  it("mints grants only from an injected CSPRNG and bounds request retention", () => {
    const random = (size: number) => new Uint8Array(size).fill(7);
    const minted = mintComposerGrant(random);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const formatted = formatComposerGrant(minted.value);
    const parsed = parseComposerBootstrapArgs(formatComposerBootstrapArgs(formatted));
    expect(parsed.ok).toBe(true);
    expect(mintComposerGrant(() => new Uint8Array(1)).ok).toBe(false);

    let seen: string[] = [];
    for (let index = 0; index < COMPOSER_TRANSFORM_LIMITS.maxRetainedReceipts; index += 1) {
      const remembered = rememberComposerRequestId(
        seen,
        `req_alpha_${String(index).padStart(4, "0")}`,
      );
      expect(remembered.duplicate).toBe(false);
      seen = remembered.ids;
    }
    expect(rememberComposerRequestId(seen, "req_alpha_0000").duplicate).toBe(true);
    expect(rememberComposerRequestId(seen, "req_alpha_9999").evicted).toBe("req_alpha_0000");
  });
});
