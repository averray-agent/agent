export const EARNINGS_ACCOUNT_STATEMENT =
  "This is your account. Earnings settle into its available balance; only your key can withdraw them.";

export const EARNINGS_WITHDRAWAL_STATEMENT =
  "Withdraw via buildWithdrawTransactions — your signature, your gas, any destination.";

export const EARNINGS_OWNERSHIP_STATEMENT =
  "Only your key moves this. Verify the balance with AgentAccountCore.positions(you, USDC) at the returned contract address.";

export const EARNINGS_GAS_STATEMENT =
  "Withdrawal is self-paid on Polkadot Hub. A live estimate is returned in DOT; the transaction cannot be broadcast until this wallet has enough DOT.";

export const EARNINGS_GAS_ACQUISITION_STATEMENT =
  "Acquire DOT on Polkadot Hub through an exchange or bridge, then rebuild the transaction for a fresh gas quote.";

export const EARNINGS_GASLESS_STATUS =
  "Gasless withdrawal is not available. It would require an AgentAccountCore withdrawFor contract change and a separate D8 custody decision.";

export const EARNINGS_PAYMENT_RELAY_STATUS =
  "The disabled /payments/send relay is a separate product decision; it is not part of withdrawal.";

export const RETIRED_STRATEGIES_RESPONSE = Object.freeze({
  status: "retired",
  retired: true,
  reason: "Direct strategy allocation is retired. Capital signalling now uses the self-custodied DepositPool.",
  strategies: [],
  see: {
    pool: "/pool",
    onboarding: "/onboarding#buildVestedCapacity"
  }
});

export const EARNINGS_BOUNDARY = Object.freeze({
  custody: "account_owner_only",
  platformHoldsFunds: false,
  platformMovesFunds: false,
  platformBrokersFunds: false,
  platformSigns: false,
  platformSeesKeys: false,
  signedTransactionRelay: false,
  statement: "Averray returns account information and unsigned transaction templates only. Your wallet verifies, signs, and broadcasts through your chosen RPC."
});
