import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Popover, PopoverContent, PopoverTrigger } from "../../src/renderer/src/ui/popover";

/**
 * The popover primitive (2026-11-15 notification-dismissal plan).
 *
 * The bell cannot use a menu: its content is a scrollable list with several
 * independent controls. These tests pin the light-dismiss contract — trigger
 * toggling, an outside click that still runs the clicked control, Escape with
 * focus return, and the portal the web-view overlay detector relies on.
 */

function Harness({ onOutside }: { onOutside: () => void }) {
  return (
    <div>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button">Open notifications</button>
        </PopoverTrigger>
        <PopoverContent data-testid="popover-content">
          <button type="button">Inner control</button>
        </PopoverContent>
      </Popover>
      <button type="button" onClick={onOutside}>
        Outside
      </button>
    </div>
  );
}

describe("the popover primitive", () => {
  it("opens on the trigger and toggles closed on a second click", async () => {
    const user = userEvent.setup();
    render(<Harness onOutside={() => undefined} />);
    const trigger = screen.getByRole("button", { name: "Open notifications" });

    await user.click(trigger);
    expect(screen.getByTestId("popover-content")).toBeInTheDocument();

    await user.click(trigger);
    await waitFor(() => expect(screen.queryByTestId("popover-content")).toBeNull());
  });

  it("keeps the content open when a control inside is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness onOutside={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "Open notifications" }));
    await user.click(screen.getByRole("button", { name: "Inner control" }));

    expect(screen.getByTestId("popover-content")).toBeInTheDocument();
  });

  it("closes on an outside click without swallowing the clicked control", async () => {
    const outside = vi.fn();
    const user = userEvent.setup();
    render(<Harness onOutside={outside} />);

    await user.click(screen.getByRole("button", { name: "Open notifications" }));
    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(outside).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId("popover-content")).toBeNull());
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness onOutside={() => undefined} />);
    const trigger = screen.getByRole("button", { name: "Open notifications" });

    await user.click(trigger);
    expect(await screen.findByTestId("popover-content")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("popover-content")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("portals the content out of the trigger's tree", async () => {
    const user = userEvent.setup();
    render(<Harness onOutside={() => undefined} />);
    const trigger = screen.getByRole("button", { name: "Open notifications" });

    await user.click(trigger);
    const content = await screen.findByTestId("popover-content");

    // The status-bar footer would clip an in-place panel, and the web-view
    // overlay detector keys on this wrapper.
    expect(trigger.contains(content)).toBe(false);
    expect(content.closest("[data-radix-popper-content-wrapper]")).not.toBeNull();
  });
});
