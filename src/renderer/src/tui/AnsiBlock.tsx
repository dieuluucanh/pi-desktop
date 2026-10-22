import type { CSSProperties, ReactElement } from "react";

import { parseAnsiLine, visibleWidth, type AnsiSpan, type AnsiStyle } from "../../../shared/ansi";
import type { TuiFrame } from "../../../shared/tui-surface";
import { isSelectedSpan, selectedSpanStyle, SELECTED_SPAN_CLASS } from "./selection";

/**
 * ANSI → HTML for the extension TUI surface (plan step 17).
 *
 * Extension components render to ANSI lines in the host; this turns each line
 * into styled spans (no `dangerouslySetInnerHTML`). SGR attributes and OSC-8
 * hyperlinks are the whole vocabulary a Pi component uses. Step 18 reuses this
 * for tool cards, so it stays a standalone primitive.
 *
 * The line is padded to the host's declared cell width so a background colour
 * and the hardware cursor line up with the terminal grid even when the line
 * mixes wide characters or emoji.
 */

/** Maps a parsed ANSI style onto React inline styles (inverse swaps fg/bg). */
export function ansiStyleToCss(style: AnsiStyle): CSSProperties {
  const fg = style.inverse ? style.bg : style.fg;
  const bg = style.inverse ? style.fg : style.bg;
  return {
    ...(fg ? { color: fg } : {}),
    ...(bg ? { backgroundColor: bg } : {}),
    ...(style.bold ? { fontWeight: 700 } : {}),
    ...(style.italic ? { fontStyle: "italic" } : {}),
    ...(style.underline || style.strike ? { textDecoration: "underline" } : {}),
    ...(style.strike ? { textDecorationLine: "line-through" } : {}),
    ...(style.dim ? { opacity: 0.6 } : {}),
    ...(style.hidden ? { visibility: "hidden" } : {}),
  };
}

function openHref(href: string): void {
  void window.pi?.openExternal(href).catch(() => undefined);
}

function AnsiSpanView({
  span,
  selected,
}: {
  span: AnsiSpan;
  /** Repaint a background-filled span with the app's selection style. */
  selected?: boolean;
}): ReactElement {
  const style =
    selected && isSelectedSpan(span.style)
      ? selectedSpanStyle(span.style)
      : ansiStyleToCss(span.style);
  const className = selected && isSelectedSpan(span.style) ? SELECTED_SPAN_CLASS : undefined;
  if (span.href) {
    return (
      <a
        href={span.href}
        style={style}
        className={className ? `underline ${className}` : "underline"}
        onClick={(event) => {
          // Electron owns external navigation; never let the app window navigate.
          event.preventDefault();
          openHref(span.href as string);
        }}
      >
        {span.text}
      </a>
    );
  }
  return (
    <span style={style} className={className}>
      {span.text}
    </span>
  );
}

export interface AnsiLineProps {
  line: string;
  /** Terminal columns the line should occupy. */
  width: number;
  /**
   * Repaint a background-filled span with the app's selection style (plan step
   * 2). Pi marks the selected element of an extension-drawn component with a
   * background fill; the app paints that with its own tokens.
   */
  selection?: boolean;
}

export function AnsiLine({ line, width, selection }: AnsiLineProps): ReactElement {
  const spans = parseAnsiLine(line);
  const pad = Math.max(0, width - visibleWidth(line));
  // The padding keeps the last span's background so a filled row stays filled.
  // A selection is the exception: it marks one element and must not bleed into
  // the rest of the line.
  const last = spans.length > 0 ? spans[spans.length - 1]! : undefined;
  const padStyle = last
    ? ansiStyleToCss(selection ? { ...last.style, bg: null } : last.style)
    : undefined;
  return (
    <div className="ansi-line whitespace-pre" data-ansi-line="">
      {spans.map((span, index) => (
        <AnsiSpanView key={index} span={span} selected={selection === true} />
      ))}
      {pad > 0 ? <span style={padStyle}>{" ".repeat(pad)}</span> : null}
    </div>
  );
}

export interface AnsiBlockProps {
  frame: TuiFrame;
  className?: string;
  /** See `AnsiLineProps.selection`. */
  selection?: boolean;
}

/** A whole rendered frame, one line per host row. */
export function AnsiBlock({ frame, className, selection }: AnsiBlockProps): ReactElement {
  return (
    <div className={className} data-tui-frame={frame.seq}>
      {frame.lines.map((line, index) => (
        <AnsiLine key={index} line={line} width={frame.width} selection={selection} />
      ))}
    </div>
  );
}
