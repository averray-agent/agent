"use client";

import { useMemo, useState } from "react";
import { mutate } from "swr";
import type { Address } from "viem";
import { ExplorerLink } from "@/components/common/ExplorerLink";
import { useApi } from "@/lib/api/hooks";
import {
  buildFundingPlan,
  ensureWalletReady,
  formatRawUsdc,
  sendApprove,
  sendCreateJob,
  sendDeposit,
  verifyDraftCalldata,
  waitForReceipt,
  type FundingPlan,
} from "@/lib/wallet/funding";
import { getActiveWalletProvider, type Eip1193Provider } from "@/lib/auth/wallet-provider.js";
import { cn } from "@/lib/utils/cn";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type Phase =
  | "idle"
  | "preparing"
  | "ready"
  | "approving"
  | "depositing"
  | "creating"
  | "watching"
  | "live"
  | "failed";

const MONO = "font-[family-name:var(--font-mono)]";

/**
 * The signing half of C2. Renders the ops-script gates as a visible
 * checklist, re-reads live funding math through the connected wallet, and
 * sends approve → deposit → create with the draft's own calldata. The
 * signed-in SIWE wallet must be the connected signer.
 */
export function FundingFlow({
  draft,
  onboarding,
  expectedRewardRaw,
  wallet,
}: {
  draft: unknown;
  onboarding: unknown;
  expectedRewardRaw: bigint;
  wallet: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<FundingPlan | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txs, setTxs] = useState<{ approve?: string; deposit?: string; create?: string }>({});

  const draftRecord = asRecord(draft);
  const onboardingRecord = asRecord(onboarding);
  const token = asRecord(onboardingRecord.token);
  const draftId = typeof draftRecord.draftId === "string" ? draftRecord.draftId : null;
  const chainId = typeof onboardingRecord.chainId === "number" ? onboardingRecord.chainId : null;

  const verified = useMemo(
    () => verifyDraftCalldata(draft, onboarding, expectedRewardRaw),
    [draft, onboarding, expectedRewardRaw]
  );

  // While watching, poll the draft until the watcher matches it on-chain.
  const watchRequest = useApi<Record<string, unknown>>(
    phase === "watching" && draftId ? `/jobs/draft/${encodeURIComponent(draftId)}` : null,
    { refreshInterval: 10_000 }
  );
  const watchedStatus =
    typeof watchRequest.data?.status === "string" ? watchRequest.data.status : null;
  if (phase === "watching" && watchedStatus === "live") {
    setPhase("live");
    void mutate("/jobs?source=external&limit=100");
  }

  const addresses = {
    escrowCore: String(onboardingRecord.escrowCore ?? "") as Address,
    agentAccountCore: String(onboardingRecord.agentAccountCore ?? "") as Address,
    tokenAddress: String(token.address ?? "") as Address,
  };

  async function run<T>(next: Phase, action: () => Promise<T>): Promise<T | null> {
    setError(null);
    setPhase(next);
    try {
      return await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("failed");
      return null;
    }
  }

  async function prepare() {
    await run("preparing", async () => {
      const { provider } = await getActiveWalletProvider();
      if (!chainId) throw new Error("Live chainId unavailable from /poster/onboarding.");
      const ready = await ensureWalletReady(provider, { expectedWallet: wallet, chainId });
      const nextPlan = await buildFundingPlan(provider, { ...addresses, wallet: ready.account, verified });
      setAccount(ready.account);
      setPlan(nextPlan);
      setPhase("ready");
    });
  }

  async function refreshPlan(provider: Eip1193Provider, acct: Address) {
    const nextPlan = await buildFundingPlan(provider, { ...addresses, wallet: acct, verified });
    setPlan(nextPlan);
    return nextPlan;
  }

  async function stepApprove() {
    if (!account || !plan) return;
    await run("approving", async () => {
      const { provider } = await getActiveWalletProvider();
      const hash = await sendApprove(provider, account, addresses.tokenAddress, addresses.agentAccountCore, plan.depositRequiredRaw);
      setTxs((t) => ({ ...t, approve: hash }));
      if (!(await waitForReceipt(provider, hash))) throw new Error("Approve transaction reverted.");
      await refreshPlan(provider, account);
      setPhase("ready");
    });
  }

  async function stepDeposit() {
    if (!account || !plan) return;
    await run("depositing", async () => {
      const { provider } = await getActiveWalletProvider();
      const hash = await sendDeposit(provider, account, addresses.agentAccountCore, addresses.tokenAddress, plan.depositRequiredRaw);
      setTxs((t) => ({ ...t, deposit: hash }));
      if (!(await waitForReceipt(provider, hash))) throw new Error("Deposit transaction reverted.");
      await refreshPlan(provider, account);
      setPhase("ready");
    });
  }

  async function stepCreate() {
    if (!account) return;
    await run("creating", async () => {
      const { provider } = await getActiveWalletProvider();
      const hash = await sendCreateJob(provider, account, verified);
      setTxs((t) => ({ ...t, create: hash }));
      if (!(await waitForReceipt(provider, hash))) throw new Error("Create-job transaction reverted.");
      setPhase("watching");
    });
  }

  const busy = ["preparing", "approving", "depositing", "creating"].includes(phase);
  const label = (text: string) => (
    <span className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]" style={{ letterSpacing: "0.1em" }}>
      {text}
    </span>
  );
  const button = (text: string, onClick: () => void, enabled: boolean) => (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled || busy}
      className={cn(
        "rounded-[8px] border px-3.5 py-2 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase",
        enabled && !busy
          ? "border-[var(--avy-accent)] bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]"
          : "border-[var(--avy-line)] bg-[#faf8f1] text-[var(--avy-muted)]"
      )}
      style={{ letterSpacing: "0.1em" }}
    >
      {text}
    </button>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        {label("Calldata gates (draft verified against live /poster/onboarding)")}
        <ul className="flex flex-col gap-0.5">
          {verified.gates.map((gate) => (
            <li key={gate.label} className={cn("text-[12px]", MONO, gate.pass ? "text-[#1e6642]" : "text-[#b22222]")}>
              {gate.pass ? "✓" : "✗"} {gate.label}
              {!gate.pass ? ` — ${gate.detail}` : ""}
            </li>
          ))}
        </ul>
      </div>

      {!verified.allPass ? (
        <p className="text-[12.5px] text-[#b22222]">
          A gate failed — nothing will be sent. This draft's calldata does not
          match the live platform configuration.
        </p>
      ) : phase === "idle" || phase === "preparing" ? (
        <div>{button(phase === "preparing" ? "Connecting…" : "Prepare funding (connect wallet)", prepare, phase === "idle")}</div>
      ) : null}

      {plan && verified.allPass ? (
        <div className="flex flex-col gap-1">
          {label("Live funding math (read through your wallet's RPC)")}
          <dl className={cn("grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[12px]", MONO)}>
            <dt className="text-[var(--avy-muted)]">worker receives</dt>
            <dd>{formatRawUsdc(verified.rewardRaw)} USDC (full reward)</dd>
            <dt className="text-[var(--avy-muted)]">protocol fee ({plan.feeBps} bps, additive)</dt>
            <dd>{formatRawUsdc(plan.feeRaw)} USDC</dd>
            <dt className="text-[var(--avy-muted)]">you reserve in total</dt>
            <dd className="font-semibold">{formatRawUsdc(plan.posterReservedRaw)} USDC</dd>
            <dt className="text-[var(--avy-muted)]">escrow balance now</dt>
            <dd>{formatRawUsdc(plan.liquidRaw)} USDC</dd>
            <dt className="text-[var(--avy-muted)]">deposit required</dt>
            <dd>{formatRawUsdc(plan.depositRequiredRaw)} USDC</dd>
            <dt className="text-[var(--avy-muted)]">wallet USDC</dt>
            <dd>
              {formatRawUsdc(plan.walletUsdcRaw)} USDC{" "}
              {!plan.walletCovers ? <span className="text-[#b22222]">— insufficient for the deposit</span> : null}
            </dd>
          </dl>
        </div>
      ) : null}

      {plan && verified.allPass && !["live", "watching"].includes(phase) ? (
        <div className="flex flex-wrap items-center gap-2">
          {plan.needsApprove
            ? button(phase === "approving" ? "Approving…" : `1 · Approve ${formatRawUsdc(plan.depositRequiredRaw)} USDC`, stepApprove, plan.walletCovers)
            : label("approve · not needed")}
          {plan.needsDeposit
            ? button(
                phase === "depositing" ? "Depositing…" : `2 · Deposit ${formatRawUsdc(plan.depositRequiredRaw)} USDC`,
                stepDeposit,
                plan.walletCovers && !plan.needsApprove
              )
            : label("deposit · not needed")}
          {button(
            phase === "creating" ? "Creating…" : "3 · Create job (draft calldata)",
            stepCreate,
            !plan.needsDeposit || plan.liquidRaw >= plan.posterReservedRaw
          )}
        </div>
      ) : null}

      {phase === "watching" ? (
        <p className={cn("text-[12px] text-[var(--avy-muted)]", MONO)}>
          Funded — waiting for the watcher to match the on-chain job by
          specHash (draft status: {watchedStatus ?? "checking…"}). This page
          polls every 10s.
        </p>
      ) : null}
      {phase === "live" ? (
        <p className="text-[13px] font-semibold text-[#1e6642]">
          Live — your bounty is in the external catalog and appears under “My
          posted jobs”.
        </p>
      ) : null}
      {watchedStatus && watchedStatus !== "live" && (watchedStatus.startsWith("mismatch") || watchedStatus === "expired") ? (
        <p className="text-[12.5px] text-[#b22222]">
          Watcher reports terminal draft status “{watchedStatus}” — contact the
          operator; funds only ever refund to your wallet.
        </p>
      ) : null}

      {(txs.approve || txs.deposit || txs.create) ? (
        <div className={cn("flex flex-col gap-0.5 text-[12px]", MONO)}>
          {txs.approve ? <span>approve: <ExplorerLink kind="tx" value={txs.approve} /></span> : null}
          {txs.deposit ? <span>deposit: <ExplorerLink kind="tx" value={txs.deposit} /></span> : null}
          {txs.create ? <span>create: <ExplorerLink kind="tx" value={txs.create} /></span> : null}
        </div>
      ) : null}

      {error ? <p className="break-all text-[12.5px] text-[#b22222]">{error}</p> : null}
    </div>
  );
}
