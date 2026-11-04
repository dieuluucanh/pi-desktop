import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../../src/renderer/src/App";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { UiPrefs } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * Brand marks in the shell (plan step 28).
 *
 * The regression worth pinning is the one that would be invisible in review: the
 * logo replacing the app *name* rather than sitting beside it. Every mark is
 * decorative (`alt=""`, `aria-hidden`), so the text stays the accessible label —
 * which is also what the e2e and onboarding tests query by. Hence each case
 * asserts both halves: an image is present, and the name is still readable.
 *
 * The in-app title bar was removed in the minimal-session-ui plan: its brand
 * mark was the chrome's copy, and the welcome/onboarding marks are the two that
 * remain. This file now pins that the chrome header is gone and those marks
 * still behave.
 *
 * `getByRole("img")` is deliberately not used: `alt=""` makes these
 * `role="presentation"`. Vite inlines a mark this small as a `data:` URL (which
 * the renderer CSP allows), so the assertions are about the element and the copy,
 * never about pixels.
 */

/** Every decorative brand mark under `root`. */
function marks(root: HTMLElement | null): HTMLImageElement[] {
  return [...(root?.querySelectorAll<HTMLImageElement>('img[alt=""][aria-hidden="true"]') ?? [])];
}

function renderShell(prefs: Partial<UiPrefs> = {}): HTMLElement {
  const resolved: Partial<UiPrefs> = {
    privacyAcknowledged: true,
    onboardingCompletedAt: 1,
    ...prefs,
  };
  installBridge({ prefs: resolved });
  useAppStore.setState({
    view: "welcome",
    project: null,
    prefs: { ...DEFAULT_PREFS, ...resolved },
    paletteOpen: false,
    info: null,
    hint: null,
  });
  return render(<App />).container;
}

beforeEach(() => {
  installBridge();
});

describe("app chrome brand mark", () => {
  it("has no in-app title bar; the welcome mark is the remaining chrome mark", async () => {
    const container = renderShell();
    await screen.findAllByText("Pi Desktop");

    // The OS frame owns the window controls and title (minimal-session-ui step 1).
    expect(container.querySelector("header")).toBeNull();
    // The welcome heading's mark is the only brand image left in the shell.
    expect(marks(container).length).toBeGreaterThan(0);
  });

  it("keeps the mark out of the accessibility tree", async () => {
    renderShell();
    await screen.findAllByText("Pi Desktop");
    // The name beside it is the label; a decorative image that announced itself
    // would make "Pi Desktop" read twice to a screen reader.
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("welcome view brand mark", () => {
  it("keeps the heading's accessible name while adding the mark", async () => {
    const container = renderShell();
    await screen.findAllByText("Pi Desktop");

    const heading = screen.getByRole("heading", { name: "Pi Desktop" });
    expect(heading).toBeInTheDocument();
    // The mark sits in the heading's own row, not loose elsewhere on the page.
    expect(marks(heading.parentElement).length).toBeGreaterThan(0);
    // The title-bar copy is gone, so the welcome mark is the shell's only one.
    expect(marks(container).length).toBe(1);
  });
});

describe("onboarding brand mark", () => {
  it("shows the mark on the welcome step without changing the step title", async () => {
    // No `onboardingCompletedAt` is what opens the wizard on first run. It renders
    // into a Radix portal, so it is found on `document.body`, not in `container`.
    renderShell({ onboardingCompletedAt: null });

    expect(await screen.findByText("Welcome to Pi Desktop")).toBeInTheDocument();
    const wizard = await screen.findByTestId("onboarding-wizard");
    expect(marks(wizard).length).toBeGreaterThan(0);
    // The dialog's own label is pinned copy elsewhere; it must not have moved.
    expect(wizard.getAttribute("aria-label")).toBe("Set up Pi Desktop");
  });
});
