# PACKET 4 — The deposit door (bank-lane step 2)

**Author:** Claude (gates handback) · **Implementer:** Codex · **Operator:** Pascal
**Date:** 2026-08-12 · **Sequencing: after packet 3 merges** (the door quotes the allowance
decomposition packet 3 introduces). Independent of the yield ceremony.

Tier 3 is reachable today only by hand-crafting raw EVM transactions. The refusal copy
(packet 3 §3) names a path — this packet makes that path walkable by an autonomous agent.

## 0. The boundary that shapes everything — non-negotiable

**The platform never holds, moves, brokers, or relays depositor funds, and never touches a
depositor key.** The door is *information and unsigned templates only*: the agent reads,
verifies, signs with its own wallet, and sends via its own RPC (public Hub RPC is free and
already in `getPlatformCapabilities`). Deposits are the one flow where the operator being
unable to touch the money is the product's core promise — a brokered deposit would invert
it. No `submitSignedTransaction` relay in this packet either (value-neutral but new attack
surface; named out of scope, revisit only on evidenced agent demand).

## 1. Two MCP tools, mirrored on HTTP — keep the surface legible

### `getDepositPoolInfo` (public; per-wallet fields only when authed)

Returns, all from live reads (single source: the same gateway probes packet 3 ships):

- `pool`, `asset` addresses; `chainId`; caps (`TOTAL_ASSET_CAP`, `PER_AGENT_ASSET_CAP`);
  `totalAssets`, remaining pool headroom.
- Authed: `depositedAssets` (`assetsOf`), `shares` (`balanceOf`), current allowance
  decomposition (`base`, `fromDeposits`, `total`) and headroom to the per-agent cap.
- **Two mandatory honesty fields, verbatim contract:**
  - `yieldStatus: "not_yet_earning"` with text — *"Deposits do not currently earn yield;
    pool capital deployment is a pending operator ceremony. Deposits raise your daily
    allowance 1:1 — that is the live benefit today."* Flips only when the yield ceremony
    executes. Selling a bank account with silent 0% is the exact lie this platform exists
    to not tell.
  - `withdrawal: "open"` with the deposited-not-locked note (packet 3 §6) — the exit is
    stated wherever the entrance is.
- Testnet / any profile without `contracts.depositPool`: `available: false` with a reason —
  never fabricated zeros (absence-not-zero, the arrivals rule).

### `buildDepositPoolTransactions` (authed; `direction: "deposit" | "withdraw"`)

Deposit with `assets`: returns **two unsigned transaction templates** —
1. `approve(pool, assets)` on the USDC precompile `0x0000053900000000000000000000000001200000`
2. `deposit(assets, <agent address>)` on the pool (`DepositPool.sol:257`)

Withdraw with `shares` (or `assets`, converted via live share price): **one template** —
`redeem(shares, <agent>, <agent>)` (`DepositPool.sol:311`).

Each template: `to`, `data`, `value: 0`, `chainId`, gas estimate, and a human/agent-readable
`decoded` block (function, args) so the agent can verify before signing. Plus a `preview`:
allowance before/after, cap headroom consumed, expected shares (from live `convertToShares`
semantics — cost-basis, so state the share price used and its block).

**Preflight the reverts at quote time:** amount over per-agent or total cap, USDC balance
insufficient, allowance already sufficient (then omit the approve template and say why).
The tool must refuse with the on-chain revert's own name (`AgentAssetCapExceeded`,
`TotalAssetCapExceeded`) rather than let the agent burn gas discovering it. Preflight
parity discipline (#834): the quote's refusal set and the chain's revert set must be the
same set.

## 2. HTTP parity

`GET /pool` and `POST /pool/transactions` with identical payloads — both doors, same
truth, same honesty fields (the funnel lesson: never instrument or ship one door only).

## 3. Docs

Onboarding gains a "Raise your allowance" walkthrough: read info → build → verify decoded
block → sign with your own wallet → send → re-read `explainEligibility` to see the raise.
Explicitly states what the platform never does (hold, move, relay, see keys).

## 4. Acceptance (Claude verifies on handback)

- Template `data` decodes to exactly `approve(pool, assets)` / `deposit(assets, agent)` /
  `redeem(shares, agent, agent)` against the compiled ABI — byte-level check, no
  hand-rolled selectors.
- Quote math matches live chain reads (caps, deposited, share conversion) — test with
  mocked gateway values; allowance decomposition identical to packet 3's
  `explainEligibility` for the same state (single-source assertion).
- Over-cap amount → quote-time refusal naming the exact on-chain error; nothing returned
  that would revert.
- Allowance-already-sufficient → approve template omitted with the reason stated.
- Unauthed info call → public fields only; authed adds per-wallet.
- No-pool profile → `available: false` + reason; zero fabricated fields (testnet fixture).
- `yieldStatus` honesty field present and asserts `not_yet_earning` until a config/manifest
  signal the yield ceremony will flip — the flip mechanism exists and is tested OFF.
- Withdrawal symmetric: every deposit-side test has a redeem-side twin.
- HTTP and MCP return payload-identical results for the same inputs.
- **The platform signs nothing and receives nothing**: no code path accepts a key, a signed
  blob, or initiates a transfer of depositor funds — assert by review, state in the PR.
- No changes to `contracts/`, `deployments/`, packet-3 semantics, or S/E/D windows.

## 5. Not in scope (named)

Signed-raw relay tool · yield ceremony (step 5) · lock-up/decay economics · operator-app
UI for deposits · promoting the door (roadmap rule: not before dogfood + observability).

## 6. The dogfood hook (step 3 depends on this shipping)

The acceptance run for bank-lane step 3 is: one of our wallets walks this exact door —
info → build → sign → send → allowance visibly raised → work past 5 jobs/day → redeem.
Codex should shape the tools so that walkthrough needs zero side-channel knowledge; if the
dogfood needs anything not returned by these two tools, the door is incomplete.
