"use client";

import { useState } from "react";
import { Coins, ExternalLink } from "lucide-react";
import type { Hex } from "viem";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { extractApiErrorMessage, swrFetcher } from "@/lib/api/client";
import { useBoundedApi } from "@/lib/api/hooks";
import { useAuth } from "@/lib/auth/use-auth";
import { getActiveWalletProvider, sendWalletTransaction } from "@/lib/auth/wallet-provider.js";
import { accountDepositTransactionsFromIntent } from "@/lib/work/account-deposit-transaction.js";
import { ensureWalletReady, parseUsdcToRaw, waitForReceipt } from "@/lib/wallet/funding";
import { asRecord, text } from "./types";

export function WorkAccountDeposit() {
  const auth = useAuth();
  const accountQuery = useBoundedApi<Record<string, unknown>>(
    auth.authenticated ? "/account/position?asset=USDC" : null
  );
  const [amount, setAmount] = useState("");
  const [intent, setIntent] = useState<Record<string, unknown> | null>(null);
  const [building, setBuilding] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!auth.checked || !auth.authenticated) return null;

  async function buildIntent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = parseUsdcToRaw(amount);
    if (raw === null || raw <= 0n) {
      setError("Enter a positive USDC amount with no more than six decimal places.");
      return;
    }
    setBuilding(true);
    setError(null);
    setStatus(null);
    setIntent(null);
    try {
      const built = await swrFetcher<Record<string, unknown>>([
        "/account/deposit/transactions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ asset: "USDC", amount: raw.toString() })
        }
      ]);
      setIntent(built);
    } catch (cause) {
      setError(extractApiErrorMessage(cause) ?? (cause instanceof Error
        ? cause.message
        : "The deposit intent could not be built."));
    } finally {
      setBuilding(false);
    }
  }

  async function sendDeposit() {
    const transactions = accountDepositTransactionsFromIntent(intent, auth.wallet);
    const chainId = Number(intent?.chainId);
    if (!transactions || !Number.isSafeInteger(chainId) || chainId <= 0 || !auth.wallet) {
      setError("The live deposit templates are incomplete; nothing was sent.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const { provider } = await getActiveWalletProvider();
      const { account } = await ensureWalletReady(provider, {
        expectedWallet: auth.wallet,
        chainId
      });
      setStatus("Approve Hub USDC in your wallet.");
      const approveHash = await sendWalletTransaction({ ...transactions[0], from: account });
      if (typeof approveHash !== "string" || !await waitForReceipt(provider, approveHash as Hex)) {
        throw new Error("The approval did not confirm successfully; the deposit was not sent.");
      }
      setStatus("Approval confirmed. Review the AgentAccountCore deposit in your wallet.");
      const depositHash = await sendWalletTransaction({ ...transactions[1], from: account });
      if (typeof depositHash !== "string" || !await waitForReceipt(provider, depositHash as Hex)) {
        throw new Error("The deposit did not confirm successfully. Re-read your account before retrying.");
      }
      setStatus(`Deposit confirmed ${depositHash}`);
      await accountQuery.mutate();
    } catch (cause) {
      setStatus(null);
      setError(cause instanceof Error ? cause.message : "The wallet did not complete the deposit.");
    } finally {
      setSending(false);
    }
  }

  const account = asRecord(accountQuery.data?.account);
  const chainLiquid = asRecord(account?.chainLiquid);
  const chainLiquidDisplay = text(chainLiquid?.display);

  return (
    <Card>
      <CardContent className="py-6">
        <p className="eyebrow">Add claim funds</p>
        <div className="mt-2 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
          <div>
            <h2 className="text-2xl font-semibold">Deposit Hub USDC into your account.</h2>
            <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
              AgentAccountCore has no depositFor: nobody can deposit on your behalf. A brokered claim does not broker the deposit. Your wallet approves and deposits, and you pay gas in DOT for both transactions.
            </p>
          </div>
          <div className="rounded-[var(--radius-sm)] bg-[var(--paper)] p-4">
            <span className="text-xs text-[var(--muted)]">Live AgentAccountCore liquid</span>
            <strong className="mt-1 block text-xl">
              {chainLiquidDisplay ? `${chainLiquidDisplay} USDC` : "Unavailable"}
            </strong>
          </div>
        </div>

        <form className="mt-6 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" onSubmit={buildIntent}>
          <label className="grid gap-2 text-sm font-semibold">
            Amount in USDC
            <Input
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <Button disabled={building || sending} type="submit">
            <Coins />{building ? "Building…" : "Build deposit"}
          </Button>
        </form>
        <p className="mt-2 text-xs text-[var(--muted)]">
          The backend derives both templates from the published worker funding recipe and encodes the amount as exact six-decimal USDC base units.
        </p>
        {error ? <p className="mt-4 text-sm text-[var(--warn)]" role="alert">{error}</p> : null}
        {status ? <p className="mt-4 break-all text-sm text-[var(--accent)]" role="status">{status}</p> : null}

        {intent ? (
          <div className="mt-6 border-t border-[var(--line)] pt-5">
            <p className="text-sm text-[var(--muted)]">
              The approval must confirm on chain before the deposit can be sent.
            </p>
            <Button className="mt-4" disabled={sending} onClick={() => void sendDeposit()}>
              {sending ? "Waiting for confirmation…" : "Review approve and deposit in wallet"}<ExternalLink />
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
