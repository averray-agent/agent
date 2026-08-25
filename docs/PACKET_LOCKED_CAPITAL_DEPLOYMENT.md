# PACKET — Deploy locked capital to the venue

Status: READY FOR CODEX · 2026-08-25 · Author: Claude (architect+gate) ·
Repo: **platform (averray-agent/agent), mcp-server** · One PR.
Authority: `docs/MEMO_LOCKED_CAPITAL_DEPLOYMENT.md` (RATIFIED V1–V7,
platform-initiated). Read it first; the memo wins on any disagreement.

**Do not merge before Thursday's recall is reconciled (V7).** Build it,
gate it, hold it. Legacy operator float and consented locked capital must
never share a venue position.

## What exists and what is missing

The activation gate opened on 2026-08-25 and **nothing consumes it** — the
only reference outside the lock service is display telemetry. Meanwhile the
locked cohort sits as `liquid` in each depositor's AgentAccountCore while
the venue position lives in the DepositPool. There is no deployer.

The mechanism, however, already exists:
`AgentAccountCore.requestStrategyDeposit(account, params)` — the **async**
allocation path, `onlyAccountOrStrategySettler`, returning a `requestId`.
The synchronous `allocateIdleFunds` reverts for async adapters and Hydration
is async, so this is the applicable path. **No contract change, no new
role.**

## A — The deployer

A bounded service that, per depositor with an active lock:

1. Re-evaluates the activation gate **at attempt time** (V2). Never a cached
   verdict. Closed ⇒ no new deployment, and never a forced unwind of an
   existing position.
2. Deploys **only locked amounts** (V3). Compute the deployable figure from
   the lock ledger, never from the wallet's free balance. This is the single
   most important line in the packet: a bug here spends money the depositor
   did not commit.
3. Calls `requestStrategyDeposit` against the registered Hydration
   deposit-pool adapter, records the `requestId`, and reconciles the async
   completion the same way the bank lane already does.
4. Is idempotent per lock: a second run while a request is in flight does
   nothing. Deploying the same principal twice must be impossible.

Fail closed everywhere: unreadable gate, unreadable position, unreadable
cohort, or an in-flight request of unknown state ⇒ do not deploy.

## B — Visibility is not optional (V4)

Automatic movement without disclosure is a truth-boundary failure. Once
deployed, `/me` and the account position must report **deployed versus idle
within the lock**, sourced from the on-chain `strategyAllocated` plus the
ledger — not from an assumption that the request succeeded.

A depositor must always be able to answer "where is my money" without asking
us.

## C — Exit ordering (V5)

Early exit and lock expiry recall from the venue **before** releasing
principal. Recall is async and fee-gated, so an exit enters a pending state
carrying an honest ETA rather than implying instant availability. L4 stands
unchanged: no haircut, no penalty — only a disclosed delay.

## D — Reconciliation (V6)

On every lock read, compare the ledger against chain:
`liquid + strategyAllocated < lockedAmount` ⇒ the depositor exited on chain
around our API. Treat it as an automatic forfeiting exit and raise an
operator alarm. This is detection, not prevention; contract-side locks stay
deferred until demand is proven.

## Non-negotiables (each pinned by a test)

1. **Only locked amounts deploy.** A wallet with 25 locked and 50 liquid
   deploys 25. Assert the exact figure, not just "some".
2. **A closed gate blocks new deployment and never unwinds** an existing
   position.
3. **Idempotent per lock** — a concurrent second attempt deploys nothing.
4. **Every unreadable input fails closed**, each with a named reason.
5. **Exit recalls before release**, and the pending state carries an ETA.
6. **The V6 shortfall case** produces a forfeiting exit plus the alarm.
7. **Visibility**: a deployed lock reports deployed-vs-idle from chain plus
   ledger, never from an assumed-successful request.

## Out of scope

Contract changes of any kind, new roles, changing the activation gate's
economics, the Aug 28 recall itself (its own runsheet), yield distribution
and NAV accounting beyond what poolV2 already does, and any change to
consent text — the venue-exposure sentence is load-bearing and must not be
touched.

## Handback requirements

PR number; green CI; the seven test names; the exact deployable-amount
computation with the 25-locked/50-liquid figure asserted; the named
fail-closed reasons; the `/me` shape for a deployed lock; and confirmation
that no contract, role, consent text, or gate economics changed.
