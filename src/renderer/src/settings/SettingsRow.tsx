import type { ReactNode } from "react";

/** One labelled preference row, shared by the Settings cards. */
export function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-sm">{label}</div>
      {hint ? <div className="text-xs text-ink-faint">{hint}</div> : null}
      {children}
    </div>
  );
}
