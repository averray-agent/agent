# Mainnet Parameter Package

This document is the operator-facing source of truth for Averray's
**initial mainnet launch profile**. It exists to answer one question
cleanly:

> If we deploy the current contract suite to mainnet today, what exact
> risk parameters are we willing to stand behind?

These values are intentionally conservative. They are meant for the
**first real-funds launch window**, not the eventual steady-state system.
Anything looser should be treated as a deliberate governance change, not
an implicit default.

---

## 1. Launch profile

Recommended starting values:

| Env var | Human value | Raw value | Why this starts conservative |
|---|---:|---:|---|
| `DAILY_OUTFLOW_CAP` | `250 DOT` | `250000000000000000000` | Limits aggregate damage from a bad verifier, bad operator flow, or mistaken config in the first launch phase. |
| `BORROW_CAP` | `25 DOT` per account | `25000000000000000000` | High enough to help a good worker bridge claim stake, low enough that one account cannot lever the system hard. |
| `MIN_COLLATERAL_RATIO_BPS` | `20000` (200%) | `20000` | More conservative than the current 150% testnet setting while liquidation does not yet exist. |
| `DEFAULT_CLAIM_STAKE_BPS` | `1000` (10%) | `1000` | Doubles worker skin-in-the-game versus testnet without making starter jobs unusable. |
| `ONBOARDING_WAIVER_CLAIM_COUNT` | `3 claims` | `3` | Lets a new SIWE wallet earn its first DOT before paying stake or anti-spam fees. |
| `CLAIM_FEE_BPS` | `200` (2%) | `200` | Adds refundable anti-spam friction after onboarding without changing worker net cost on success. |
| `MIN_CLAIM_FEE_DOT` | `0.05 DOT` | `50000000000000000` | Keeps tiny funded jobs from being free to spam once onboarding is used. |
| `CLAIM_FEE_VERIFIER_BPS` | `7000` (70%) | `7000` | Sends most failed-claim fee flow to verifier compensation; remainder supports treasury operations. |
| `REJECTION_SKILL_PENALTY` | `10` | `10` | Keeps ordinary rejection meaningful without making recovery impossible. |
| `REJECTION_RELIABILITY_PENALTY` | `25` | `25` | Makes failed runs hurt reliability more than pure skill, which better reflects operator trust. |
| `DISPUTE_LOSS_SKILL_PENALTY` | `35` | `35` | Escalates the cost when the worker pushes a disputed submission and loses. |
| `DISPUTE_LOSS_RELIABILITY_PENALTY` | `60` | `60` | Reliability should take the biggest hit on proven-bad disputed work. |

These values should be treated as the **baseline launch policy** until:

- the real mainnet strategy path exists
- liquidation mechanics exist
- reputation-weighted borrow limits exist
- the system has enough production traffic to justify raising limits safely

---

## 2. Why these numbers

### Daily outflow cap — `250 DOT`

The cap should be small enough that a policy or verifier mistake is
painful but not existential. At the current product maturity, the right
question is not "what is the most volume we can support?" but "what is
the largest single-day mistake we are willing to absorb?".

`250 DOT` is a launch-phase circuit breaker, not a forever ceiling.
Raise it only after:

- several successful production settlement cycles
- alerting and incident ownership are live
- operator rehearsals have been repeated on the exact deploy profile

### Borrow cap — `25 DOT` per account

The current borrow model is flat, not reputation-weighted. That means the
cap itself is doing most of the risk control.

`25 DOT` is enough for the intended v1 use case:

- bridging claim stake for a higher-tier job

It is not large enough to treat the protocol like open-ended leverage.
That is the right trade-off until liquidations and reputation-weighted
credit policy exist.

### Minimum collateral ratio — `200%`

The contracts currently enforce health checks, but they do **not** yet
provide liquidation. Without liquidation, the right answer is to be
stricter at origination.

Moving from `150%` on testnet to `200%` on mainnet gives more room for
operational mistakes and stale assumptions.

### Claim stake — `10%`

The current `5%` testnet setting is useful for easy demos, but it is soft
for a real-money launch. A `10%` default makes low-effort spam and weak
submissions costlier without making ordinary work inaccessible.

If this proves too heavy for early worker adoption, loosen it only after
real session data justifies the change.

### Onboarding waiver and claim fee

The first three claims waive both stake and fee so a new agent can earn
the DOT needed to become self-funding. From claim four onward, the worker
locks both the substantive claim stake and a refundable anti-spam fee.

The fee is `max(2% of payout, 0.05 DOT)` for DOT-denominated launch jobs.
It is returned on verified success. On no-show or rejected submission, it
is slashed separately from the claim stake: 70% to the verifier path when
there is a verifier recipient, and the remainder to platform treasury. A
no-show has no verifier recipient, so the fee routes fully to treasury.

### Slash penalties

The penalties should distinguish between:

- ordinary rejection
- losing a dispute after escalating

That is why the disputed-loss penalties are materially harsher than the
straight rejection penalties, and why reliability takes the biggest hit.

The intended signal is:

- one bad submission is recoverable
- repeated bad work is costly
- escalating weak work and losing is much worse

---

## 3. Operator rules

Before a mainnet deploy:

- copy [deployments/mainnet.env.example](../deployments/mainnet.env.example)
  into a private env file that is **not** committed
- replace the placeholder role addresses with the final owner, pauser,
  verifier, and arbitrator addresses
- confirm the values still match this document
- run the multisig and pause rehearsals from
  [MULTISIG_SETUP.md](./MULTISIG_SETUP.md)
- run the release gate and deployment verification from
  [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md)

If you change any of the values above, update both:

- this document
- the private env file used for deployment

Do not rely on memory or shell history for mainnet parameters.

---

## 4. Explicit non-goals of this launch profile

This package does **not** solve:

- liquidation policy
- reputation-weighted borrow caps
- dynamic claim stake by job tier
- strategy-specific limits
- governance timelocks

Those remain v2-level controls. This package is only the safest coherent
v1 launch stance.

---

## 5. Sign-off

Before using this profile on mainnet, confirm:

- [ ] owner multisig is final
- [ ] pauser hot key is final
- [ ] verifier and arbitrator addresses are final
- [ ] the chosen values are copied into the private deployment env
- [ ] audit sign-off still applies to the exact contract set being deployed
- [ ] no one is assuming the old testnet defaults still apply
