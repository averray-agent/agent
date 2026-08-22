"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { observeAppPerformance } from "@/lib/ui/app-performance.js";

export function AppPerformanceObserver() {
  const pathname = usePathname();

  useEffect(() => observeAppPerformance(pathname ?? "unknown"), [pathname]);
  return null;
}
