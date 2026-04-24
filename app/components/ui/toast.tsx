"use client";

import { Toaster as Sonner, toast } from "sonner";

export function Toaster() {
  return (
    <Sonner
      position="top-right"
      toastOptions={{
        classNames: {
          toast:
            "!bg-[var(--paper-solid)] !border !border-[var(--line)] !text-[var(--ink)] !rounded-[var(--radius)] !shadow-[var(--shadow)] !font-[family-name:var(--font-body)]",
          success:
            "!bg-[var(--accent-soft)] !border-[color:rgba(30,102,66,0.24)] !text-[var(--accent-hover)]",
          error:
            "!bg-[var(--warn-soft)] !border-[color:rgba(167,97,34,0.24)] !text-[var(--warn)]",
          description: "!text-[var(--muted)]",
        },
      }}
    />
  );
}

export { toast };
