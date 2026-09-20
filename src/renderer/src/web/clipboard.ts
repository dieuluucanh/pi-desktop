/**
 * Clipboard helper for the web chrome (plan step 21).
 *
 * `navigator.clipboard` needs a secure context and the packaged renderer loads
 * from `file://`, so the DOM `execCommand("copy")` fallback is the one that
 * actually runs on Windows. Kept out of `WebTabView.tsx` so that module exports
 * only a component (react-refresh).
 */
export function copyToClipboard(text: string): boolean {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => undefined);
    return true;
  }
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = typeof document.execCommand === "function" ? document.execCommand("copy") : false;
  area.remove();
  return ok;
}
