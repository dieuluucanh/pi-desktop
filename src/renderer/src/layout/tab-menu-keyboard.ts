/**
 * The keyboard entry point for a tab's context menu.
 *
 * Radix's `ContextMenuTrigger` opens only from a real `contextmenu` event, and
 * the platform emits none from the keyboard on macOS, so a focused chip
 * synthesizes one at its own rectangle. This lives outside `TabMenu.tsx` so
 * that file exports components only (the react-refresh lint rule).
 */

import type { KeyboardEvent } from "react";

import { isEditableTarget } from "../shortcuts/dom-keys";

export function openTabContextMenuFromKeyboard(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  if (isEditableTarget(event.target)) return;
  // Suppress the platform's own default action so the menu does not open twice.
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.bottom,
    }),
  );
}
