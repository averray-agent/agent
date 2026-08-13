# Packet — the earnings door (exit legibility for worker balances)

**Date:** 2026-08-13 · **Author:** Claude (architect) · **Implementer:** Codex · **Priority:** next
platform packet after the v3 handback — a live external user is affected today.
**Trigger:** the first organic external-agent transcript (Andreas's agent "Ash", wallet
`0x3742de88f246af444aafd5810da2d722bc89620d`, 58 settlements). Ash spent a full session trying to
answer "what can I do with my earnings," probed every plausible endpoint, and told its human the
coins are **stuck in an off-chain treasury ledger with no withdrawal implemented**. Verified
2026-08-13: Ash's numbers were exact (AAC `positions()` reads liquid 13.29 / jobStakeLocked 0.89 —
to the cent), its conclusion wrong at the contract layer and **right at every layer an agent can
reach**.

## 1. Verified facts (all read live, 2026-08-13)

1. Worker earnings settle into **`AgentAccountCore` positions** (`0xB1350932…9E57`), not free EOA
   USDC. The friend's EOA: 0 USDC, nonce 0; his AAC position: 13.29 liquid + 0.89 staked = 14.18,
   matching 14.4 settled minus stake variance. On-chain, self-custodial in the meaningful sense —
   **only his key can move it** — but invisible to an agent checking its "wallet balance."
2. **The exit exists**: `AgentAccountCore.withdraw(asset, amount)` (contracts line ~259,
   worker-signed, nonReentrant, whenNotPaused). It appears in **no** curated ABI (`abis.js` omits
   it — the backend never calls it), no REST/MCP surface, no doc, no template builder.
3. Our own public copy **promises the exit**: "earnings can be withdrawn to any address you
   control" (`managedWalletInterop` — manifest, public metadata route, site mirrors, llms.txt).
   Today that promise has no path behind it.
4. The withdrawal needs **self-paid DOT gas** the target users structurally lack — earn-from-zero
   workers (nonce 0) hold no DOT by design. The D4-R1 insight ("a worker never needs DOT") missed
   the exit leg.
5. `/payments/send` exists and 503s `payments_send_disabled`; the **retired strategy surface**
   (`/account/allocate`, `strategies: []`, vDOT-era XCM machinery) is still exposed and **shadowed
   the live `/pool`** in Ash's exploration — it went looking for yield, found the dead surface,
   and concluded the live one "isn't live yet."

## 2. Workstreams (platform-side only; no contract change)

**W1 — Custody truth on the account view.** Wherever the authed account/position renders (REST +
MCP), add a `custody` block: held by on-chain `AgentAccountCore` at the named address, moved only
by the wallet's own signature, exit = `withdraw(asset, amount)`, link to the door (W2). One
canonical string module, mirrored, smoke-asserted — the disclosure-line pattern (#1102) reused.

**W2 — The withdrawal door.** Mirror the deposit door exactly (`deposit-pool-door.js` is the
proven template): `getAccountPosition` + `buildWithdrawTransactions` (HTTP + MCP,
payload-identical). Input: asset + amount (≤ liquid); output: unsigned `AAC.withdraw` template,
plus an **optional second template** for an onward USDC transfer to any address (making the
"any address you control" promise literally true in one flow). Self-signed, self-broadcast,
`broadcastInstructions` with RPC list, the no-relay boundary stated. Walkthrough script in the
`scratch-dogfood-deposit.mjs` style: independent arg verification before any signature.

**W3 — Honest gas note.** The door quotes the measured cost (~0.02–0.03 DOT self-paid) and says
plainly when the wallet cannot pay it, with the acquisition pointer. It also names the roadmap
truthfully: a **gasless brokered withdrawal** (worker-authorized, operator-broadcast, fee
deducted from the amount — the D4 retention shape applied to exits) is a candidate fast-follow
**decision, not scope here** (it needs a relayed/`For`-style authorization design and its own
packet).

**W4 — Retire the retired.** Strategy endpoints (`allocate`/`deallocate`/strategies list) return
an explicit `retired` status pointing to `/pool` and the `buildVestedCapacity` onboarding section
— the dead surface must stop shadowing the live one. `/payments/send` disabled response gains a
`see` pointer to the withdrawal door.

**W5 — Copy closes the loop.** `managedWalletInterop` and the onboarding sections reference the
door steps ("withdraw via buildWithdrawTransactions — your signature, your gas, any
destination"). Mirrors in lockstep; manifest test asserts the door reference exists wherever the
promise appears.

**W6 — Tests + smoke.** Parity (HTTP == MCP), template-args verification cases, amount > liquid
refused with the position echoed, custody block asserted on the account view, smoke: door
`available`, retired-status on strategies, no orphan promise (grep-shaped assertion that the
promise string and the door reference travel together).

## 3. Acceptance

1. A retained test wallet with an AAC balance walks W2 end-to-end on mainnet: build → verify →
   sign → broadcast → AAC liquid decreases, EOA USDC increases by the exact amount; transcript
   attached.
2. The friend's wallet, unchanged, renders the W1 custody block and a correct quote via
   `getAccountPosition` (read-only proof against the affected user).
3. Full parity suite green; mirrors identical; smoke extended and green in the same deploy.

## 4. Out of scope

Gasless brokered withdrawal (own packet after a decision), any AAC contract change, sweeping the
canary dropped-key balances (#41 interacts — those AAC positions are unreachable for the same
reason and stay excluded from any "unclaimed funds" surface), enabling `/payments/send`.
