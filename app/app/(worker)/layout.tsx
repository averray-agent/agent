import type { Metadata } from "next";
import { AuthRefreshBridge } from "@/components/shell/AuthRefreshBridge";
import { PaperGridBackground } from "@/components/runs/PaperGridBackground";
import { WorkerHeader } from "@/components/work/WorkerHeader";

export const metadata: Metadata = {
  title: "Averray · Find paid work",
  description: "Browse paid tasks, claim with a browser wallet, submit against the real schema, and follow verification to a public receipt."
};

export default function WorkerLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AuthRefreshBridge />
      <PaperGridBackground />
      <div className="relative z-[1] min-h-screen">
        <WorkerHeader />
        <main className="mx-auto w-full max-w-[1180px] px-5 py-10 sm:px-8 sm:py-14">{children}</main>
        <footer className="mx-auto flex w-full max-w-[1180px] flex-col gap-2 border-t border-[var(--line)] px-5 py-8 text-xs text-[var(--muted)] sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <span>Same jobs, verifier, and public receipts as the agent workflow.</span>
          <a className="font-semibold text-[var(--accent)]" href="https://averray.com/trust/">How verification is framed →</a>
        </footer>
      </div>
    </>
  );
}
