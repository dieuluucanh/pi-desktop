import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnsiBlock, AnsiLine } from "../../src/renderer/src/tui/AnsiBlock";

/**
 * ANSI → HTML (plan step 17).
 *
 * Snapshot cases cover the whole vocabulary a Pi component emits: SGR colours
 * and attributes, 256/truecolor, OSC-8 hyperlinks, wide characters and emoji.
 * The padding case is the grid contract: a short line is padded to the host's
 * column count so backgrounds and the cursor stay aligned.
 */

describe("AnsiBlock", () => {
  it("renders colours, attributes and resets", () => {
    const { container } = render(
      <AnsiBlock
        frame={{
          seq: 1,
          width: 20,
          height: 1,
          lines: ["\x1b[1;31mred\x1b[22;39m plain"],
          cursor: null,
        }}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("renders 256-colour and truecolor spans", () => {
    const { container } = render(
      <AnsiBlock
        frame={{
          seq: 1,
          width: 20,
          height: 1,
          lines: ["\x1b[38;5;196m256\x1b[48;2;0;16;32m true\x1b[0m"],
          cursor: null,
        }}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("keeps wide characters and emoji intact", () => {
    const { container } = render(
      <AnsiBlock frame={{ seq: 1, width: 16, height: 1, lines: ["日本 👋🏽 ok"], cursor: null }} />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("renders OSC-8 hyperlinks", () => {
    const { container } = render(
      <AnsiBlock
        frame={{
          seq: 1,
          width: 20,
          height: 1,
          lines: ["see \x1b]8;;https://pi.dev\x07docs\x1b]8;;\x07 now"],
          cursor: null,
        }}
      />,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://pi.dev");
    expect(container.firstChild).toMatchSnapshot();
  });

  it("pads a short line to the frame width", () => {
    const { container } = render(<AnsiLine line="ab" width={5} />);
    expect(container.textContent).toBe("ab   ");
  });

  it("repaints a background-filled span with the app's selection style", () => {
    // Pi marks the selected element of an extension-drawn component with a
    // background fill (`theme.bg("selectedBg", …)`). With the selection flag
    // the app paints that with its own token; without it the raw terminal hex
    // is kept, exactly as before (plan step 2).
    const line = "\x1b[48;2;58;58;74m Scope \x1b[49m";

    const selected = render(<AnsiLine line={line} width={20} selection />);
    const marked = selected.container.querySelector("span");
    // The surface and the underline are token-driven classes; only the
    // foreground stays inline (it is Pi's own colour).
    expect(marked?.className).toContain("bg-selected");
    expect(marked?.className).toContain("decoration-accent");
    expect(marked?.style.fontWeight).toBe("600");

    selected.unmount();
    const plain = render(<AnsiLine line={line} width={20} />);
    const raw = plain.container.querySelector("span");
    expect(raw?.style.backgroundColor).toBe("rgb(58, 58, 74)");
    expect(raw?.className).toBe("");
  });

  it("never lets a selection bleed into the line padding", () => {
    // The padding copies the last span's background so a filled row stays
    // filled; a selection marks one element and must stop there.
    const { container } = render(
      <AnsiLine line={"\x1b[48;2;58;58;74m Scope \x1b[49m"} width={20} selection />,
    );
    const spans = container.querySelectorAll("span");
    const padding = spans[spans.length - 1];
    expect(padding?.textContent).toBe(" ".repeat(13));
    expect(padding?.style.backgroundColor).toBe("");
  });
});
