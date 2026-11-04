import { describe, expect, it } from "vitest";

import {
  LANGUAGE_BADGES,
  LANGUAGE_IDS,
  LANGUAGE_LABELS,
  isImagePath,
  isKnownLanguageId,
  languageBadge,
  languageIdForPath,
  languageLabel,
} from "../../src/shared/languages";

describe("languageIdForPath", () => {
  it("maps the common extensions, case-insensitively", () => {
    expect(languageIdForPath("src/app.ts")).toBe("typescript");
    expect(languageIdForPath("src/App.TSX")).toBe("typescriptreact");
    expect(languageIdForPath("lib/index.mjs")).toBe("javascript");
    expect(languageIdForPath("lib/view.jsx")).toBe("javascriptreact");
    expect(languageIdForPath("package.json")).toBe("json");
    expect(languageIdForPath("tsconfig.json")).toBe("jsonc");
    expect(languageIdForPath("styles/site.scss")).toBe("scss");
    expect(languageIdForPath("README.md")).toBe("markdown");
    expect(languageIdForPath("docs/page.mdx")).toBe("mdx");
    expect(languageIdForPath("main.py")).toBe("python");
    expect(languageIdForPath("main.go")).toBe("go");
    expect(languageIdForPath("main.rs")).toBe("rust");
    expect(languageIdForPath("Main.java")).toBe("java");
    expect(languageIdForPath("native/header.hpp")).toBe("cpp");
    expect(languageIdForPath("app.cs")).toBe("csharp");
    expect(languageIdForPath("run.sh")).toBe("shellscript");
    expect(languageIdForPath("init.lua")).toBe("lua");
    expect(languageIdForPath("Cargo.toml")).toBe("toml");
    expect(languageIdForPath(".editorconfig")).toBe("ini");
  });

  it("maps whole file names without extensions", () => {
    expect(languageIdForPath("Dockerfile")).toBe("dockerfile");
    expect(languageIdForPath("src/Containerfile")).toBe("dockerfile");
    expect(languageIdForPath(".env")).toBe("plaintext");
    expect(languageIdForPath(".gitignore")).toBe("plaintext");
    expect(languageIdForPath("Makefile")).toBe("plaintext");
  });

  it("falls back to plaintext for unknown and extensionless names", () => {
    expect(languageIdForPath("NOTICE")).toBe("plaintext");
    expect(languageIdForPath("data.xyz")).toBe("plaintext");
    expect(languageIdForPath(".env.local")).toBe("plaintext");
    expect(languageIdForPath("")).toBe("plaintext");
  });

  it("handles both path separators", () => {
    expect(languageIdForPath("src\\windows\\app.ts")).toBe("typescript");
  });
});

describe("language metadata", () => {
  it("has a label and badge for every id", () => {
    for (const id of LANGUAGE_IDS) {
      expect(LANGUAGE_LABELS[id].length).toBeGreaterThan(0);
      expect(languageLabel(id)).toBe(LANGUAGE_LABELS[id]);
      expect(languageBadge(id)).toBe(LANGUAGE_BADGES[id]);
      expect(languageBadge(id).length).toBeGreaterThan(0);
      expect(languageBadge(id).length).toBeLessThanOrEqual(4);
    }
  });

  it("recognises only known ids", () => {
    expect(isKnownLanguageId("typescript")).toBe(true);
    expect(isKnownLanguageId("plaintext")).toBe(true);
    expect(isKnownLanguageId("kotlin")).toBe(false);
    expect(isKnownLanguageId(42)).toBe(false);
  });

  it("detects image extensions", () => {
    expect(isImagePath("logo.PNG")).toBe(true);
    expect(isImagePath("icon.svg")).toBe(true);
    expect(isImagePath("photo.jpeg")).toBe(true);
    expect(isImagePath("app.ts")).toBe(false);
    expect(isImagePath("README.md")).toBe(false);
  });
});
