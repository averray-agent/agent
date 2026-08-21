"use client";

import { usePathname } from "next/navigation";
import { WorkJobDetail } from "@/components/work/WorkJobDetail";
import { workJobIdFromPath } from "@/lib/work/human-work.js";

export default function WorkJobPage() {
  const pathname = usePathname();
  const jobId = workJobIdFromPath(pathname);
  if (!jobId) {
    return <p className="rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper-solid)] p-6 text-sm text-[var(--warn)]">This task URL does not contain a readable job id. Return to the work board and open a listed task.</p>;
  }
  return <WorkJobDetail jobId={jobId} />;
}
