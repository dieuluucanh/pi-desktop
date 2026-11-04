import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "../../src/renderer/src/ui/hover-card";

/**
 * The hover-card primitive (commit-history plan step 2).
 *
 * The History rows use it because a native `title` cannot host copy buttons or
 * selectable text. These tests pin the three behaviours the row relies on:
 * hover opens, keyboard focus opens, and Escape closes.
 */

function Harness() {
  return (
    <HoverCard openDelay={0} closeDelay={0}>
      <HoverCardTrigger asChild>
        <button type="button" data-testid="hover-trigger">
          Hover me
        </button>
      </HoverCardTrigger>
      <HoverCardContent data-testid="hover-content">Commit details</HoverCardContent>
    </HoverCard>
  );
}

describe("the hover-card primitive", () => {
  it("opens on hover", async () => {
    render(<Harness />);
    await userEvent.hover(screen.getByTestId("hover-trigger"));
    expect(await screen.findByTestId("hover-content")).toHaveTextContent("Commit details");
  });

  it("opens on keyboard focus", async () => {
    render(<Harness />);
    await userEvent.tab();
    expect(screen.getByTestId("hover-trigger")).toHaveFocus();
    expect(await screen.findByTestId("hover-content")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(<Harness />);
    await userEvent.hover(screen.getByTestId("hover-trigger"));
    expect(await screen.findByTestId("hover-content")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("hover-content")).not.toBeInTheDocument());
  });

  it("portals the content out of the trigger's tree", async () => {
    render(<Harness />);
    const trigger = screen.getByTestId("hover-trigger");
    await userEvent.hover(trigger);
    const content = await screen.findByTestId("hover-content");

    // The block scroller clips an in-rail absolute panel; a portal is the point.
    expect(trigger.contains(content)).toBe(false);
    expect(content.closest("[data-radix-popper-content-wrapper]")).not.toBeNull();
  });
});
