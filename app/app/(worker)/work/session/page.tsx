"use client";

import { usePathname } from "next/navigation";
import { WorkSessionWorkspace } from "@/components/work/WorkSessionWorkspace";
import { workSessionIdFromPath } from "@/lib/work/human-work.js";

export default function WorkSessionPage() {
  const pathname = usePathname();
  const sessionId = workSessionIdFromPath(pathname);
  if (!sessionId) {
    return <p className="rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper-solid)] p-6 text-sm text-[var(--warn)]">This workspace URL does not contain a readable session id. Return to the work board and open your claimed task.</p>;
  }
  return <WorkSessionWorkspace sessionId={sessionId} />;
}
