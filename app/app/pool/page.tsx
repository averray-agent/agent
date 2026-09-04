import type { Metadata } from "next";
import { DepositPoolSurface } from "@/components/pool/DepositPoolSurface";
import mainnetDeployment from "../../../deployments/mainnet.json";

const poolGenerationManifest = {
  depositPoolV21: mainnetDeployment.contracts.depositPoolV21,
  legacyDepositPoolV2: mainnetDeployment.contracts.legacyDepositPoolV2
};

export const metadata: Metadata = {
  title: "Averray · Deposit pool"
};

export default function PoolPage() {
  return <DepositPoolSurface poolGenerationManifest={poolGenerationManifest} />;
}
