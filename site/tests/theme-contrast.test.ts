import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contrast gate for the site palette.
 *
 * `theme.css` keeps its light values on `:root` and its dark overrides on
 * `:root[data-theme="dark"]`, one literal declaration per line. This test reads
 * those two blocks directly, so a palette edit cannot silently ship unreadable
 * text. Decorative rgba() fills and shadows are intentionally not asserted.
 */
const themeCss = readFileSync(
  fileURLToPath(new URL("../src/styles/theme.css", import.meta.url)),
  "utf8",
);

const TEXT_MIN = 4.5;
const UI_MIN = 3;

function readBlock(selector: string): Map<string, string> {
  const start = themeCss.indexOf(selector);
  expect(start, `theme.css is missing the ${selector} block`).toBeGreaterThanOrEqual(0);
  const open = themeCss.indexOf("{", start);
  const close = themeCss.indexOf("}", open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);

  const tokens = new Map<string, string>();
  for (const line of themeCss.slice(open + 1, close).split("\n")) {
    const match = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line);
    if (match?.[1] && match[2]) tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

const lightTokens = readBlock(":root");
const darkTokens = new Map([...lightTokens, ...readBlock(':root[data-theme="dark"]')]);

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  expect(match, `not a hex colour: ${hex}`).not.toBeNull();
  const digits = match?.[1] ?? "";
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : digits;
  const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16));
  return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

interface Pair {
  fg: string;
  bg: string;
  min: number;
  note: string;
}

const pairs: Pair[] = [
  { fg: "--pi-text", bg: "--pi-bg", min: TEXT_MIN, note: "body copy" },
  { fg: "--pi-text-muted", bg: "--pi-bg", min: TEXT_MIN, note: "muted copy on the page" },
  { fg: "--pi-text-muted", bg: "--pi-card-bg", min: TEXT_MIN, note: "muted copy on a card" },
  { fg: "--pi-link", bg: "--pi-bg", min: TEXT_MIN, note: "prose links" },
  { fg: "--pi-link", bg: "--pi-card-bg", min: TEXT_MIN, note: "links on a card" },
  { fg: "--pi-link-hover", bg: "--pi-bg", min: TEXT_MIN, note: "prose link hover" },
  { fg: "--pi-nav-link", bg: "--pi-nav-bg", min: TEXT_MIN, note: "menu link" },
  { fg: "--pi-nav-link-hover", bg: "--pi-nav-bg", min: TEXT_MIN, note: "menu link hover" },
  { fg: "--pi-nav-active", bg: "--pi-nav-bg", min: TEXT_MIN, note: "active menu link" },
  {
    fg: "--pi-button-primary-fg",
    bg: "--pi-button-primary-bg",
    min: TEXT_MIN,
    note: "primary button",
  },
  {
    fg: "--pi-button-primary-fg",
    bg: "--pi-button-primary-bg-hover",
    min: TEXT_MIN,
    note: "primary button hover",
  },
  {
    fg: "--pi-button-secondary-fg",
    bg: "--pi-bg",
    min: TEXT_MIN,
    note: "secondary button",
  },
  {
    fg: "--pi-button-secondary-fg-hover",
    bg: "--pi-bg",
    min: TEXT_MIN,
    note: "secondary button hover",
  },
  { fg: "--pi-gold-fg", bg: "--pi-gold-bg", min: TEXT_MIN, note: "primary badge / platform chip" },
  { fg: "--pi-theme-icon", bg: "--pi-nav-bg", min: TEXT_MIN, note: "unselected theme icon" },
  { fg: "--pi-text", bg: "--pi-theme-active-bg", min: TEXT_MIN, note: "selected theme icon" },
  { fg: "--pi-focus-ring", bg: "--pi-bg", min: UI_MIN, note: "focus ring on the page" },
  {
    fg: "--pi-focus-ring",
    bg: "--pi-theme-active-bg",
    min: UI_MIN,
    note: "selected theme state",
  },
  {
    fg: "--pi-nav-active-underline",
    bg: "--pi-nav-bg",
    min: UI_MIN,
    note: "active menu underline",
  },
  { fg: "--pi-warning-border", bg: "--pi-card-bg", min: UI_MIN, note: "warning border" },
  { fg: "--pi-highlight-border", bg: "--pi-bg", min: UI_MIN, note: "detected-platform border" },
];

describe("site theme contrast", () => {
  for (const [theme, tokens] of [
    ["light", lightTokens],
    ["dark", darkTokens],
  ] as const) {
    describe(theme, () => {
      for (const pair of pairs) {
        it(`${pair.note}: ${pair.fg} on ${pair.bg}`, () => {
          const foreground = tokens.get(pair.fg);
          const background = tokens.get(pair.bg);
          expect(foreground, `${pair.fg} is not defined for ${theme}`).toBeDefined();
          expect(background, `${pair.bg} is not defined for ${theme}`).toBeDefined();
          expect(contrast(foreground ?? "", background ?? "")).toBeGreaterThanOrEqual(pair.min);
        });
      }
    });
  }
});
