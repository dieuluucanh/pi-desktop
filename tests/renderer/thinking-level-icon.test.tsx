import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThinkingLevelIcon } from "../../src/renderer/src/session/ThinkingLevelIcon";

describe("ThinkingLevelIcon", () => {
  it("maps every level to its absolute fill step", () => {
    const cases: Array<[string, string]> = [
      ["off", "0"],
      ["minimal", "1"],
      ["low", "1"],
      ["medium", "2"],
      ["high", "3"],
      ["xhigh", "4"],
      ["max", "4"],
    ];
    for (const [level, fill] of cases) {
      const view = render(<ThinkingLevelIcon level={level} />);
      const svg = view.container.querySelector("svg");
      expect(svg).toHaveAttribute("data-level", level);
      expect(svg).toHaveAttribute("data-fill", fill);
      view.unmount();
    }
  });

  it("renders an empty outline for an unknown level but keeps the name", () => {
    render(<ThinkingLevelIcon level="ultra" />);
    const svg = screen.getByTestId("brain");
    expect(svg).toHaveAttribute("data-level", "ultra");
    expect(svg).toHaveAttribute("data-fill", "0");
    // Only the outline path exists; no clipped filled copy.
    expect(svg.querySelectorAll("path[clip-path]")).toHaveLength(0);
  });

  it("is presentational and gives each instance a unique clip id", () => {
    render(
      <>
        <ThinkingLevelIcon level="high" />
        <ThinkingLevelIcon level="max" />
      </>,
    );
    const icons = screen.getAllByTestId("brain");
    expect(icons).toHaveLength(2);
    for (const svg of icons) expect(svg).toHaveAttribute("aria-hidden", "true");

    const ids = icons.map((svg) => svg.querySelector("clipPath")?.getAttribute("id"));
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });
});
