import { encodeFunctionData, parseAbi } from "viem";
import { HUB_CHAIN_ID } from "../auth/wallet-provider.js";

const ABI = parseAbi(["function resolveDispute(bytes32 jobId,uint256 workerPayout,bytes32 reasonCode,string metadataURI)"]);
const address = /^0x[a-fA-F0-9]{40}$/u;

export function arbitrationSigningState({ prepared, live, account, chainId }) {
  if (!prepared || !live) return { allowed: false, reason: "Prepare a verdict and wait for live escrow state." };
  if (!address.test(account ?? "") || !address.test(prepared.arbitrator ?? "") || account.toLowerCase() !== prepared.arbitrator.toLowerCase()
    || live.arbitrator?.toLowerCase() !== prepared.arbitrator.toLowerCase()) {
    return { allowed: false, reason: "Connect the registered arbitrator wallet." };
  }
  if (Number(chainId) !== HUB_CHAIN_ID || prepared.chainId !== HUB_CHAIN_ID || live.chainId !== HUB_CHAIN_ID) {
    return { allowed: false, reason: "Switch the wallet to Polkadot Hub mainnet (420420419)." };
  }
  if (live.state !== 5) return { allowed: false, reason: "The live escrow must be Disputed before arbitration can be signed." };
  if (live.preparationId !== prepared.preparationId) return { allowed: false, reason: "This preparation was superseded. Prepare again." };
  try {
    const decoded = prepared.decoded;
    const payout = BigInt(decoded.workerPayout);
    if (payout < 0n || payout > BigInt(live.remainingPayoutRaw)) throw new Error("payout");
    if (!address.test(prepared.to) || prepared.to.toLowerCase() !== live.escrow?.toLowerCase()) throw new Error("escrow");
    const data = encodeFunctionData({ abi: ABI, functionName: "resolveDispute", args: [decoded.jobId, payout, decoded.reasonCode, decoded.metadataURI] });
    if (data.toLowerCase() !== prepared.data?.toLowerCase()) throw new Error("calldata");
    if (BigInt(prepared.value ?? 0) !== 0n) throw new Error("value");
  } catch {
    return { allowed: false, reason: "The prepared call or payout no longer matches the live escrow." };
  }
  return { allowed: true, reason: "Ready for the arbitrator's wallet signature." };
}

export async function sendPreparedArbitration({ prepared, provider, getLive, sendTransaction }) {
  const [accounts, chainId, live] = await Promise.all([
    provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" }), getLive()
  ]);
  const account = accounts?.[0];
  const guard = arbitrationSigningState({ prepared, live, account, chainId });
  if (!guard.allowed) throw new Error(guard.reason);
  return sendTransaction({ from: account, to: prepared.to, data: prepared.data, value: "0x0" });
}

export function arbitrationWalletOptions(walletConnectAvailable) {
  return { injected: true, walletConnect: walletConnectAvailable === true,
    notice: walletConnectAvailable ? "Pair the arbitrator's phone or use an injected wallet. Connecting does not sign a transaction."
      : "WalletConnect is unavailable: NEXT_PUBLIC_WC_PROJECT_ID and the rollout flag must be set in the app build. Use an injected arbitrator wallet." };
}
