# H1 — human checkout, Path A partner on-ramps

Research date: **2026-10-10**. Docs only; no integration, account application,
purchase, payment authorization, registration or transaction was performed.
H2 remains deferred pending Pascal's sign-off. X5's price decision is separate.

## Decision proposed, not implemented

Path A means a partner sells crypto to the customer, delivering native Base
USDC to a **customer-controlled EOA**; the customer then separately authorizes
one Averray Verify run. Averray neither receives the on-ramp fiat nor holds the
customer's keys or pooled balances. The on-ramp destination is the customer's
wallet, **not** Verify's `payTo`. This is wallet funding followed by a service
purchase, not one atomic card checkout. A ramp success is not a Verify success.

Start a future pilot with Coinbase's **account-based hosted** flow for eligible
existing customers. Evaluate Stripe-hosted as a second, **US-eligible** flow.
These are candidate providers, not existing Averray partnerships. Eligibility
for Averray's Swiss sole-proprietor entity and each customer's jurisdiction must
be approved independently. Neither recommendation authorizes an integration.

| Candidate flow | Who performs on-ramp KYC? | Main constraint | Estimated engineering after approval |
|---|---|---|---|
| A1: Coinbase account-based hosted Onramp → own EOA → Verify | Coinbase, in its account/verification UI | Existing or newly verified Coinbase account; live country/payment/asset eligibility; **not** the retired hosted guest flow | 2–4 engineer-days for the ramp handoff, plus shared Verify work below |
| A2: Stripe-hosted minted session → own EOA → Verify | Stripe, in its hosted on-ramp | On-ramp application; Base USDC is documented as unavailable in the EU; pilot restricted to eligible US customers | 2–4 engineer-days for the ramp handoff, plus shared Verify work below |

Estimates are engineering judgment, not vendor promises or measured delivery
times. They exclude legal review, partner approval, account provisioning and
customer KYC delays. Add **4–7 shared engineer-days** for the browser wallet,
exact-request signing, resume/polling UI, accessibility and failure tests. Do not
sum the shared work twice. Embedded/headless wallets are not included.

## A1 — Coinbase account-based hosted flow

1. The future Averray screen connects the customer's EOA and retains the draft
   Verify request locally. A backend uses the
   [Session Token API](https://docs.cdp.coinbase.com/api-reference/rest-api/onramp-offramp/create-session-token)
   with `addresses: [{ address: customerWallet, blockchains: ["base"] }]` and
   `assets: ["USDC"]` to restrict the wallet, network and asset, then builds the
   partner URL. URL `defaultNetwork`/`defaultAsset` are defaults, not these
   restrictions. Supply the required `clientIp`: the real end-user IP, not an
   untrusted `X-Forwarded-For` header. Check country/payment options rather than
   assuming support from the ticker.
2. Redirect to Coinbase. The customer signs in or creates/verifies a Coinbase
   account, selects an available funding method, reviews the partner's fees,
   and buys/sends USDC to that EOA on Base.
3. Return to Averray. Check the selected chain, wallet and native USDC balance;
   the redirect alone does not establish funding. Then follow the shared
   Verify sequence below, ending in a polled run and its actual billing result.

Coinbase documents account-balance/linked-payment funding and explicitly dates
hosted **guest checkout deprecation to 2026-06-30**. Do not build against the
older debit-card/Apple Pay guest examples. Headless guest checkout would be a
different implementation decision, not a fallback quietly added to this memo.
[Hosted overview](https://docs.cdp.coinbase.com/onramp/coinbase-hosted-onramp/overview).

Base USDC is listed in the [network table](https://docs.cdp.coinbase.com/onramp-%26-offramp/developer-guidance/layer-2-networks).
Use current [country/options data](https://docs.cdp.coinbase.com/onramp/coinbase-hosted-onramp/countries-%26-currencies)
and [URL/session guidance](https://docs.cdp.coinbase.com/onramp/coinbase-hosted-onramp/generating-onramp-url)
at implementation time. Coinbase owns account identity verification; the user
provides documents directly to Coinbase, not Averray.
[Identity verification](https://help.coinbase.com/en-gb/coinbase/getting-started/getting-started-with-coinbase/id-doc-verification).

Integrator prerequisite: Averray must create a CDP project and a **Secret API
key** (server-side, not a Client API key), under the CDP terms. This is separate
from the buyer's Coinbase account/KYC.
[CDP setup](https://docs.cdp.coinbase.com/onramp/introduction/quickstart);
[CDP terms](https://www.coinbase.com/legal/developer-platform/terms-of-service).
Supplying `clientIp` for this partner flow is not permission to retain, hash or
use IPs in arrival observability; its privacy handling needs review.

## A2 — Stripe-hosted session flow

1. After provider approval, a future backend mints an on-ramp session for the
   connected EOA and redirects to Stripe's hosted `crypto.link.com` flow.
   Use single-value `destination_currencies: ["usdc"]` and
   `destination_networks: ["base"]`, provide the customer's address and lock it.
   Defaults alone are not restrictions.
2. The eligible customer completes Stripe's identity/payment checks and reviews
   the quote. Stripe supplies Base USDC to the selected customer wallet.
3. Return, independently check wallet/chain/balance, then follow the same fresh
   Verify challenge/sign/start/poll sequence. Never let a browser redirect or
   unauthenticated callback mark a run as paid.

[Session API](https://docs.stripe.com/api/crypto/onramp_sessions/create) documents
the network/currency restrictions and `lock_wallet_address`.
As of **2026-10-10**, the Crypto Onramp table lists consumers in the US and EU
only, with **Base USDC for US consumers only**. Swiss consumers are not in
Stripe's documented on-ramp regions. Merchants may apply from all Stripe
merchant-supported countries, including Switzerland: a Swiss merchant is
documented as eligible to apply; Averray's application approval is **not
reported**. [Availability table](https://docs.stripe.com/stablecoins/availability);
[merchant countries](https://stripe.com/global).
Use the minted-session option for wallet binding, not a generic link that
merely suggests the asset. Do not promise EU Base USDC availability or bridge
from another network as an automatic workaround.

Stripe says it is merchant of record for the **on-ramp transaction**, handles
KYC/sanctions screening, and requires an on-ramp application. This does not make
Stripe the merchant of record for Averray's separate Verify service; whether
partner KYC affects Averray's obligations is a question for counsel.
As of **2026-10-10**, the on-ramp is in **Public preview**. Averray must first
create and onboard a Stripe account (business verification and Stripe's terms),
then submit the on-ramp application; approval is not implied by account creation.
[On-ramp overview and application steps](https://docs.stripe.com/crypto/onramp).

## Shared funded-wallet → Verify sequence

This is proposed browser work; today's `/verify` page supplies agent/API
instructions, not an integrated human checkout. **No human x402 client exists
in Averray today.** The proposed page must call `eth_signTypedData_v4` on an
EOA wallet (injected or WalletConnect), assemble the x402 v2
`PAYMENT-SIGNATURE` envelope and base64-encode it itself. How each wallet
displays the typed data and hardware-wallet support are **untested**.
Smart-contract wallets cannot pay through the current gate: it uses
`verifyTypedData` only, with no ERC-1271 support. The code reference is
[`VERIFY_PR_GATE.md`](VERIFY_PR_GATE.md), with
[`VERIFY_CAPTURE_RECOVERY.md`](VERIFY_CAPTURE_RECOVERY.md) for pending capture.

1. **Before funding:** fetch discovery and available profiles to describe the
   product and indicative need, without hardcoding a price. Discovery is
   `{x402Version, resources[]}`; select the `/verify/runs` POST resource and
   validate its `accepts` requirements. The public read on 2026-10-10 returned
   x402 v2, `eip155:8453`, native Base USDC
   `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`. A quote fetch failure is **not
   reported**, never a zero price. Do not pair x402 with Hub USDC.
2. **Confirm funding:** the wallet receiving USDC must be the wallet that can
   sign the EIP-712 authorization. Use an EOA for this pilot: the current gate
   uses `verifyTypedData` recovery and does not implement ERC-1271 smart-wallet
   verification. A custodial exchange deposit address or an incompatible smart
   wallet is not a substitute. Read Base USDC `balanceOf` against the fresh
   amount. The current server independently enforces funded admission with
   bounded reads. On-ramp minimums may exceed the purchase; explain any surplus
   stays in the user's wallet. Fees, limits and delivery time require a live
   partner quote; none are measured by this memo.
3. **Only after funds arrive:** POST the actual profile/version/target/inputs
   without payment proof to get its fresh 402 and `PAYMENT-REQUIRED`. An empty
   discovery POST is not a purchase quote for an edited request. If the profile
   became unavailable, stop; bought USDC remains in the customer's wallet.
   Do not ask for the short-lived authorization before KYC or bank settlement.
4. **Explicit consent:** show the real request and fresh amount, token, Base
   chain, recipient, and expiry. The wallet signs EIP-3009
   `TransferWithAuthorization` locally, with a fresh bytes32 nonce and the
   domain from the challenge. It is not a token approval or an immediate
   transfer. Obey the gate's lower validity margin and upper ceiling
   (`now + maxTimeoutSeconds + 300`); no unlimited/long-lived authorization.
5. **Start once:** send the unchanged request with the x402 v2
   `PAYMENT-SIGNATURE` proof. Never log the signature, partner session secret or
   raw payment body. Persist the returned run ID for resume; identical retries
   reuse its authorization rather than creating another purchase. A new request
   needs a new nonce. For MCP clients, the equivalents are
   `quoteVerificationRun`, `startVerificationRun`, `getVerificationRun`; an
   on-ramp token is not an MCP payment proof.
6. **Poll and report truthfully:** `queued` is not a verdict. `capturing` means
   unresolved payment, not free and not paid. Show `billing.status` and the
   signed receipt only when actually available; verify against live JWKS.
   Approved **or rejected** decisive outcomes may charge. Inconclusive and
   platform-fault runs do not capture. Recovery can establish captured,
   payer-cancelled, used-elsewhere or expired; do not repurchase during pending
   recovery. "No verdict, no charge" concerns the Verify fee, **not** a refund
   of the partner's earlier crypto purchase/fees.

The Verify buyer signs off-chain; Averray's submitter pays capture gas. This is
not a promise of zero gas for unrelated wallet transfers, swaps or cancellations.
No bridging, automatic swaps, pooled credits or fiat refunds are proposed here.

## Legal and operational flags before any H2 proposal

- **Swiss operator review:** the source imprint identifies a Swiss sole
  proprietor. Obtain advice on the specific flow, customer markets and referral
  compensation before launch. FINMA says crypto/payment business models must
  assess authorisation and AML obligations. Whether partner KYC affects
  Averray's obligations is a question for counsel. Keeping funding in the
  user's wallet is a design constraint, not a legal conclusion.
  [FINMA FinTech guidance](https://www.finma.ch/en/authorisation/fintech/).
- **Contract split:** document who sells the crypto and who sells Verify;
  confirm partner terms, permitted use, country restrictions, sanctions,
  complaints, fraud/chargeback allocation and withdrawal/refund disclosures.
  Do not promise the on-ramp can be reversed if Verify is inconclusive.
- **Privacy:** keep identity documents/card data on the partner's hosted UI.
  Review privacy notices, controller/processor roles, cross-border transfers,
  necessary wallet/session metadata and retention. Provider-required fraud
  checks are not permission to add IP hashes, ASN or country to the arrival
  observatory. Do not copy payment/KYC data into O3 trails or O4 alerts.
- **Consumer/tax review:** separately assess service terms, digital-service
  cancellation rights, tax/invoice handling and the meaning of a rejected
  but charged Verify result. These are counsel/accounting questions, not
  conclusions established by this technical memo.
- **Customer-market questions for counsel:** for the US-only Stripe Base USDC
  path, which US money-transmission/state rules, consumer laws and sales taxes
  on a digital service sold to US buyers apply to Averray? If the Coinbase flow
  reaches EU customers, which MiCA/EU rules apply? This memo does not determine
  applicability, licensing, exemptions or tax treatment.
- **Security:** bind partner sessions to the intended wallet; allowlist return
  destinations; authenticate any future webhook; retain authoritative run IDs;
  never mark funding/settlement from URL parameters. Review minimum-purchase
  surplus, quote expiry, account switching and phishing risk explicitly.

## Evidence gaps and acceptance plan (not executed)

Partner approval, Coinbase Swiss eligibility, per-market quotes, conversion rate,
end-to-end latency and refund experience are all **not reported**. There have
been no paid trials in this task. Do not render these as 0 or claim a tested
human checkout.

Before H2 approval, Pascal chooses a provider and initial market, obtains
partner/legal clearance and approves a funded sandbox/live pilot separately.
That pilot must test: KYC decline; unsupported region; wrong wallet/network;
funds delayed or insufficient; profile disappears after funding; expired
authorization; wallet rejects signing; duplicate refresh; disconnect/resume;
approved/rejected paid outcomes; inconclusive unbilled outcome; and prolonged
capture recovery without a second purchase. Measure each stage separately.

Consumer sweep: docs only. No HTTP/MCP response, SDK, app hook, discovery,
marketing reader, workflow, environment or production configuration changes.
No runtime consumer fixture changed because no interface is changed. H1 does
not authorize H2, E3 or any other parked packet row.
