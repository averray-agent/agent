import { WorkAccountDeposit } from "@/components/work/WorkAccountDeposit";
import { WorkWithdrawal } from "@/components/work/WorkWithdrawal";

export default function WorkWithdrawalPage() {
  return (
    <div className="grid gap-6">
      <WorkWithdrawal />
      <WorkAccountDeposit />
    </div>
  );
}
