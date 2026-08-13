# CreditPool L1 implementation handoff

Status: build only. Nothing in this change deploys, configures, funds, or arms a contract. The EscrowCore v3 ceremony remains first; DepositPool v2 + CreditPool is the next pool window.

## Implemented shape

- `CreditPool` is a non-transferable, USDC-denominated, cost-basis share pool. Its compile-time launch caps are 250 USDC total and 100 USDC per lender. The launch LTV is 80% (90% ceiling), interest and platform fee are zero (interest ceiling 20%), and collateral seizure is unavailable until live DepositPool value falls below 105% of outstanding principal.
- `DepositPoolV2` retains the v1 pool and venue logic and adds only the pledge registry. Pledged shares cannot use instant or notice redemption. CreditPool releases them at full repayment or seizes their then-current value after impairment.
- Origination is two wallet transactions: `pledge`, then `originate`. The platform signs a five-minute, one-use vesting **attestation**, never a transaction. It is bound to chain id, CreditPool, borrower, deterministic loan id, exact pledge, exact amount, exact D0 vested value, expiry, and nonce. `cancelUnusedPledge` is the escape hatch when the second transaction never succeeds; it cannot touch an active loan.
- D0 reads `LoanOriginated`/`LoanClosed` from chain. A deposit made while debt is open starts its 48-hour clock only at the last applicable close. An unavailable credit history makes vesting unavailable/zero, never early.
- `getCreditInfo` and `buildCreditTransactions` share the SIWE HTTP route with MCP. Every template is unsigned and decoded. The platform has no signed-byte relay.
- `/monitor/credit-pool` provides the internal board contract: buffer, principal outstanding, pledged shares, defaults, caps, schedules, reconciliation, and bounded lifecycle logs. Caddy explicitly keeps it off the public API.

## Vesting-safe migration

`scripts/ops/simulate-creditpool-l1-migration.mjs` reserves the four circular CREATE addresses (lane, venue adapter, DepositPool v2, CreditPool), verifies them on an isolated fork, rewires the paused wrapper strategy, and migrates the one dogfood position. The temporary seed/redeem maneuver preserves both the exact economic assets and the exact share count even when the v1 share price is above par.

The rehearsal emits a `depositPoolVestingMigration` record. Its two transfer mechanics—the v1 withdrawal and v2 deposit—are ignored by D0, while the proven pre-migration tranches remain the initial tranche set with byte-identical principal and timestamps. This avoids silently resetting the dogfood wallet's age during the contract migration.

Polkadot Hub USDC is a runtime precompile, so Anvil cannot replay it from ordinary fork state. `--fork-execute` first pins the single-depositor position and its tranche from the real source RPC, then installs the reviewed six-decimal test shim and recreates only the observed pool buffer. Shim installation is guarded to chain id 31337/1337 and uses a throwaway impersonated account so it cannot shift the predicted deployer nonce. The command refuses every non-local chain id. The actual ceremony must still repeat nonce prediction, live preflights, contract provenance, and multisig byte review.

The build-time rehearsal at source block 19,411,335 passed byte-exact: the only depositor (`0xdc1Ed…EDeC`) moved from 10,000,000 v1 shares / 10,000,000 raw assets to the same v2 shares and assets; the sole tranche retained its 2026-08-12T20:32:00Z timestamp; v1 ended at zero shares/assets; and the wrapper strategy pointed to the predicted new lane after the fork-only pause/rewire/unpause. The full machine-readable transcript is [`evidence/creditpool-l1-fork-sim-2026-08-13.json`](evidence/creditpool-l1-fork-sim-2026-08-13.json). Its CREATE addresses and transaction hashes are rehearsal evidence only, never ceremony material.

## Migration ceremony postconditions (future packet)

1. EscrowCore v3 ceremony is already complete.
2. No pool venue deployment or recall is pending; old pool has enough returned buffer for the one depositor.
3. Four CREATE addresses match the fresh admin-deployer nonce and all immutable bindings read back.
4. Wrapper pauses, points `HYDRATION_USDC_POOL_V1` to the new lane, and only then unpauses.
5. Old shares are zero; new shares, assets, D0 principal, tranche ordering, and timestamps equal the captured before-state.
6. Manifest/provenance and `depositPoolVestingMigration` land with receipts in the same record flow.
