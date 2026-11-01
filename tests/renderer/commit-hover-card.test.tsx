import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommitHoverCard } from "../../src/renderer/src/rail/CommitHoverCard";
import type { GitCommitEntry } from "../../src/shared/git";

/**
 * The commit hover card (commit-history plan step 4).
 *
 * The card is the only place the hash, author, date and body are visible, and
 * the only place they can be copied. These tests pin what it shows (the whole
 * message, all refs, the full sha) and how the two copy actions behave.
 */

const NOW = 1_700_000_000_000;
const SHA = "a".repeat(40);

function commit(overrides: Partial<GitCommitEntry> = {}): GitCommitEntry {
  return {
    sha: SHA,
    shortSha: "aaaaaaa",
    subject: "feat: add the rail",
    body: "",
    author: "Ada",
    at: NOW - 5 * 60_000,
    refs: [],
    head: false,
    ...overrides,
  };
}

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

function stubClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  if (originalExecCommand) {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: originalExecCommand,
    });
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
  vi.restoreAllMocks();
});

function renderCard(entry: GitCommitEntry = commit()): void {
  render(<CommitHoverCard entry={entry} branch="main" remotes={["origin"]} now={NOW} />);
}

describe("the commit hover card", () => {
  it("shows the message, refs, author, date and full sha", () => {
    renderCard(
      commit({
        body: "Body line one\nBody line two",
        refs: ["main", "origin/main", "v1.0"],
      }),
    );

    const byline = screen.getByTestId("commit-byline-aaaaaaa");
    expect(byline).toHaveTextContent("Ada");
    expect(byline).toHaveTextContent(new Date(NOW - 5 * 60_000).toLocaleString());
    expect(byline).toHaveTextContent("5m ago");
    expect(byline.className).toContain("items-center");
    expect(byline.className).not.toContain("flex-col");
    // No `Author`/`Date` labels: the first line is just the name and the time.
    expect(screen.queryByText("Author")).not.toBeInTheDocument();
    expect(screen.queryByText("Date")).not.toBeInTheDocument();

    const message = screen.getByTestId("commit-message-aaaaaaa");
    expect(message).toHaveTextContent("feat: add the rail");
    expect(message).toHaveTextContent("Body line one");
    const sha = screen.getByTestId("commit-hover-sha-aaaaaaa");
    expect(sha).toHaveTextContent(SHA);

    expect(screen.getByTestId("commit-hover-ref-main")).toHaveClass("text-accent");
    expect(screen.getByTestId("commit-hover-ref-origin/main")).toHaveClass("text-info");
    expect(screen.getByTestId("commit-hover-ref-v1.0")).toHaveClass("text-ink-muted");

    // The byline leads the commit header; the hash stays at the bottom.
    expect(byline.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(message.compareDocumentPosition(sha) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the message selectable and pre-wrapped", () => {
    renderCard(commit({ body: "Body" }));
    const message = screen.getByTestId("commit-message-aaaaaaa");
    expect(message).toHaveClass("select-text");
    expect(message).toHaveClass("whitespace-pre-wrap");
  });

  it("says (no message) only when both parts are empty", () => {
    renderCard(commit({ subject: "", body: "" }));
    expect(screen.getByTestId("commit-message-aaaaaaa")).toHaveTextContent("(no message)");
  });

  it("shows a body-only message without a placeholder", () => {
    renderCard(commit({ subject: "", body: "Only the body" }));
    const message = screen.getByTestId("commit-message-aaaaaaa");
    expect(message).toHaveTextContent("Only the body");
    expect(message).not.toHaveTextContent("(no message)");
  });

  it("copies the full hash", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    renderCard();

    await userEvent.click(screen.getByTestId("commit-copy-hash-aaaaaaa"));

    expect(writeText).toHaveBeenCalledWith(SHA);
    await waitFor(() =>
      expect(screen.getByTestId("commit-copy-hash-aaaaaaa")).toHaveTextContent("Copied"),
    );
  });

  it("copies the full message", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    renderCard(commit({ body: "Body line" }));

    await userEvent.click(screen.getByTestId("commit-copy-message-aaaaaaa"));

    expect(writeText).toHaveBeenCalledWith("feat: add the rail\n\nBody line");
    await waitFor(() =>
      expect(screen.getByTestId("commit-copy-message-aaaaaaa")).toHaveTextContent("Copied"),
    );
  });

  it("reports a denied clipboard", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });
    Reflect.deleteProperty(document, "execCommand");
    renderCard();

    await userEvent.click(screen.getByTestId("commit-copy-hash-aaaaaaa"));

    await waitFor(() =>
      expect(screen.getByTestId("commit-copy-hash-aaaaaaa")).toHaveTextContent("Copy failed"),
    );
  });

  it("disables Copy message when there is nothing to copy", () => {
    renderCard(commit({ subject: "", body: "" }));
    expect(screen.getByTestId("commit-copy-message-aaaaaaa")).toBeDisabled();
  });
});
