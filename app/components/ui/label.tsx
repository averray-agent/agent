"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils/cn";

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      "font-[family-name:var(--font-display)] text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]",
      className
    )}
    {...props}
  />
));
Label.displayName = "Label";
