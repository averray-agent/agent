# Runsheet — CreditBook deploy ceremony (credit L2 live, L3 dormant)

**Status:** EXECUTED 2026-08-20 (see EXECUTED record at top) · **Author/Gate:** Claude · **Operator:** Pascal signs/runs
**Spec:** `PACKET_CREDIT_L2L3_SPEC.md` (CW-1..9 ratified 2026-08-16) · Contract merged on main.
**Law:** dry-run first; Claude gates every output before `--commit`; evidence over exit codes.


## EXECUTED 2026-08-20 — full record

**Book LIVE + SEEDED + L2 PROVEN at `0x70441c9131Bc47c96E8D839C5B30850924838099`.**

First deploy attempt (approve-based seed) failed on USDC-precompile semantics —
approve(0) returns false; contract approvals need DOT (memory: hub-pvm-gotchas).
Fix #1188 (810e93a9): seed/repay became AAC-internal consumption; instance
`0xdB7bF8ca…` abandoned inert (~0.88 DOT written off).

| leg | tx | result |
|---|---|---|
| deploy (nonce 21) | `0xc3f8c733…72c1` blk 19686485 | 12/12 read-backs PASS, 0.854 DOT |
| approve(AAC) | `0x37155a28…f18c` | 1 |
| AAC.deposit 10.0 | `0x379c48f3…ccae` | 1 |
| AAC.sendToAgent(book) 10.0 | `0x36c161dc…b027` | 1 |
| seed(10.0) | `0xb280d173…b1b4` | accounted 0→10.0 exact |
| originate 1.00 CASH | `0xe1e75ee4…9d5d` | loan `0x8abcf75c…ac1b`, borrower AAC +1.0 |
| sweep back 1.00 | `0xe99e232e…89c8` | bookLiquid 9→10 |
| recordSweepRepayment | `0xfa515fbb…bded` | loan CLOSED, book whole: 10.0/10.0/0 |

Terms preimage (hash `0x2aceb987…8dbb`): "Averray CreditBook pilot terms v1 —
zero-interest CASH line, repayable on demand via AAC sweep; spec
docs/PACKET_CREDIT_L2L3_SPEC.md @ 810e93a9".
Seed sizing amended by Pascal: 10.0 now (demand-following), top-ups to the 50 cap
as originations require. Operator EOA residue 0.01 USDC. Deployer left at ~2.58
− second CREATE ≈ 1.73 DOT. Wiring PR #1189. L3 fully dormant (flag, wallet,
allowlist all multisig-gated). Ledger reconciles: every raw unit named.

## 0. Why this ceremony is LIGHT (verified against source 2026-08-20)

- Ratified pilot constants are **constructor defaults**: `cashPerWalletCapRaw 25_000_000`,
  `postingPerWalletCapRaw 25_000_000`, `bookCapRaw 50_000_000`, `interestBps 0`
  (originate reverts if non-zero — zero-interest is chain-enforced), `repayBps 5_000`,
  `l3Enabled false`. Immutable ceilings: per-wallet 100, book 250, interest 2000 bps.
- `originate` pays borrowers via `accounts.sendToAgent(...)`, which debits the **book's own
  AAC balance** (no role gate — CreditBook.sol:203, AgentAccountCore.sol:692-698). The book
  becomes an ordinary AAC account holder at seed time via `accounts.deposit`.
- **Consequently: NO multisig legs, no Nova/Vault round, no weight measurement.** Two
  authorities only: the ceremony deployer EOA (CREATE) and the KMS operator (seed + smoke).

## 1. Fixed subjects

| subject | value |
|---|---|
| deployer (mainnet ceremony EOA) | `0x9Ab8531F…4239` (op://mainnet-critical/admin-eoa-mainnet) |
| constructor `policy_` | `0x226F14252A98BD2eA140271647De20132F09AF20` |
| constructor `accounts_` | `0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57` |
| constructor `asset_` (USDC) | `0x0000053900000000000000000000000001200000` |
| constructor `operator_` | KMS backend signer `0x5a6836c6D4d293F6E5377E6c28054F4171915813` |
| constructor `initialL3PosterWallet_` | **`address(0)`** — L3 dormant; poster wallet set by multisig at flag-on via `setL3PosterWallet` |
| seed size | **50.000000 USDC** (= bookCap; spec table) |
| smoke borrower | acceptance wallet `0x60385dD6…` (the reusable §7 worker) |
| gas budget | single CREATE: ensure deployer holds **≥ 2.5 DOT** (~0.9 CREATE + 1.84 upfront hold law) |

## 2. Preflight (the runsheet-already-ran law — MANDATORY)

1. `origin/main` manifest: `deployments/mainnet.json` has **no** `creditBook` key.
2. `git log -S "creditBook" -- deployments/` shows no prior wiring.
3. Chain: deployer nonce recorded; no candidate CreditBook address in env/templates
   (`grep -ri creditbook scripts/ops/render-mainnet-backend-env.mjs deploy/`).
4. Backend health 200; no deploy in flight.
Abort the ceremony if any check disagrees — a red here may be encoding the truth.

## 3. Deploy (deployer EOA)

1. Build the deploy script (Codex pre-stages; plain solc — REVM, no PVM limits) binding the
   §1 constructor args EXACTLY. **Dry-run** prints: creation bytecode hash, predicted
   address, args decoded back. Claude gates the printout against §1.
2. `--commit`. Record: address, tx hash, block, gas.
3. **Verify bindings on-chain** (read-back, all eight):
   `policy() accounts() asset() operator()` match §1;
   `cashPerWalletCapRaw()==25e6, postingPerWalletCapRaw()==25e6, bookCapRaw()==50e6,
   interestBps()==0, repayBps()==5000, l3Enabled()==false, l3PosterWallet()==0x0`.
   Any mismatch → STOP; the contract is inert (unseeded) and simply gets abandoned+redeployed.

## 4. Fund + seed (KMS operator)

1. Fund the operator EOA `0x5a6836…` with **50 USDC** via the proven Coinbase route
   (network "Polkadot" = Asset Hub, SS58 `133YGX…`; lands in the EOA). Confirm arrival by
   balance read, THEN proceed.
2. Seed script (dry-run → gate → commit): `approve(book, 50e6)` handled inside `seed()`'s
   own safeApprove path — the script only needs `CreditBook.seed(50_000_000)` from the
   operator signer. NOTE the render-snapshot law: one-off containers must use the
   mainnet-backend env, force-recreated.
3. Verify: `accountedLiquidityRaw()==50e6`; AAC balance of the BOOK address == 50.000000;
   operator EOA USDC == pre-fund residue. Reconciliation: every raw unit named.

## 5. Live smoke — make L2 PROVEN, not just live (mirrors the L1 pattern)

1. `originate(acceptanceWallet, 1_000_000, CASH, termsHash)` — termsHash = keccak of the
   pilot terms doc (record the preimage in the closeout). Verify: LoanOriginated event,
   acceptance wallet AAC.liquid +1.000000, `accountedLiquidityRaw` 49.0,
   `activeLoanByMode[wallet][CASH]` set.
2. Repay 1.000000 from the acceptance wallet (`repay(loanId, 1_000_000)`).
   Verify: loan closed, `outstanding==0`, `accountedLiquidityRaw` back to 50.0 EXACTLY,
   book AAC balance 50.000000. The book must be made whole to the raw unit.
3. Record both tx hashes. This is the §5 evidence that the full L2 loop works live.

## 6. Wiring PR (post-ceremony, one narrow PR)

- `deployments/mainnet.json` → `contracts.creditBook` = deployed address.
- `scripts/ops/render-mainnet-backend-env.mjs` override map (NEVER hand-edit the generated
  template — structural lint enforces).
- Contract-surface note: source already shipped at merge; this PR wires the ADDRESS only.
  If the deploy gate still flags, the waiver-landing deploy needs `verify_contract_source=1`.

## 7. Closeout

- Ledger table: every movement (fund 50 in, seed 50, smoke 1 out/1 back) with tx hashes.
- Update `PACKET_CREDIT_L2L3_SPEC.md` status → L2 LIVE+PROVEN, L3 DORMANT (flag+wallet+
  allowlist all multisig-gated for later).
- Memory + capabilities doc updates (Claude).
- Explicitly NOT in this ceremony: `setL3Enabled`, `setL3PosterWallet`, any cap change,
  any interest change — all multisig acts for the L3 flag-on ceremony after the L2 cohort.

## Abort ladder

Deploy revert → nothing at risk, diagnose offline. Seed dry-run mismatch → stop before
commit. Seed committed but smoke fails → funds sit in the book's AAC balance under
operator control; `repayFromRefund`/direct sweep paths exist; no user funds involved at
any point in this ceremony.
