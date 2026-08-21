export const EARNINGS_ACCOUNT_STATEMENT =
  "This is your account. Earnings settle into its available balance; only your key can withdraw them.";

export const EARNINGS_WITHDRAWAL_STATEMENT =
  "Withdraw via buildWithdrawTransactions — your signature and broadcast, any destination. Eligible workers can request Averray's one-time first-withdrawal DOT grant from that same withdrawal intent.";

export const EARNINGS_OWNERSHIP_STATEMENT =
  "Only your key moves this. Verify the balance with AgentAccountCore.positions(you, USDC) at the returned contract address.";

export const EARNINGS_GAS_STATEMENT =
  "Withdrawal uses DOT on Polkadot Hub. A live estimate is returned; eligible workers may request the one-time 0.03 DOT first-withdrawal grant, otherwise the wallet must supply its own DOT.";

export const EARNINGS_GAS_ACQUISITION_STATEMENT =
  "If the one-time first-withdrawal grant is unavailable, acquire DOT on Polkadot Hub through an exchange or bridge, then rebuild for a fresh gas quote.";

export const EARNINGS_GASLESS_STATUS =
  "Withdrawal is not gasless: the worker still signs and broadcasts. The platform can send one eligibility-bound 0.03 DOT grant to the worker EOA, but never signs or relays the withdrawal.";

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
  statement: "Averray returns account information and unsigned withdrawal templates. It may send one eligibility-bound native gas grant from the operator float, but it never moves account earnings, signs the withdrawal, sees keys, or relays the signed transaction."
});
