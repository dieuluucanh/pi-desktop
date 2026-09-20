import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCapabilitiesDialog } from "../../src/renderer/src/extensions/ExtensionCapabilitiesDialog";

/**
 * The "what extensions can do" page (plan step 23). It has to be honest about
 * the trust model — extensions run with the user's privileges and are not
 * sandboxed — while listing the gates the app does provide.
 */

describe("extension capabilities dialog", () => {
  it("states that extensions run with full privileges and are not sandboxed", () => {
    render(<ExtensionCapabilitiesDialog open onOpenChange={() => undefined} />);

    expect(screen.getByText(/your full privileges/i)).toBeInTheDocument();
    expect(screen.getByText(/does not sandbox them/i)).toBeInTheDocument();
    expect(screen.getByText(/run commands and spawn processes/i)).toBeInTheDocument();
  });

  it("lists the gates the app provides", () => {
    render(<ExtensionCapabilitiesDialog open onOpenChange={() => undefined} />);

    expect(screen.getByText(/project trust prompt/i)).toBeInTheDocument();
    expect(screen.getByText(/install consent dialog/i)).toBeInTheDocument();
    expect(screen.getByText(/safe mode/i)).toBeInTheDocument();
  });

  it("closes when acknowledged", async () => {
    const onOpenChange = vi.fn();
    render(<ExtensionCapabilitiesDialog open onOpenChange={onOpenChange} />);

    await userEvent.click(screen.getByRole("button", { name: /got it/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders nothing while closed", () => {
    render(<ExtensionCapabilitiesDialog open={false} onOpenChange={() => undefined} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
