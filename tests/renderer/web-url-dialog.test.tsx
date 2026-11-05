import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { WebUrlDialog } from "../../src/renderer/src/web/WebUrlDialog";

/**
 * "Open URL in a tab" provenance (2026-11-05 renderer-port plan, step 4).
 *
 * The hint is how a pasted dev-server URL reveals that it belongs to Pi Desktop
 * itself, not to the project the user is working on. A project's server is a
 * different port, so it must stay silent.
 */

beforeEach(() => {
  useAppStore.setState({ webUrlDialogOpen: true, hint: null });
});

function typeUrl(value: string): void {
  fireEvent.change(screen.getByLabelText("URL"), { target: { value } });
}

describe("WebUrlDialog", () => {
  it("points out Pi Desktop's own dev origin", () => {
    render(<WebUrlDialog />);

    typeUrl(`${window.location.origin}/review`);

    expect(screen.getByTestId("web-url-self-origin")).toHaveTextContent(/own dev server/i);
  });

  it("does not claim another project's port", () => {
    render(<WebUrlDialog />);

    typeUrl("http://127.0.0.1:5173/");

    expect(screen.queryByTestId("web-url-self-origin")).toBeNull();
  });
});
