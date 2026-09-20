import { useEffect, useState } from "react";
import { useAppStore } from "../state/app-store";

/**
 * Applies an extension's `registerMarkdownTransformer` to user/assistant text
 * (plan step 18).
 *
 * The transformers are host functions (they cannot cross the frame boundary), so
 * the renderer asks the host to transform the text and re-renders when the
 * answer arrives. Requests are debounced and keyed on the text, so a streaming
 * message does not issue one round trip per delta. Until the transformed text
 * arrives the raw markdown is shown, which is exactly what a client without
 * transformers does.
 */

const TRANSFORM_DEBOUNCE_MS = 40;

/**
 * `MarkdownTransformContext.availableWidth`: a transformer (mermaid, for one)
 * uses it to decide whether a diagram fits. The transcript's real cell width is
 * measured per card; a fixed representative width keeps the transform stable
 * across resizes instead of re-requesting on every pixel.
 */
export const MARKDOWN_AVAILABLE_WIDTH = 100;

export type MarkdownMessageType = "user" | "assistant" | "assistant-thinking";

export function useMarkdownTransform(
  tabId: string | undefined,
  text: string,
  messageType: MarkdownMessageType,
  isStreaming: boolean,
  enabled = true,
): string {
  const transform = useAppStore((state) => state.extensionMarkdown);
  const [state, setState] = useState<{ key: string; text: string } | null>(null);
  const key = `${messageType}:${isStreaming ? 1 : 0}:${text}`;

  useEffect(() => {
    if (!enabled || !tabId || text.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void transform(tabId, {
        text,
        messageType,
        isStreaming,
        width: MARKDOWN_AVAILABLE_WIDTH,
      }).then((result) => {
        if (!cancelled && result) setState({ key, text: result.text });
      });
    }, TRANSFORM_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, key, tabId, text, messageType, isStreaming, transform]);

  return state?.key === key ? state.text : text;
}
