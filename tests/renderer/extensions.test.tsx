import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ExtensionsView } from "../../src/renderer/src/views/ExtensionsView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { appInfoFixture, installBridge } from "./fixtures";
import { DEFAULT_PREFS } from "../../src/shared/prefs";

/**
 * Plan step 1 keeps the shipped Office wizard reachable from day one: it lives
 * under Extensions → Integrations while the navigation is rebuilt, so it must
 * mount there (the wizard itself is covered by the Office suites).
 */

beforeEach(() => {
  installBridge();
  useAppStore.setState({ prefs: { ...DEFAULT_PREFS }, info: null });
});

describe("extensions view", () => {
  it("mounts the Pi for Office wizard under Integrations", async () => {
    const { container } = render(<ExtensionsView />);
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Pi for Office" })).toBeInTheDocument();
    expect(container.querySelector(".panel")).not.toBeNull();
    expect(container.querySelector(".steps")).not.toBeNull();
  });

  it("names the shared profile locations for packages and settings", () => {
    useAppStore.setState({ info: appInfoFixture() });
    render(<ExtensionsView />);
    expect(screen.getByText(/settings\.json$/)).toBeInTheDocument();
  });
});
