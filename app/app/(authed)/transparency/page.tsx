"use client";

import { TransparencyPanel, TransparencyRequestState } from "@/components/transparency/TransparencyPanel";
import { useTransparency } from "@/lib/api/hooks";

export default function TransparencyPage() {
  const transparency = useTransparency();

  if (transparency.isLoading && !transparency.data) {
    return <TransparencyRequestState state="loading" />;
  }
  if (transparency.error || !transparency.data) {
    return <TransparencyRequestState state="fallback" />;
  }
  return <TransparencyPanel data={transparency.data} />;
}
