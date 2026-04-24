import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      tone: {
        neutral: "border-[var(--line)] bg-[var(--paper)] text-[var(--ink)]",
        success:
          "border-[color:rgba(30,102,66,0.24)] bg-[var(--accent-soft)] text-[var(--accent-hover)]",
        warn: "border-[color:rgba(167,97,34,0.24)] bg-[var(--warn-soft)] text-[var(--warn)]",
        muted: "border-[var(--line)] bg-transparent text-[var(--muted)]",
        accent: "border-transparent bg-[var(--accent)] text-white",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
