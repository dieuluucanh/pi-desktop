import { Toaster as SonnerToaster } from "sonner";

/** Toast host (plan step 1): extension notifications and app errors land here. */
export function Toaster({ theme }: { theme: "dark" | "light" | "system" }) {
  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      closeButton
      toastOptions={{
        style: {
          background: "var(--color-surface)",
          border: "1px solid var(--color-line)",
          color: "var(--color-ink)",
        },
      }}
    />
  );
}
