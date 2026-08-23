# PACKET — WalletConnect mobile signing (ratified 2026-08-23)

**Author:** Claude · **Ratifier:** Pascal ("not mobile-first, but it's mostly
mobile today") · **Implementer:** Codex · **Sequencing:** dispatch AFTER the
mobile design run hands back (its sign-in states are this packet's UI), and
after the design handoff passes the invented-figures gate.

## 1. Why

The app authenticates and signs exclusively through injected browser-extension
wallets. Mobile browsers have no extensions, so today's only mobile path is a
wallet app's built-in dApp browser. WalletConnect pairing makes phone wallets
first-class for BOTH rooms: operator sign-in and — the bigger prize — the
worker flows (SIWE, self-broadcast claim/submit/withdraw from a phone wallet).

## 2. Decisions (W1–W8)

**W1 — One provider abstraction.** `injected | walletconnect` behind a single
interface; every consumer (SIWE sign-in, claim/submit/withdraw broadcast
flows, the readiness classifiers) talks to the abstraction, never to a
specific transport. The fail-closed claim-readiness pattern carries over
unchanged.

**W2 — Bare `@walletconnect/ethereum-provider`, not AppKit.** We own the UI
(the design run draws it); no third-party modal theme, no registry bloat.
Pin the dependency exactly (supply-chain law).

**W3 — Chain declaration.** Namespaces declare eip155:420420419 (Polkadot Hub)
as required; wallets that cannot add the chain get an honest refusal state
naming the chain, never a silent hang. MetaMask mobile is the acceptance bar;
anything else that works is a bonus.

**W4 — SIWE over the session** via `personal_sign` — same message, same
backend verification, zero server-side auth changes. Transactions go over
`eth_sendTransaction` to the paired wallet; the existing unsigned-tx-template
flows (withdraw, self-paid claim/submit, poster funding) work unmodified.

**W5 — Session lifecycle.** Pairing survives page reloads (provider session
persistence); disconnect is explicit in the UI; SIWE session expiry and WC
session expiry are surfaced distinctly (the design run's session-persistence
states). Never auto-resign SIWE without a user gesture.

**W6 — Credential.** `NEXT_PUBLIC_WC_PROJECT_ID` (publishable Reown/
WalletConnect Cloud project id) in both env templates with the structural
lint + template↔code binding test. Operator pre-step: register the project
(cloud.reown.com), vault the dashboard login, paste the project id.

**W7 — Desktop unchanged.** Injected stays the default when present;
WalletConnect is offered as the alternative (QR on desktop, deeplink on
mobile). No regression to the extension flow — the guard tests that pinned
the current sign-in behavior extend, not relax.

**W8 — Truth rules.** The sign-in screen never advertises wallets we have not
acceptance-tested; the refusal states name what failed (no provider, chain
rejected, pairing expired). Vocabulary: "connect your wallet", never
"link your account".

## 3. Tests

Provider-abstraction unit tests with a mock WC transport (pairing, SIWE sign,
tx send, disconnect, session restore); readiness-classifier parity across both
transports; env binding test; an integration drill that walks
pair → SIWE → build-withdraw → sign through the mock transport. Manual
acceptance (operator-run): MetaMask mobile on a real phone against production —
sign-in, one claim preflight, one withdraw build.

## 4. Out of scope

Substrate-native wallets (Nova/SubWallet — different signing world), AppKit,
social login, session-key schemes, any auth-server changes.
