# Adversarial test protocol — the open poster door

Rung 4 of the validation ladder: smoke → worker → blind → **adversarial** → strangers.

This runs **before** we advertise. The cost of finding a hole scales with how many
strangers are through the door, and today that number is zero. This is the cheapest
this will ever be.

## What changed, and why the old protocol is not enough

Until `EXTERNAL_POSTING_MODE=open`, Averray was one-sided: we authored every job, so
every adversarial question was about workers attacking a catalogue we controlled.

The door now accepts **money from strangers**. A poster we have never met can generate
a quote, fund escrow, put work in front of workers, and hold review authority over what
they deliver. That is a new class of surface, and the parked protocol predates it.

## Ground rules

This runs against **mainnet with real money**. Constraints, not suggestions:

- **Amounts stay at the floor** — 1 USDC per posted job. Total exposure for the whole
  protocol should stay under 20 USDC.
- **Use a dedicated attacker wallet**, never the admin, verifier, signer, or treasury
  identity. Fund it deliberately and record the address in the run log.
- **Claude never handles keys.** Every signing step is Pascal's, via the normal vaulted
  path. This document describes what to sign, never a key.
- **Out of scope, deliberately:** the 2-of-3 multisig, KMS signers, credential handling,
  and anything that would require detection evasion. We are testing our own product's
  logic, not our operational security.
- **Stop rule.** Abort the run and write it up if any of the money invariants in §7
  breaks, or if a step moves funds we did not intend. A single confirmed money defect
  is worth more than a complete run.

## 1 · Quote and funding boundary

The new seam. Quotes are deterministic by `(poster, contentHash)` and persist nothing
but a demand signal; the watcher materialises the draft and catalogue job only after it
observes finalized escrow funding.

| # | Attack | Expected |
|---|---|---|
| 1.1 | Fund the same quote twice | One job, or a clean refusal. Never two catalogue entries from one definition. |
| 1.2 | Quote definition X, fund it, then check the materialised job | Job matches X exactly. The content hash is the binding — verify it is actually enforced, not merely computed. |
| 1.3 | Fund **less** than quoted | No job materialises. Funds recoverable or explicitly stranded with a stated path — never a job with a silently smaller reward. |
| 1.4 | Fund **more** than quoted | Job materialises at the quoted reward; surplus has a defined destination. Record where it goes. |
| 1.5 | Quote, then mutate the anchor (edit or delete the GitHub issue), then fund | Either refuse, or materialise against the anchor as quoted. Never advertise work whose anchor no longer resolves. |
| 1.6 | Same poster quotes identical content twice | Deterministic id means the same quote. Confirm the second funding does not collide destructively with the first job. |
| 1.7 | Two different posters quote identical content | Distinct ids — poster is in the hash. Both should be able to post the same work. |

**1.3 is the one to watch.** A poster who funds the wrong amount and gets nothing, with
no stated recovery, is our first real support incident.

## 2 · Catalogue pollution

| # | Attack | Expected |
|---|---|---|
| 2.1 | Fund a job whose anchor 404s | Refused at quote, or never reaches the catalogue. A worker must never be able to claim unresolvable work. |
| 2.2 | Anchor a job at something enormous (a huge repo or dataset) | Bounded. A worker should not be able to burn unlimited effort because a poster pointed at 4 GB. |
| 2.3 | Post with an output schema the verifier cannot evaluate | Refused by the schema allowlist. Confirm the allowlist is enforced at funding, not only at quote. |
| 2.4 | Reward just below the floor via rounding or unit confusion | Refused. Test `0.999999`, and the raw-vs-decimal boundary. |
| 2.5 | Post work whose content is abusive or illegal | We have no content gate. **Establish what the takedown path is before a stranger tests it for us.** |

## 3 · Poster attacks a worker

The poster holds C3 review authority — approve or reject the current submission. The
threat model already records that self-dealing is possible and bounded ("at worst a
poster pays their own escrow for bad work"). These test the boundary.

| # | Attack | Expected |
|---|---|---|
| 3.1 | Fund, let a worker deliver, reject everything | Worker has a dispute path that does not depend on the poster's goodwill. |
| 3.2 | Delist or cancel after a worker has claimed | Claim is honoured or the worker is made whole. **Known live gap: claim ignores delisting.** Confirm current behaviour and record it. |
| 3.3 | Claim your own job from a second wallet, self-approve | Permitted but visibly attributed. Confirm it appears as what it is in the public record rather than as external work. |
| 3.4 | Set an impossibly short claim TTL | Either floored, or the worker can see it before committing via `preflightJob`. |
| 3.5 | Poster funds, then disputes after settlement | Arbitration is one human today. Record how long it actually takes. |

**3.2 and 3.5 are the ones that will hurt.** A worker who does real work and cannot get
paid is the failure that ends a marketplace, and arbitration does not currently scale.

## 4 · Worker attacks a poster

| # | Attack | Expected |
|---|---|---|
| 4.1 | Claim and never submit | Claim expires and the job returns. Fixed today (#983): a pure no-show no longer consumes the retry budget. Confirm on a real external job. |
| 4.2 | Submit garbage repeatedly | Bounded by retry limit. Confirm the poster's escrow is not drained by verification attempts. |
| 4.3 | Sybil workers claim everything at once | Catalogue lockout. There is no per-wallet concurrent-claim ceiling — measure how many a single actor can hold. |
| 4.4 | Claim, submit plagiarised or trivially wrong work | Verifier decides. Record the false-accept rate; this is the quality signal that matters most to a poster. |

## 5 · Economic

| # | Attack | Expected |
|---|---|---|
| 5.1 | Any path that avoids the 5% fee | None. The fee is poster-side additive and snapshotted on-chain. |
| 5.2 | Confirm **no operator gas** is spent on external claims | `external_self_paid_claim_required` routes the worker to sign. Watch the signer's DOT balance across the run — it must not move for external jobs. |
| 5.3 | Any path where the platform pays out | None. Rewards come from poster escrow. |
| 5.4 | Flood cheap 1 USDC jobs to saturate verification | Deliberately uncapped — rejecting at watcher time would strand an already-funded poster. Measure settlement latency under load; that is where it surfaces first. |

**5.2 is the one to instrument.** It is the whole economic premise of opening the door.

## 6 · Front door and telemetry

| # | Attack | Expected |
|---|---|---|
| 6.1 | Flood `/mcp` handshakes with distinct client identities | Arrival state is capped at 200 clients with LRU eviction; funnel totals survive eviction. |
| 6.2 | Oversized or hostile `clientInfo` | Truncated to 64/32 chars, never used as a Prometheus label. |
| 6.3 | Break the observatory deliberately | The door stays open. Observability must never be able to refuse a request. |
| 6.4 | Confirm no PII leaks to the public `/monitor/arrivals` | IPs are salted-hashed; no address appears in the snapshot. |

## 7 · Money invariants — check after every section

Any of these breaking is a **stop-the-run** event:

1. Escrow balance equals the sum of unsettled obligations.
2. No job is claimable before its escrow is funded.
3. A worker receives 100% of the advertised reward; the fee is additive on the poster.
4. No operator gas is spent on an externally-posted job.
5. No session is `resolved` without a payout receipt in the same write (#989).
6. The public record's figures still reconcile against chain.

## 8 · Run log

Record for every attempt: what was tried, what happened, the transaction hash if money
moved, and whether behaviour matched expectation. **A refusal is a result.** The blind
agent run was valuable precisely because most of what it found came from things the
platform declined to do.

Write findings up as they land rather than at the end — a confirmed money defect should
interrupt the run, not wait for it.
