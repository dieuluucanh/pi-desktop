import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTRIBUTION_TONE_CLASSES,
  contributionBorderClass,
  contributionTextClass,
} from "../src/renderer/src/session/contribution-tone";
import { CONTRIBUTION_TONES } from "../src/shared/extension-contributions";

/**
 * `styles.css` cascade-layering guard (2026-10-19).
 *
 * The app's document-level CSS broke the composer's workflow-mode border for
 * months of one afternoon: a bare `:focus-visible` at the top level is
 * *unlayered*, and an unlayered rule beats every `@layer` rule regardless of
 * specificity. Tailwind v4 emits `utilities` in a layer, so `.outline-none`
 * lost and a blue accent ring was painted over the mode border.
 *
 * The fix was to wrap the file's own rules in `@layer base`. This test is the
 * tripwire: it fails if a future hand-written rule is added *outside* that
 * layer, which is how the regression would come back.
 */

const STYLES_CSS = fileURLToPath(new URL("../src/renderer/src/styles.css", import.meta.url));

/** Strips comments so a brace inside a comment cannot confuse the scanner. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The characters at brace-depth 0, i.e. everything not inside an at-rule block. */
function topLevelText(css: string): string {
  let depth = 0;
  let out = "";
  for (const char of css) {
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      continue;
    }
    if (depth === 0) out += char;
  }
  return out;
}

describe("styles.css layering", () => {
  const raw = readFileSync(STYLES_CSS, "utf8");
  const css = stripComments(raw);

  it("imports the theme (which pulls in Tailwind) before any rule", () => {
    const firstRule = css.search(/[^@\s][^{]*\{/);
    const themeImport = css.indexOf('@import "./styles/tokens.css"');
    expect(themeImport).toBeGreaterThanOrEqual(0);
    // `tokens.css` is where `@import "tailwindcss"` lives, so it must be first.
    expect(themeImport).toBeLessThan(firstRule);
  });

  it("declares `@layer base` and keeps every rule inside it", () => {
    expect(css).toContain("@layer base {");
    // At depth 0 only at-rules (`@import`, `@source`, `@layer base {`) may
    // appear — never a selector block, which would be unlayered and win.
    const declarations = topLevelText(css)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of declarations) {
      expect(line.startsWith("@"), `unlayered top-level rule: ${line}`).toBe(true);
    }
  });

  it("keeps the semantic tone table inside the renderer scan root", () => {
    // The tone literals live in `src/renderer/src/session/contribution-tone.ts`,
    // under Tailwind's scan root; the inline list is still pinned so a directory
    // move cannot silently drop a utility again.
    expect(css).toContain("@source inline(");
  });
});

/**
 * The semantic tone class contract (orchestrator plan step 11).
 *
 * `contributionBorderClass`/`contributionTextClass` return Tailwind utilities at
 * runtime. Tailwind only generates a utility it can see as a literal in scanned
 * source, so this test ties the table to the `@source inline(...)` declaration:
 * every class the table can return must be listed, and every listed class must
 * be returned.
 */
describe("contribution tone class contract", () => {
  it("lists exactly the classes the tone table returns", () => {
    const declaration = /@source inline\("([^"]+)"\);/.exec(
      stripComments(readFileSync(STYLES_CSS, "utf8")),
    );
    expect(declaration).not.toBeNull();
    const declared = (declaration?.[1] ?? "").split(/\s+/).filter(Boolean);
    const returned = [
      ...CONTRIBUTION_TONE_CLASSES,
      // Null/unknown degrade to the neutral classes, which the table already
      // contains, so the call results add nothing new.
      contributionBorderClass(null),
      contributionTextClass(null),
      ...CONTRIBUTION_TONES.map((tone) => contributionBorderClass(tone)),
      ...CONTRIBUTION_TONES.map((tone) => contributionTextClass(tone)),
    ];
    expect([...new Set(returned)].sort()).toEqual([...new Set(declared)].sort());
  });
});

/**
 * Tab-strip scrollbar contract (2026-11-02 plan step 3). The strips ask for a
 * 2 px bar. Chromium 121+ lets the standard `scrollbar-width`/`scrollbar-color`
 * properties override `::-webkit-scrollbar`, so the strip must reset both to
 * `auto`; without that reset the pixel size is inert. A 2 px track also needs a
 * zero-width thumb ring, or the global 2 px ring would leave no visible thumb.
 */
describe("tab-strip scrollbar", () => {
  const css = stripComments(readFileSync(STYLES_CSS, "utf8"));

  it("resets the standard properties so the pixel size is effective", () => {
    const rule = /\.tab-strip-scrollbar\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/scrollbar-width:\s*auto;/);
    expect(rule).toMatch(/scrollbar-color:\s*auto;/);
  });

  it("is two pixels with a full-width thumb", () => {
    expect(css).toMatch(
      /\.tab-strip-scrollbar::-webkit-scrollbar\s*\{[^}]*width:\s*2px;[^}]*height:\s*2px;/,
    );
    expect(css).toMatch(/\.tab-strip-scrollbar::-webkit-scrollbar-thumb\s*\{[^}]*border:\s*0;/);
  });
});
