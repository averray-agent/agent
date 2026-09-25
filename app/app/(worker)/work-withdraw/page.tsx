import type { Metadata } from "next";
import { WorkAccountDeposit } from "@/components/work/WorkAccountDeposit";
import { WorkWithdrawal } from "@/components/work/WorkWithdrawal";

// The worker layout's "Find paid work" title is right for the board, not for
// the withdraw tab.
export const metadata: Metadata = {
  title: "Averray · Withdraw"
};

export default function WorkWithdrawalPage() {
  return (
    <div className="grid gap-6">
      <WorkWithdrawal />
      <WorkAccountDeposit />
    </div>
  );
}
