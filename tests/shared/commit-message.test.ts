import { describe, expect, it } from "vitest";

import {
  COMMIT_BODY_MAX_LINES,
  COMMIT_MESSAGE_SYSTEM,
  COMMIT_SUBJECT_MAX,
  PATCH_TRUNCATED_MARKER,
  buildCommitMessagePrompt,
  cleanCommitMessage,
} from "../../src/shared/commit-message";
import {
  MAX_COMMIT_CONTEXT_BYTES,
  MAX_RECENT_COMMIT_SUBJECTS,
  sanitizeCommitMessage,
  type GitCommitContext,
} from "../../src/shared/git";
import { MAX_PROMPT_CHARS } from "../../src/shared/text-generation";

/**
 * The commit-message prompt and cleaner (2026-11-25 plan, step 14).
 *
 * The prompt is bounded by the wire constant, and the cleaner is the last line
 * of defence before `git commit`: whatever a model replies, the result is plain
 * text that `sanitizeCommitMessage` accepts.
 */

function context(overrides: Partial<GitCommitContext> = {}): GitCommitContext {
  return {
    projectPath: "C:/work/app",
    branch: "main",
    stat: " src/a.ts | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)",
    patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new",
    truncated: false,
    files: 1,
    insertions: 2,
    deletions: 2,
    recentSubjects: ["Add the rail", "Fix the composer"],
    ...overrides,
  };
}

describe("buildCommitMessagePrompt", () => {
  it("carries branch, stat, recent subjects and diff in order", () => {
    const { system, prompt } = buildCommitMessagePrompt(context());

    expect(system).toBe(COMMIT_MESSAGE_SYSTEM);
    expect(system).toContain("You write git commit messages.");
    expect(system).toContain("at most 72 characters");
    expect(system).toContain("No code fences, no labels, no trailers.");

    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("Staged files:\n src/a.ts | 4 ++--");
    expect(prompt).toContain("Recent commit subjects:\n- Add the rail\n- Fix the composer");
    expect(prompt).toContain("Diff:\ndiff --git a/src/a.ts b/src/a.ts");
    // The model is told not to describe the prompt itself.
    expect(prompt).toContain("Describe only the staged changes");
    expect(prompt).not.toContain(PATCH_TRUNCATED_MARKER);

    const branchAt = prompt.indexOf("Branch:");
    const statAt = prompt.indexOf("Staged files:");
    const recentAt = prompt.indexOf("Recent commit subjects:");
    const diffAt = prompt.indexOf("Diff:");
    expect(branchAt).toBeGreaterThanOrEqual(0);
    expect(statAt).toBeGreaterThan(branchAt);
    expect(recentAt).toBeGreaterThan(statAt);
    expect(diffAt).toBeGreaterThan(recentAt);
  });

  it("speaks for a detached HEAD and an empty index", () => {
    const { prompt } = buildCommitMessagePrompt(
      context({ branch: null, stat: "", patch: "", recentSubjects: [], files: 0 }),
    );

    expect(prompt).toContain("Branch: (detached)");
    expect(prompt).toContain("Staged files: no staged changes");
    expect(prompt).not.toContain("Recent commit subjects:");
    expect(prompt).toContain("Diff:");
  });

  it("caps the recent subjects at the agreed count", () => {
    const many = Array.from({ length: MAX_RECENT_COMMIT_SUBJECTS + 4 }, (_, index) => {
      return `Subject ${index}`;
    });
    const { prompt } = buildCommitMessagePrompt(context({ recentSubjects: many }));

    expect(prompt).toContain(`- Subject ${MAX_RECENT_COMMIT_SUBJECTS - 1}`);
    expect(prompt).not.toContain(`- Subject ${MAX_RECENT_COMMIT_SUBJECTS}`);
  });

  it("marks a truncated patch on its own line after the diff", () => {
    const { prompt } = buildCommitMessagePrompt(
      context({ patch: "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b", truncated: true }),
    );

    expect(prompt).toContain("+b\n(patch truncated)");
    expect(prompt.endsWith(PATCH_TRUNCATED_MARKER)).toBe(true);
  });

  it("keeps a 60 KB context inside the wire bound with no invented truncation", () => {
    const line = "+0123456789abcdef0123456789abcdef\n";
    const patch = `diff --git a/big b/big\n${line.repeat(Math.ceil(MAX_COMMIT_CONTEXT_BYTES / line.length))}`;
    const { prompt } = buildCommitMessagePrompt(context({ patch }));

    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt).not.toContain(PATCH_TRUNCATED_MARKER);
  });

  it("cuts a 200 KB patch at a line boundary inside the wire bound", () => {
    const line = "+0123456789abcdef0123456789abcdef\n";
    const patch = `diff --git a/huge b/huge\n${line.repeat(200_000 / line.length)}`;
    expect(patch.length).toBeGreaterThan(200_000);

    const { prompt } = buildCommitMessagePrompt(context({ patch }));

    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt.endsWith(`\n${PATCH_TRUNCATED_MARKER}`)).toBe(true);
    // The cut is a complete line from the patch, not a half line.
    const withoutMarker = prompt.slice(0, -`\n${PATCH_TRUNCATED_MARKER}`.length);
    expect(withoutMarker.endsWith(line.slice(0, -1))).toBe(true);
  });
});

describe("cleanCommitMessage", () => {
  const cases: ReadonlyArray<{ name: string; input: string; expected: string }> = [
    {
      name: "a plain subject and body",
      input: "Add the commit prompt builder\n\nIt bounds the patch and the reply.",
      expected: "Add the commit prompt builder\n\nIt bounds the patch and the reply.",
    },
    {
      name: "a fenced reply with a language tag",
      input: "```text\nfeat: add prompt builder\n\nBody line\n```",
      expected: "feat: add prompt builder\n\nBody line",
    },
    {
      name: "a tilde fence",
      input: "~~~\nfix: clean the reply\n~~~",
      expected: "fix: clean the reply",
    },
    {
      name: "a Commit message: label",
      input: "Commit message:\nAdd the prompt builder",
      expected: "Add the prompt builder",
    },
    {
      name: "a lowercase message: label",
      input: "message: fix the cleaner",
      expected: "fix the cleaner",
    },
    {
      name: "one pair of surrounding quotes",
      input: '"Add the prompt builder"',
      expected: "Add the prompt builder",
    },
    {
      name: "CRLF input",
      input: "fix: normalise newlines\r\n\r\nDrop trailing spaces\r\n",
      expected: "fix: normalise newlines\n\nDrop trailing spaces",
    },
    {
      name: "trailing whitespace and three blank lines",
      input: "subject   \n\n\n\nbody line   ",
      expected: "subject\n\nbody line",
    },
    {
      name: "a quote pair that does not wrap the message",
      input: '"feat: a" and "feat: b"',
      expected: '"feat: a" and "feat: b"',
    },
  ];

  for (const { name, input, expected } of cases) {
    it(`cleans ${name}`, () => {
      const message = cleanCommitMessage(input);
      expect(message).toBe(expected);
      if (message !== null) expect(sanitizeCommitMessage(message)).toBe(message);
    });
  }

  it("returns null for empty and whitespace-only replies", () => {
    expect(cleanCommitMessage("")).toBeNull();
    expect(cleanCommitMessage("   \n\n\t\n")).toBeNull();
    expect(cleanCommitMessage("```\n\n```")).toBeNull();
  });

  it("cuts an over-long subject at a word boundary", () => {
    const input =
      "Add a commit message prompt builder that bounds the whole patch to the wire limit";
    const message = cleanCommitMessage(input);
    expect(message).not.toBeNull();
    const subject = message?.split("\n")[0] ?? "";
    expect(subject.length).toBeLessThanOrEqual(COMMIT_SUBJECT_MAX);
    expect(subject.endsWith(" ")).toBe(false);
    expect(subject.startsWith("Add a commit message prompt builder")).toBe(true);
    // The cut falls between words, so the last character is not mid-word.
    expect(input.startsWith(subject)).toBe(true);
    expect(input[subject.length]).toBe(" ");
  });

  it("caps the body at six lines", () => {
    const body = Array.from({ length: 12 }, (_, index) => `Body line ${index + 1}`);
    const message = cleanCommitMessage(`feat: cap the body\n\n${body.join("\n")}`);
    expect(message).not.toBeNull();
    const lines = (message ?? "").split("\n");
    expect(lines[0]).toBe("feat: cap the body");
    expect(lines[1]).toBe("");
    expect(lines.slice(2)).toEqual(body.slice(0, COMMIT_BODY_MAX_LINES));
  });
});
