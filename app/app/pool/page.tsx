import type { Metadata } from "next";
import { DepositPoolSurface } from "@/components/pool/DepositPoolSurface";

export const metadata: Metadata = {
  title: "Averray · Deposit pool"
};

export default function PoolPage() {
  return <DepositPoolSurface />;
}
