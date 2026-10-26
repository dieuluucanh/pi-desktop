import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TuiWidgetStrip } from "../../src/renderer/src/tui/TuiWidgetStrip";

/**
 * Component-factory widgets (2026-10-26 plan, step 5).
 *
 * The host renders a widget component to ANSI frames; this strip shows them
 * read-only above/below the editor dock. String-array widgets keep the separate
 * `WidgetStrip` path.
 */

const frame = {
  seq: 1,
  width: 20,
  height: 1,
  lines: ["\x1b[32mgreen widget\x1b[0m"],
  cursor: null,
};

describe("TuiWidgetStrip", () => {
  it("renders ANSI widget frames for its placement", () => {
    render(<TuiWidgetStrip frames={[frame]} placement="aboveEditor" />);
    expect(screen.getByText("green widget")).toBeInTheDocument();
    const strip = document.querySelector('[data-tui-widgets="aboveEditor"]');
    expect(strip).toBeTruthy();
    expect(strip?.className).toContain("overflow-y-auto");
  });

  it("renders nothing when there are no widgets", () => {
    const { container } = render(<TuiWidgetStrip frames={[]} placement="belowEditor" />);
    expect(container).toBeEmptyDOMElement();
  });
});
