import { beforeEach, describe, expect, it } from "vitest";

import { useFileClipboardStore } from "../../src/renderer/src/files/file-clipboard-store";

beforeEach(() => {
  useFileClipboardStore.getState().clear();
});

describe("file clipboard", () => {
  it("copies, cuts and clears a payload", () => {
    const store = useFileClipboardStore.getState();
    store.copy("C:\\work\\a", ["src/app.ts"]);
    expect(useFileClipboardStore.getState().clipboard).toEqual({
      sourceProjectPath: "C:\\work\\a",
      paths: ["src/app.ts"],
      mode: "copy",
    });

    store.cut("C:\\work\\a", ["src/app.ts"]);
    expect(useFileClipboardStore.getState().clipboard?.mode).toBe("cut");
    store.clear();
    expect(useFileClipboardStore.getState().clipboard).toBeNull();
  });

  it("allows cross-project paste while a payload exists", () => {
    const store = useFileClipboardStore.getState();
    expect(store.canPaste("C:\\work\\b")).toBe(false);
    store.copy("C:\\work\\a", ["a.ts"]);
    expect(store.canPaste("C:\\work\\b")).toBe(true);
  });

  it("clears when a copied path or its parent is renamed/deleted", () => {
    const store = useFileClipboardStore.getState();
    store.copy("C:\\work\\a", ["src/app.ts"]);
    store.forgetPath("C:\\work\\b", "src");
    expect(useFileClipboardStore.getState().clipboard).not.toBeNull();

    store.forgetPath("c:/work/a/", "src");
    expect(useFileClipboardStore.getState().clipboard).toBeNull();
  });

  it("does not clear for an unrelated sibling path", () => {
    const store = useFileClipboardStore.getState();
    store.copy("C:\\work\\a", ["src/app.ts"]);
    store.forgetPath("C:\\work\\a", "src/app.tsx");
    expect(useFileClipboardStore.getState().clipboard).not.toBeNull();
  });

  it("forgets every entry from a removed project", () => {
    const store = useFileClipboardStore.getState();
    store.copy("C:\\work\\a", ["a.ts"]);
    store.forgetProject("C:\\work\\b");
    expect(useFileClipboardStore.getState().clipboard).not.toBeNull();
    store.forgetProject("c:/work/a/");
    expect(useFileClipboardStore.getState().clipboard).toBeNull();
  });
});
