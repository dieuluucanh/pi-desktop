import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RelatedSessionsBar } from "../../src/renderer/src/session/RelatedSessionsBar";
import type { ArchivedRelatedSession } from "../../src/shared/related-session-archive";
import type { TabRecord } from "../../src/shared/session-ipc";

/**
 * Generic related-session navigation (orchestrator step 13). Arbitrary titles,
 * no extension name; a parent lists live and archived children, a child links
 * back to its parent, and a missing parent degrades honestly.
 */

const tab = (over: Partial<TabRecord> & { id: string }): TabRecord => ({
  kind: "session",
  cwd: "C:/work/app",
  title: over.id,
  sessionFile: `C:/sessions/${over.id}.jsonl`,
  status: "idle",
  createdAt: 1,
  lastActiveAt: 1,
  model: null,
  ...over,
});

const archived = (over: Partial<ArchivedRelatedSession> = {}): ArchivedRelatedSession => ({
  parentTabId: "parent",
  sessionRef: "child-old",
  sessionFile: "C:/sessions/child-old.jsonl",
  cwd: "C:/work/app",
  title: "Earlier task",
  relation: "child",
  closedAt: 5,
  ...over,
});

describe("RelatedSessionsBar", () => {
  it("renders nothing for an unrelated session", () => {
    const { container } = render(
      <RelatedSessionsBar
        active={tab({ id: "solo" })}
        tabs={[tab({ id: "solo" })]}
        archive={[]}
        onActivate={() => {}}
        onOpenArchived={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("links a child back to its live parent", () => {
    const onActivate = vi.fn();
    render(
      <RelatedSessionsBar
        active={tab({ id: "child", relatedParentTabId: "parent" })}
        tabs={[tab({ id: "parent", title: "Root" }), tab({ id: "child" })]}
        archive={[]}
        onActivate={onActivate}
        onOpenArchived={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("related-parent"));
    expect(onActivate).toHaveBeenCalledWith("parent");
    expect(screen.getByTestId("related-parent")).toHaveTextContent("Root");
  });

  it("lists live children and archived children for a parent", () => {
    const onActivate = vi.fn();
    const onOpenArchived = vi.fn();
    render(
      <RelatedSessionsBar
        active={tab({ id: "parent" })}
        tabs={[tab({ id: "parent" }), tab({ id: "child", relatedParentTabId: "parent" })]}
        archive={[archived()]}
        onActivate={onActivate}
        onOpenArchived={onOpenArchived}
      />,
    );

    fireEvent.click(screen.getByTestId("related-child"));
    expect(onActivate).toHaveBeenCalledWith("child");
    fireEvent.click(screen.getByTestId("related-archived"));
    expect(onOpenArchived).toHaveBeenCalledWith(archived());
  });

  it("does not duplicate an archived row for a live child with the same file", () => {
    render(
      <RelatedSessionsBar
        active={tab({ id: "parent" })}
        tabs={[
          tab({ id: "parent" }),
          tab({
            id: "child",
            relatedParentTabId: "parent",
            sessionFile: "C:/sessions/child-old.jsonl",
          }),
        ]}
        archive={[archived()]}
        onActivate={() => {}}
        onOpenArchived={() => {}}
      />,
    );
    expect(screen.queryByTestId("related-archived")).toBeNull();
  });

  it("says the parent is closed instead of inventing a tab", () => {
    render(
      <RelatedSessionsBar
        active={tab({ id: "child", relatedParentTabId: "gone" })}
        tabs={[tab({ id: "child" })]}
        archive={[]}
        onActivate={() => {}}
        onOpenArchived={() => {}}
      />,
    );
    expect(screen.getByTestId("related-parent-missing")).toHaveTextContent("Parent closed");
  });
});
