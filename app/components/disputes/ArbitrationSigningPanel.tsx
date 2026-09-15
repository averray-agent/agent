"use client";

import { useEffect, useState } from "react";
import { mutate } from "swr";
import { WalletQrCode } from "@/components/auth/WalletQrCode";
import { useBoundedApi } from "@/lib/api/hooks";
import { swrFetcher } from "@/lib/api/client";
import { useWalletConnection } from "@/lib/auth/use-wallet-provider";
import { connectWallet, cancelWalletPairing, getActiveWalletProvider, sendWalletTransaction, type WalletProviderKind } from "@/lib/auth/wallet-provider.js";
import { arbitrationSigningState, arbitrationWalletOptions, sendPreparedArbitration, type PreparedArbitration, type LiveArbitration } from "@/lib/chain/arbitration.js";

const button = "rounded-lg border border-[var(--avy-line)] px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40";
interface DisputeRead { live?: LiveArbitration; chainStatus?: string; convergenceStatus?: string; txHash?: string; warning?: { expected: string; actual: string } }

export function ArbitrationSigningPanel({ disputeId, prepared }: { disputeId: string; prepared: PreparedArbitration | null }) {
  const wallet = useWalletConnection();
  const options = arbitrationWalletOptions(wallet.walletConnectAvailable);
  const detailKey = `/disputes/${encodeURIComponent(disputeId)}`;
  const detail = useBoundedApi<DisputeRead>(detailKey, { refreshInterval: 4_000, dedupingInterval: 1_000 });
  const [chainId, setChainId] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [receiptState, setReceiptState] = useState("not sent");
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (wallet.status !== "connected") { setChainId(null); return; }
      try {
        const { provider } = await getActiveWalletProvider();
        const chain = Number(await provider.request({ method: "eth_chainId" }));
        if (!cancelled) setChainId(chain);
        if (txHash) {
          const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] }) as { status?: string } | null;
          if (!cancelled) setReceiptState(receipt ? Number(receipt.status) === 1 ? "confirmed on chain; waiting for convergence" : "reverted — no resolution" : "pending");
        }
      } catch { if (!cancelled) setChainId(null); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 4_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [wallet.account, wallet.status, txHash]);
  useEffect(() => {
    if (detail.data?.chainStatus === "confirmed") void mutate("/disputes");
  }, [detail.data?.chainStatus, detail.data?.convergenceStatus]);
  const guard = arbitrationSigningState({ prepared, live: detail.error ? null : detail.data?.live, account: wallet.account, chainId });

  async function connect(kind: WalletProviderKind) {
    setError(null);
    try { await connectWallet(kind); } catch (cause) { setError(cause instanceof Error ? cause.message : "Wallet connection failed."); }
  }
  async function sign() {
    if (!prepared || !guard.allowed || sending || txHash) return;
    setSending(true); setError(null);
    try {
      const { provider } = await getActiveWalletProvider();
      const hash = await sendPreparedArbitration({ prepared, provider, sendTransaction: sendWalletTransaction,
        getLive: async () => (await swrFetcher(detailKey) as DisputeRead).live as LiveArbitration });
      if (typeof hash !== "string" || !/^0x[a-fA-F0-9]{64}$/u.test(hash)) throw new Error("Wallet returned no transaction hash. Check the wallet before retrying.");
      setTxHash(hash); setReceiptState("pending");
      void detail.mutate();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No transaction was sent."); }
    finally { setSending(false); }
  }
  return <section className="mt-4 grid gap-3 rounded-lg border border-[var(--avy-line)] p-4" aria-label="Hardware arbitration">
    <p className="text-sm">{options.notice}</p>
    <div className="flex flex-wrap gap-2">
      {options.walletConnect && <button type="button" className={button} disabled={sending} onClick={() => void connect("walletconnect")}>Connect phone with WalletConnect</button>}
      {options.injected && <button type="button" className={button} disabled={sending || !wallet.injectedAvailable} onClick={() => void connect("injected")}>Connect injected wallet</button>}
    </div>
    {wallet.pairingUri && <div className="grid gap-2"><WalletQrCode value={wallet.pairingUri} /><p>Scan with the arbitrator’s phone wallet. This connects only; signing comes next.</p><button type="button" className={button} onClick={() => void cancelWalletPairing()}>Cancel pairing</button></div>}
    {prepared && <dl className="grid gap-2 break-all text-xs">
      <div><dt>Escrow / job</dt><dd>{prepared.to}<br />{prepared.decoded.jobId}</dd></div>
      <div><dt>Worker payout / remaining</dt><dd>{prepared.workerPayout} {prepared.asset} / {prepared.remainingPayout} {prepared.asset}</dd></div>
      <div><dt>Reason (bytes32)</dt><dd>{prepared.decoded.reasonCode}</dd></div>
      <div><dt>Public rationale</dt><dd><a className="underline" href={prepared.decoded.metadataURI} target="_blank" rel="noreferrer">{prepared.decoded.metadataURI}</a></dd></div>
      <div><dt>Registered arbitrator / connected account</dt><dd>{prepared.arbitrator}<br />{wallet.account ?? "Not connected"}</dd></div>
      <div><dt>Live escrow / wallet chain</dt><dd>{detail.data?.live?.state === 5 ? "Disputed" : detail.data?.live?.state === 6 ? "Closed" : "Not available for arbitration"} / {chainId ?? "unknown"}</dd></div>
    </dl>}
    <p className="text-sm" role="status">{detail.data?.convergenceStatus === "confirmed" ? "Resolved on chain, converged." : detail.data?.chainStatus === "confirmed" ? "Resolved on chain; local convergence pending." : txHash ? receiptState : guard.reason}</p>
    {detail.data?.warning && <p role="alert">Chain payout differs from preparation: expected {detail.data.warning.expected} raw; actual {detail.data.warning.actual} raw. The receipt uses the chain payout.</p>}
    {txHash && <p className="break-all text-xs">Transaction: {txHash}</p>}
    <button type="button" className={button} disabled={!guard.allowed || sending || Boolean(txHash)} onClick={() => void sign()}>{sending ? "Waiting for wallet…" : "Sign with the arbitrator wallet"}</button>
    {(error || wallet.errorMessage) && <p role="alert" className="text-sm text-red-700">{error ?? wallet.errorMessage}</p>}
  </section>;
}
