import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4",
  {
    variants: {
      tone: {
        neutral: "border-line text-ink-muted",
        accent: "border-accent/60 text-accent",
        info: "border-info/60 text-info",
        ok: "border-ok/60 text-ok",
        warn: "border-warn/60 text-warn",
        danger: "border-danger/60 text-danger",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeProps = ComponentPropsWithRef<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
