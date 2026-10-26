/**
 * Mermaid render policy (2026-10-26 session-parity plan step 19).
 *
 * Terminal Pi's `markdown.mermaid` setting has three values; the desktop honours
 * the same contract, so a user who turns diagrams off in terminal Pi sees code
 * fences here too. Pure so it can be tested without loading Mermaid.
 */

export type MermaidMode = "off" | "final" | "streaming";

export function normalizeMermaidMode(value: unknown): MermaidMode {
  return value === "off" || value === "streaming" ? value : "final";
}

/**
 * `off` never renders; `final` waits until the message stops streaming (a
 * half-written diagram is usually invalid and flickers); `streaming` renders as
 * it arrives.
 */
export function shouldRenderMermaid(mode: MermaidMode, streaming: boolean): boolean {
  if (mode === "off") return false;
  if (mode === "streaming") return true;
  return !streaming;
}
