/**
 * The editor theme.
 *
 * Values are CSS variables from `styles/tokens.css`, so light/dark switching is
 * instant and no theme object has to be rebuilt. The `dark` flag only affects a
 * few CodeMirror defaults that our explicit rules override.
 */

import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export function editorTheme(fontSize: number): ReturnType<typeof EditorView.theme> {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        color: "var(--color-ink)",
        backgroundColor: "var(--color-canvas)",
        fontSize: `${fontSize}px`,
      },
      ".cm-content": {
        fontFamily: "var(--font-mono)",
        caretColor: "var(--color-accent)",
      },
      ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
      ".cm-gutters": {
        backgroundColor: "var(--color-canvas)",
        color: "var(--color-ink-faint)",
        borderRight: "1px solid var(--color-line)",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--color-raised) 55%, transparent)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in srgb, var(--color-raised) 70%, transparent)",
        color: "var(--color-ink-muted)",
      },
      ".cm-selectionBackground, ::selection": {
        backgroundColor: "color-mix(in srgb, var(--color-accent) 30%, transparent)",
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
      ".cm-matchingBracket": {
        backgroundColor: "color-mix(in srgb, var(--color-accent) 24%, transparent)",
        outline: "1px solid var(--color-accent)",
      },
      ".cm-searchMatch": {
        backgroundColor: "color-mix(in srgb, var(--color-warn) 32%, transparent)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in srgb, var(--color-accent) 38%, transparent)",
      },
      ".cm-panels": {
        backgroundColor: "var(--color-surface)",
        color: "var(--color-ink)",
        borderColor: "var(--color-line)",
      },
      ".cm-panels input, .cm-panels button": {
        backgroundColor: "var(--color-raised)",
        color: "var(--color-ink)",
        border: "1px solid var(--color-line)",
        borderRadius: "var(--radius-xs)",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "var(--color-raised)",
        border: "1px solid var(--color-line)",
        color: "var(--color-ink-muted)",
      },
    },
    { dark: false },
  );
}

export const editorHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: "var(--color-accent)" },
  { tag: [t.string, t.special(t.string)], color: "var(--color-ok)" },
  { tag: [t.number, t.bool, t.null], color: "var(--color-warn)" },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "var(--color-ink-faint)",
    fontStyle: "italic",
  },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--color-info)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--color-info)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--color-ink-muted)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--color-accent)" },
  { tag: [t.heading, t.strong], fontWeight: "600", color: "var(--color-ink)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--color-accent)", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--color-danger)" },
]);
