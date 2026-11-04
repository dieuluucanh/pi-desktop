import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseWorkflowStatus,
  workflowBadgeClass,
  workflowBorderClass,
} from "../src/shared/workflow-mode";

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

  it("declares the workflow-mode scan sources", () => {
    // `border-warn` only exists as a literal in `src/shared/workflow-mode.ts`,
    // which lives outside the renderer root, so its directory must be scanned.
    expect(css).toContain('@source "../../../shared"');
    // And the utility names are pinned explicitly (same order as the function).
    expect(css).toContain(
      '@source inline("border-line border-accent border-warn text-accent text-warn text-ink-faint")',
    );
  });
});

/**
 * The workflow-mode border class contract (plan step 3).
 *
 * `workflowBorderClass` returns Tailwind utility names at runtime. Tailwind only
 * generates a utility if it can see the literal in scanned source, so this test
 * ties the function's return values to the `@source inline(...)` declaration:
 * every class the function can return must be listed, and every listed class
 * must be returned. Adding a fourth mode (or renaming one) fails here instead of
 * silently producing an unstyled border.
 */
describe("workflow border class contract", () => {
  /** Every distinct class `workflowBorderClass` can return for a known mode. */
  const returned = [
    workflowBorderClass(parseWorkflowStatus("\u25b6 build")),
    workflowBorderClass(parseWorkflowStatus("\u23f8 plan")),
    workflowBorderClass(parseWorkflowStatus("\u25e6 commits:never")),
    workflowBorderClass(null),
    workflowBadgeClass(parseWorkflowStatus("\u25b6 build")),
    workflowBadgeClass(parseWorkflowStatus("\u23f8 plan")),
    workflowBadgeClass(parseWorkflowStatus("\u25e6 commits:never")),
    workflowBadgeClass(null),
  ];

  it("lists exactly the classes the function returns", () => {
    const declaration = /@source inline\("([^"]+)"\);/.exec(
      stripComments(readFileSync(STYLES_CSS, "utf8")),
    );
    expect(declaration).not.toBeNull();
    const declared = (declaration?.[1] ?? "").split(/\s+/).filter(Boolean);
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
