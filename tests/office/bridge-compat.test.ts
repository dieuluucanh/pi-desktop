/**
 * Bridge version-skew rules and the delta stream buffer.
 *
 * The bridge ships on its own cadence, so these tests pin the three cases the
 * app must survive: an older bridge (finals only, no pane-side Stop), the
 * targeted version, and a newer one (additive, still compatible). They also
 * cover the v2→v3 delta semantics: deltas are a *preview* and the final reply
 * replaces them, so a bridge that never sends a delta still renders correctly.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_STREAM_CHARS,
  createStreamBuffer,
  parsePaneDocumentTag,
  projectBridgeCompatibility,
} from "../../src/shared/office-bridge";
import { PI_OFFICE_BRIDGE } from "../../src/shared/office";

describe("projectBridgeCompatibility", () => {
  it("targets protocol v3", () => {
    expect(PI_OFFICE_BRIDGE.knownProtocolVersion).toBe(3);
    expect(PI_OFFICE_BRIDGE.pinnedVersion).toBe("^0.6.0");
  });

  it("reports the current bridge as fully capable", () => {
    const compat = projectBridgeCompatibility({
      protocolVersion: 3,
      capabilities: ["http-health", "agent-deltas", "client-abort"],
      serverVersion: "0.5.0",
      catalogVersion: 3,
    });
    expect(compat).toMatchObject({
      shape: "current",
      supportsDeltas: true,
      supportsAbort: true,
      serverVersion: "0.5.0",
      summary: "",
    });
  });

  it("degrades an older bridge to finals only without failing", () => {
    // The bridge 0.4.x health payload: v2 and no capability advertisement.
    const compat = projectBridgeCompatibility({
      protocolVersion: 2,
      capabilities: null,
      serverVersion: "0.4.1",
      catalogVersion: 3,
    });
    expect(compat.shape).toBe("older");
    expect(compat.supportsDeltas).toBe(false);
    expect(compat.supportsAbort).toBe(false);
    expect(compat.summary).toMatch(/final replies only/i);
  });

  it("rejects a v1 bridge as unsupported", () => {
    const compat = projectBridgeCompatibility({ protocolVersion: 1, capabilities: null });
    expect(compat.shape).toBe("unsupported");
    expect(compat.supportsDeltas).toBe(false);
    expect(compat.supportsAbort).toBe(false);
    expect(compat.summary).toMatch(/too old/i);
  });

  it("treats a newer bridge as compatible, not broken", () => {
    const compat = projectBridgeCompatibility({
      protocolVersion: 4,
      capabilities: ["http-health", "agent-deltas", "client-abort", "something-new"],
    });
    expect(compat.shape).toBe("newer");
    expect(compat.supportsDeltas).toBe(true);
    expect(compat.supportsAbort).toBe(true);
    expect(compat.summary).toMatch(/newer/i);
  });

  it("honours capabilities over the version when they disagree", () => {
    // A v3 bridge that explicitly does not advertise deltas must not be assumed
    // to stream: the capability array is authoritative when it is present.
    const compat = projectBridgeCompatibility({
      protocolVersion: 3,
      capabilities: ["http-health"],
    });
    expect(compat.supportsDeltas).toBe(false);
    expect(compat.supportsAbort).toBe(false);
  });

  it("reports an unreachable bridge as unknown rather than unsupported", () => {
    const compat = projectBridgeCompatibility({ protocolVersion: null, capabilities: null });
    expect(compat.shape).toBe("unknown");
    expect(compat.supportsDeltas).toBe(false);
    expect(compat.summary).toMatch(/no Office session/i);
  });
});

describe("createStreamBuffer", () => {
  it("accumulates deltas and lets the final reply replace them", () => {
    const buffer = createStreamBuffer();
    buffer.begin("prompt-1");
    buffer.applyDelta({ text: "Hel", promptId: "prompt-1" });
    const mid = buffer.applyDelta({ text: "lo", promptId: "prompt-1" });
    expect(mid).toMatchObject({ text: "Hello", streaming: true, chunks: 2 });

    // The final message is authoritative: a bridge may drop or coalesce deltas,
    // so the app never trusts the concatenation.
    const final = buffer.applyFinal("Hello there");
    expect(final).toMatchObject({ text: "Hello there", streaming: false });
  });

  it("renders a finals-only bridge without any deltas", () => {
    const buffer = createStreamBuffer();
    buffer.begin(null);
    expect(buffer.snapshot().streaming).toBe(true);
    const final = buffer.applyFinal("Done, no streaming.");
    expect(final).toMatchObject({ text: "Done, no streaming.", streaming: false, chunks: 0 });
  });

  it("ignores a late delta from a superseded prompt", () => {
    const buffer = createStreamBuffer();
    buffer.begin("prompt-1");
    buffer.applyDelta({ text: "first", promptId: "prompt-1" });
    buffer.begin("prompt-2");
    buffer.applyDelta({ text: "second", promptId: "prompt-2" });
    const leaked = buffer.applyDelta({ text: "-stale", promptId: "prompt-1" });
    expect(leaked.text).toBe("second");
    expect(leaked.chunks).toBe(1);
  });

  it("adopts a promptId when the run began without one", () => {
    const buffer = createStreamBuffer();
    buffer.begin(null);
    buffer.applyDelta({ text: "a", promptId: "prompt-7" });
    expect(buffer.snapshot().promptId).toBe("prompt-7");
    expect(buffer.applyDelta({ text: "b", promptId: "prompt-8" }).text).toBe("a");
  });

  it("caps the preview buffer but still accepts the final text", () => {
    const buffer = createStreamBuffer();
    buffer.begin(null);
    const chunk = "x".repeat(50_000);
    for (let index = 0; index < 10; index += 1) buffer.applyDelta({ text: chunk });
    expect(buffer.snapshot().truncated).toBe(true);
    expect(buffer.snapshot().text.length).toBe(MAX_STREAM_CHARS);
    const final = buffer.applyFinal("short");
    expect(final).toMatchObject({ text: "short", truncated: false });
  });

  it("ends a stream without dropping the text it already showed", () => {
    const buffer = createStreamBuffer();
    buffer.begin(null);
    buffer.applyDelta({ text: "partial answer" });
    expect(buffer.end()).toMatchObject({ text: "partial answer", streaming: false });
    // Ending is idempotent and never resurrects the stream.
    expect(buffer.end().streaming).toBe(false);
  });

  it("resets on demand", () => {
    const buffer = createStreamBuffer();
    buffer.begin("p");
    buffer.applyDelta({ text: "text" });
    expect(buffer.reset()).toMatchObject({ text: "", streaming: false, promptId: null, chunks: 0 });
  });
});

describe("parsePaneDocumentTag", () => {
  it("reads the bridge's document tag", () => {
    expect(
      parsePaneDocumentTag('[office:excel "Book1.xlsx" id=url_sha256:abc]\nsummarize'),
    ).toEqual({
      host: "excel",
      documentName: "Book1.xlsx",
      documentId: "url_sha256:abc",
    });
  });

  it("handles an unsaved document without an id", () => {
    expect(parsePaneDocumentTag('[office:word "untitled"]\nhello')).toEqual({
      host: "word",
      documentName: null,
      documentId: null,
    });
  });

  it("returns null for an app-typed prompt", () => {
    expect(parsePaneDocumentTag("summarize the workbook")).toBeNull();
    expect(parsePaneDocumentTag("")).toBeNull();
  });

  it("keeps an unknown host readable", () => {
    expect(parsePaneDocumentTag('[office:visio "x"] hi')?.host).toBeNull();
  });
});
