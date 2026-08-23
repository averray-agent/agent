"use client";

import { useState, type ReactNode } from "react";
import { ArrowLeft, ExternalLink, MonitorSmartphone, ShieldCheck, Smartphone, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { WalletInstallGuidance } from "./WalletInstallGuidance";
import { WalletQrCode } from "./WalletQrCode";
import { completeSignIn, prepareSignIn, type PreparedSignIn } from "@/lib/auth/siwe";
import {
  cancelWalletPairing,
  WalletPairingCancelledError,
  type WalletProviderKind,
} from "@/lib/auth/wallet-provider.js";
import { useWalletConnection } from "@/lib/auth/use-wallet-provider";
import type { AuthSession } from "@/lib/auth/token-store";

export function WalletSignInFlow({
  onSignedIn,
  compact = false,
  disabled = false,
}: {
  onSignedIn(session: AuthSession): void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const wallet = useWalletConnection();
  const [prepared, setPrepared] = useState<PreparedSignIn | null>(null);
  const [preparing, setPreparing] = useState<WalletProviderKind | null>(null);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function begin(kind: WalletProviderKind) {
    if (disabled) return;
    setError(null);
    setPrepared(null);
    setPreparing(kind);
    try {
      setPrepared(await prepareSignIn(kind));
    } catch (cause) {
      if (!(cause instanceof WalletPairingCancelledError)) {
        setError(cause instanceof Error ? cause.message : "Wallet connection failed.");
      }
    } finally {
      setPreparing(null);
    }
  }

  async function cancel() {
    setPrepared(null);
    setPreparing(null);
    setError(null);
    if (wallet.status === "pairing" || wallet.status === "connecting") {
      await cancelWalletPairing();
    }
  }

  async function sign() {
    if (!prepared) return;
    setSigning(true);
    setError(null);
    try {
      onSignedIn(await completeSignIn(prepared));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet sign-in failed.");
    } finally {
      setSigning(false);
    }
  }

  if (wallet.status === "pairing" && wallet.pairingUri) {
    return (
      <PairingState
        uri={wallet.pairingUri}
        expiresAt={wallet.pairingExpiresAt}
        onCancel={() => void cancel()}
      />
    );
  }

  if (wallet.status === "chain_refused") {
    return (
      <RefusalState
        label="Network request declined"
        title="Switch your wallet to Polkadot Hub."
        body={wallet.errorMessage ?? "The wallet declined the requested chain."}
        action="Retry with MetaMask mobile"
        disabled={disabled}
        onAction={() => void begin("walletconnect")}
        onBack={() => void cancel()}
      />
    );
  }

  if (wallet.status === "pairing_expired") {
    return (
      <RefusalState
        label="Pairing expired"
        title="The connection window closed."
        body="The wallet pairing expired before approval. No signature was made."
        action="Generate a new pairing"
        disabled={disabled}
        onAction={() => void begin("walletconnect")}
        onBack={() => void cancel()}
      />
    );
  }

  if (prepared) {
    return signing && prepared.kind === "walletconnect" ? (
      <WalletApprovalState prepared={prepared} />
    ) : (
      <SiweReview prepared={prepared} signing={signing} onCancel={() => void cancel()} onSign={() => void sign()} />
    );
  }

  const injectedReady = wallet.injectedAvailable;
  const walletConnectReady = wallet.walletConnectAvailable;
  const injectedPending = preparing === "injected";
  const walletConnectPending = preparing === "walletconnect";

  return (
    <div className="grid gap-4" data-wallet-sign-in-flow>
      {!compact ? (
        <div>
          <Badge tone={wallet.availability === "available" ? "success" : "warn"} className="w-fit">
            {wallet.availability === "available" ? "Wallet connection available" : wallet.availability === "checking" ? "Checking for a wallet" : "Wallet required"}
          </Badge>
          <h2 className="mt-4 text-xl font-semibold tracking-tight">Connect your wallet</h2>
          <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">
            Sign one readable SIWE message. Averray never receives your wallet key.
          </p>
        </div>
      ) : null}

      {walletConnectReady ? (
        <div className="grid gap-2 md:hidden">
          <ConnectionButton
            icon={<Smartphone />}
            title={walletConnectPending ? "Opening MetaMask…" : "MetaMask mobile"}
            detail="Connect with WalletConnect"
            disabled={disabled || Boolean(preparing)}
            onClick={() => void begin("walletconnect")}
          />
          <ConnectionButton
            icon={<Wallet />}
            title={injectedPending ? "Opening wallet…" : "Wallet app browser"}
            detail={injectedReady ? "Continue in this browser" : "Open Averray inside your wallet browser"}
            disabled={disabled || Boolean(preparing) || !injectedReady}
            onClick={() => void begin("injected")}
          />
        </div>
      ) : null}

      <div className={walletConnectReady ? "hidden gap-2 md:grid" : "grid gap-2"}>
        <ConnectionButton
          icon={<Wallet />}
          title={injectedPending ? "Opening wallet…" : "Browser wallet"}
          detail={injectedReady ? "Use your installed extension" : "No injected wallet detected"}
          disabled={disabled || Boolean(preparing) || !injectedReady}
          onClick={() => void begin("injected")}
        />
        {walletConnectReady ? (
          <ConnectionButton
            icon={<MonitorSmartphone />}
            title={walletConnectPending ? "Preparing QR…" : "Connect a mobile wallet"}
            detail="Scan a WalletConnect QR with MetaMask mobile"
            disabled={disabled || Boolean(preparing)}
            onClick={() => void begin("walletconnect")}
          />
        ) : null}
      </div>

      {!injectedReady && !walletConnectReady ? (
        <WalletInstallGuidance provider={wallet.availability} showBrowseLink />
      ) : null}
      {error ? <p className="rounded-[var(--radius)] bg-[var(--warn-soft)] px-4 py-3 text-sm text-[var(--warn)]" role="alert">{error}</p> : null}
    </div>
  );
}

function ConnectionButton({
  icon,
  title,
  detail,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="flex min-h-[60px] items-center gap-3 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper-solid)] px-4 py-3 text-left hover:border-[var(--line-strong)] disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius)] bg-[var(--paper)] text-[var(--accent)] [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      <span className="min-w-0">
        <strong className="block text-sm">{title}</strong>
        <span className="mt-0.5 block text-xs text-[var(--muted)]">{detail}</span>
      </span>
    </button>
  );
}

function PairingState({ uri, expiresAt, onCancel }: { uri: string; expiresAt: number | null; onCancel(): void }) {
  const metamaskUrl = `https://metamask.app.link/wc?uri=${encodeURIComponent(uri)}`;
  return (
    <div className="grid gap-5" data-wallet-state="pairing">
      <div>
        <p className="eyebrow">Waiting for MetaMask</p>
        <h2 className="mt-2 text-2xl font-semibold">Approve the connection on your phone.</h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
          The pairing only connects your wallet. The readable SIWE message comes next and still needs your approval.
        </p>
      </div>
      <div className="hidden justify-center md:flex"><WalletQrCode value={uri} /></div>
      <Button asChild size="lg" className="md:hidden">
        <a href={metamaskUrl}>Open MetaMask mobile <ExternalLink /></a>
      </Button>
      <p className="text-xs text-[var(--muted)]" role="status">
        {expiresAt ? `This pairing code expires at ${new Date(expiresAt).toLocaleTimeString()}.` : "This pairing code is time-limited."} A new code can be generated safely.
      </p>
      <Button variant="ghost" onClick={onCancel}>Cancel pairing</Button>
    </div>
  );
}

function SiweReview({ prepared, signing, onCancel, onSign }: { prepared: PreparedSignIn; signing: boolean; onCancel(): void; onSign(): void }) {
  return (
    <div className="grid gap-4" data-wallet-state="siwe-review">
      <div>
        <Badge tone="success"><ShieldCheck />Wallet connected</Badge>
        <h2 className="mt-4 text-2xl font-semibold">Review the sign-in message.</h2>
        <p className="mt-2 break-all font-mono text-xs text-[var(--muted)]">{prepared.wallet}</p>
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius)] border border-[var(--line)] bg-[var(--avy-paper-alt)] p-4 font-mono text-xs leading-relaxed text-[var(--ink)]">{prepared.message}</pre>
      <p className="text-xs leading-relaxed text-[var(--muted)]">Signing proves this wallet controls the session. It does not send a transaction or grant custody.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="lg" disabled={signing} onClick={onSign}>{signing ? "Waiting for wallet…" : "Sign this message"}</Button>
        <Button size="lg" variant="ghost" disabled={signing} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function WalletApprovalState({ prepared }: { prepared: PreparedSignIn }) {
  return (
    <div className="grid gap-4" data-wallet-state="siwe-wallet-approval">
      <p className="eyebrow">Waiting for MetaMask</p>
      <h2 className="text-2xl font-semibold">Approve the sign-in message on your phone.</h2>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius)] border border-[var(--line)] bg-[var(--avy-paper-alt)] p-4 font-mono text-xs leading-relaxed">{prepared.message}</pre>
      <p className="text-sm text-[var(--muted)]" role="status">The request is waiting in MetaMask. There is no background approval and no automatic re-sign.</p>
      <p className="text-xs text-[var(--muted)]">Reject the request in MetaMask to stop this sign-in.</p>
    </div>
  );
}

function RefusalState({ label, title, body, action, disabled, onAction, onBack }: { label: string; title: string; body: string; action: string; disabled: boolean; onAction(): void; onBack(): void }) {
  return (
    <div className="grid gap-4 rounded-[var(--radius-lg)] border border-[color:rgba(167,97,34,0.46)] bg-[var(--warn-soft)] p-5" data-wallet-state="refused">
      <p className="eyebrow text-[var(--warn)]">{label}</p>
      <h2 className="text-2xl font-semibold">{title}</h2>
      <p className="text-sm leading-relaxed text-[var(--ink)]">{body}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled} onClick={onAction}>{action}</Button>
        <Button variant="ghost" onClick={onBack}><ArrowLeft />Back</Button>
      </div>
    </div>
  );
}
