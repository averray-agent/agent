"use client";

import { useState } from "react";
import { ArrowLeft, ExternalLink, Landmark, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { getClient, extractApiErrorMessage } from "@/lib/api/client";
import { useBoundedApi } from "@/lib/api/hooks";
import { signIn, WalletUnavailableError } from "@/lib/auth/siwe";
import { useAuth } from "@/lib/auth/use-auth";
import {
  ensureWalletReady,
  formatRawUsdc,
  getInjectedProvider,
  parseUsdcToRaw
} from "@/lib/wallet/funding";
import { withdrawalStandingFromIntent } from "@/lib/work/withdrawal-standing.js";
import { asRecord, text } from "./types";

export function WorkWithdrawal() {
  const auth = useAuth();
  const accountQuery = useBoundedApi<Record<string, unknown>>(
    auth.authenticated ? "/account/position?asset=USDC" : null
  );
  const [amount, setAmount] = useState("");
  const [intent, setIntent] = useState<Record<string, unknown> | null>(null);
  const [building, setBuilding] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  async function connect() {
    setError(null);
    try {
      await signIn();
    } catch (cause) {
      setError(cause instanceof WalletUnavailableError
        ? cause.message
        : cause instanceof Error ? cause.message : "Wallet sign-in failed.");
    }
  }

  async function buildIntent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = parseUsdcToRaw(amount);
    if (raw === null || raw <= 0n) {
      setError("Enter a positive USDC amount with no more than six decimal places.");
      return;
    }
    setBuilding(true);
    setError(null);
    setIntent(null);
    setTxHash(null);
    try {
      const built = await getClient().buildWithdrawTransactions({
        asset: "USDC",
        amount: raw.toString()
      });
      setIntent(built as unknown as Record<string, unknown>);
    } catch (cause) {
      setError(extractApiErrorMessage(cause) ?? (cause instanceof Error ? cause.message : "The withdrawal intent could not be built."));
    } finally {
      setBuilding(false);
    }
  }

  async function sendWithdrawal() {
    const provider = getInjectedProvider();
    const template = withdrawalTemplate(intent, auth.wallet);
    const chainId = Number(intent?.chainId);
    if (!provider) {
      setError("No injected EVM wallet is available in this browser.");
      return;
    }
    if (!template || !Number.isSafeInteger(chainId) || chainId <= 0 || !auth.wallet) {
      setError("The live withdrawal template is incomplete; nothing was sent.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const { account } = await ensureWalletReady(provider, {
        expectedWallet: auth.wallet,
        chainId
      });
      const hash = await provider.request({
        method: "eth_sendTransaction",
        params: [{
          from: account,
          to: template.to,
          data: template.data,
          value: "0x0"
        }]
      });
      setTxHash(typeof hash === "string" ? hash : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The wallet did not send the withdrawal.");
    } finally {
      setSending(false);
    }
  }

  if (!auth.checked) return <Skeleton className="h-80 w-full" />;
  if (!auth.authenticated) {
    return (
      <Card className="mx-auto max-w-2xl">
        <CardContent className="py-10">
          <Badge tone="muted">Wallet-owned earnings</Badge>
          <h1 className="mt-4 text-3xl font-semibold">Sign in to withdraw your earnings.</h1>
          <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">SIWE proves which AgentAccountCore balance is yours. Averray never receives your wallet key.</p>
          {error ? <p className="mt-4 text-sm text-[var(--warn)]" role="alert">{error}</p> : null}
          <Button className="mt-6" size="lg" onClick={() => void connect()}><Wallet />Sign in with wallet</Button>
        </CardContent>
      </Card>
    );
  }

  const account = asRecord(accountQuery.data?.account);
  const available = asRecord(account?.available);
  const availableRaw = text(available?.raw);
  const availableDisplay = text(available?.display);
  const standing = withdrawalStandingFromIntent(intent);

  return (
    <div className="grid gap-6">
      <a className="inline-flex w-fit items-center gap-2 text-sm font-semibold text-[var(--muted)] hover:text-[var(--accent)]" href="/work">
        <ArrowLeft className="h-4 w-4" />Back to open work
      </a>
      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-end">
        <div>
          <p className="eyebrow">Wallet-owned earnings</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Withdraw to your wallet.</h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">The backend returns an unsigned AgentAccountCore transaction. Verify it, then your connected wallet signs and broadcasts it.</p>
        </div>
        <div className="rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper-solid)] p-5">
          <span className="text-xs text-[var(--muted)]">Live available balance</span>
          {accountQuery.isLoading ? <Skeleton className="mt-2 h-8 w-36" /> : accountQuery.error ? (
            <button className="mt-2 block text-sm font-semibold text-[var(--warn)] underline underline-offset-4" onClick={() => void accountQuery.mutate()}>Retry balance read</button>
          ) : (
            <strong className="mt-2 block text-2xl">{availableDisplay ? `${availableDisplay} USDC` : "Unavailable"}</strong>
          )}
        </div>
      </section>

      <Card>
        <CardContent className="py-6">
          <form className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" onSubmit={buildIntent}>
            <label className="grid gap-2 text-sm font-semibold">
              Amount in USDC
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                aria-describedby="withdrawal-available"
              />
            </label>
            <Button disabled={building || !availableRaw} type="submit"><Landmark />{building ? "Building…" : "Build withdrawal"}</Button>
          </form>
          <p className="mt-2 text-xs text-[var(--muted)]" id="withdrawal-available">The amount is encoded to exact six-decimal USDC base units and checked against the live balance.</p>
          {error ? <p className="mt-4 text-sm text-[var(--warn)]" role="alert">{error}</p> : null}
        </CardContent>
      </Card>

      {standing ? <WithdrawalStandingCard standing={standing} /> : null}

      {intent ? (
        <Card>
          <CardContent className="py-6">
            <p className="eyebrow">Unsigned intent</p>
            <h2 className="mt-2 text-2xl font-semibold">Ready for your wallet to verify.</h2>
            <p className="mt-3 text-sm text-[var(--muted)]">Requested amount: {formatIntentAmount(intent)} USDC. The destination is the signed-in wallet.</p>
            <Button className="mt-5" disabled={sending} onClick={() => void sendWithdrawal()}>{sending ? "Waiting for wallet…" : "Review and send in wallet"}<ExternalLink /></Button>
            {txHash ? <p className="mt-4 break-all font-mono text-xs text-[var(--accent)]">Submitted {txHash}</p> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function WithdrawalStandingCard({ standing }: { standing: NonNullable<ReturnType<typeof withdrawalStandingFromIntent>> }) {
  const creditStatus = standing.creditInterest.registered
    ? "registered"
    : standing.creditInterest.eligible ? "eligible" : "not eligible";
  return (
    <Card>
      <CardContent className="py-6">
        <p className="eyebrow">What stays with you</p>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
          <StandingFact label="Claim tier" value={standing.claimTier} />
          <StandingFact label="Reputation tier" value={standing.reputationTier} />
          <StandingFact label="Badges" value={String(standing.badges)} />
          <StandingFact label="Waiver slots remaining" value={String(standing.waiverSlotsRemaining)} />
          <StandingFact label="Credit interest" value={creditStatus} />
        </div>
        <p className="mt-5 text-sm leading-relaxed text-[var(--ink)]">{standing.statement}</p>
        {standing.creditInterest.eligible ? (
          <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{standing.creditInterestStatement}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StandingFact({ label, value }: { label: string; value: string }) {
  return <div className="rounded-[var(--radius-sm)] bg-[var(--paper)] p-3"><span className="block text-xs text-[var(--muted)]">{label}</span><strong className="mt-1 block capitalize">{value}</strong></div>;
}

function withdrawalTemplate(intent: Record<string, unknown> | null, wallet?: string) {
  const templates = Array.isArray(intent?.templates) ? intent.templates : [];
  const template = asRecord(templates.find((entry) => asRecord(entry)?.step === "withdraw"));
  const from = text(template?.from);
  const to = text(template?.to);
  const data = text(template?.data);
  if (
    template?.unsigned !== true
    || !wallet
    || from.toLowerCase() !== wallet.toLowerCase()
    || !/^0x[0-9a-f]{40}$/iu.test(to)
    || !/^0x[0-9a-f]+$/iu.test(data)
  ) return null;
  return { to, data };
}

function formatIntentAmount(intent: Record<string, unknown>) {
  const withdrawal = asRecord(intent.withdrawal);
  const amount = asRecord(withdrawal?.amount);
  const display = text(amount?.display);
  if (display) return display;
  const raw = text(amount?.raw);
  return raw && /^[0-9]+$/u.test(raw) ? formatRawUsdc(BigInt(raw)) : "unavailable";
}
