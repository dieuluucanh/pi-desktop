import { describe, expect, it } from "vitest";
import {
  MAX_RELATED_ARCHIVE,
  addArchivedRelatedSession,
  forgetArchivedRelatedSession,
  sanitizeRelatedArchive,
  type ArchivedRelatedSession,
} from "../../src/shared/related-session-archive";

/**
 * Durable related-session archive (orchestrator step 13). Navigation metadata
 * only: bounded, deduped, and never a transcript copy.
 */

const record = (over: Partial<ArchivedRelatedSession> = {}): ArchivedRelatedSession => ({
  parentTabId: "tab-parent",
  sessionRef: "tab-child",
  sessionFile: "C:/sessions/child.jsonl",
  cwd: "C:/work/app",
  title: "Task 2",
  relation: "child",
  closedAt: 10,
  ...over,
});

describe("sanitizeRelatedArchive", () => {
  it("keeps valid records and requires a folder", () => {
    expect(sanitizeRelatedArchive([record()])).toEqual([record()]);
    expect(sanitizeRelatedArchive([record({ cwd: "" })])).toEqual([]);
    expect(sanitizeRelatedArchive([record({ relation: "solo" as never })])).toEqual([]);
    expect(sanitizeRelatedArchive("nope")).toEqual([]);
  });

  it("drops control characters and duplicate parent/file pairs", () => {
    expect(sanitizeRelatedArchive([record({ title: "a\u0007b" })])).toEqual([]);
    const duplicate = sanitizeRelatedArchive([record(), record({ title: "newer", closedAt: 20 })]);
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]?.title).toBe("newer");
  });

  it("bounds the archive and sorts newest first", () => {
    const many = Array.from({ length: MAX_RELATED_ARCHIVE + 10 }, (_, index) =>
      record({ sessionRef: `tab-${index}`, sessionFile: `C:/s/${index}.jsonl`, closedAt: index }),
    );
    const parsed = sanitizeRelatedArchive(many);
    expect(parsed).toHaveLength(MAX_RELATED_ARCHIVE);
    expect(parsed[0]?.closedAt).toBe(MAX_RELATED_ARCHIVE + 9);
  });
});

describe("archive helpers", () => {
  it("adds without duplicating the same parent + file", () => {
    const next = addArchivedRelatedSession([record()], record({ title: "again" }));
    expect(next).toHaveLength(1);
    expect(next[0]?.title).toBe("again");
  });

  it("forgets by ref or file and leaves unrelated rows", () => {
    const other = record({
      parentTabId: "tab-other",
      sessionRef: "tab-x",
      sessionFile: "C:/sessions/other.jsonl",
    });
    expect(forgetArchivedRelatedSession([record(), other], { sessionRef: "tab-child" })).toEqual([
      other,
    ]);
    expect(
      forgetArchivedRelatedSession([record(), other], {
        sessionFile: "C:/sessions/child.jsonl",
      }),
    ).toEqual([other]);
  });
});
