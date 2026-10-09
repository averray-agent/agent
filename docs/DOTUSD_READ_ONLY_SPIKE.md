# D1 — dotUSD read-only spike and integration change list

Observed 2026-10-09 at 21:30:35Z; repository base `1a925e41`.
Memo only: no asset enabled, allowance written, transaction signed/broadcast,
contract/config changed, or production action performed. D2/D3 still require a
poster asking for dotUSD; this is not a default-asset or payment-rail decision.

## Result

dotUSD is a live six-decimal Hub asset with ERC-20 and EIP-2612 surfaces. It is
**not approved in Averray's TreasuryPolicy** at the observed block. Even after
an operator-approved multisig ceremony, the current external-posting path would
refuse it: that path explicitly requires Hub USDC asset 1337. Sharing USDC's
decimal count does not make the assets interchangeable.

Do not change Base USDC Verify or its EIP-3009 payment gate. EIP-2612 is an
allowance authorization, not EIP-3009 transfer authorization; no x402-over-Hub
claim follows from these reads.

## Identity and pinned observations

Substrate RPC: `wss://polkadot-asset-hub-rpc.polkadot.io`.
Finalized block **21634457**, native block hash
`0x785a15c57a2c647298e25dfe4b239f1c8c89c79c764418ae3b39e368beb3d3cb`;
runtime `statemint`, specVersion **2005000**.
EVM RPC: `https://eth-rpc.polkadot.io/`, chain **420420419**.
Same-height EVM block hash:
`0xc5a7ae1f97d00b7f1c09dde876fed2389f4e24ae0126753b8733fb0ab058f588`.
The native and Ethereum block-hash representations are distinct; use each with
its own API, not interchangeably.

| Read | Result |
|---|---|
| assets.metadata ID | **7873** (`0x1ec1`) |
| metadata name / symbol | `dotUSD` / `dotUSD` |
| decimals | **6** (native metadata and EVM decimals() agree) |
| trust-backed precompile | `0x00001ec100000000000000000000000001200000` |
| EVM name() / symbol() | `dotUSD` / `dotUSD` |
| assets.asset status | Live; isSufficient true; metadata isFrozen false |
| minimum balance | **10000 raw** (0.01 dotUSD), not USDC's configured 70000 |
| observed supply | 2954623108187 raw (a snapshot, not a supply guarantee) |
| owner / issuer / admin / freezer | `12Sg2E9vYxvGsknGKRSXserzHWTXfNej8jqAXjp499RT6Sit` |

Address derivation is `0x` + eight-hex-digit asset ID + 24 zero digits +
`01200000`, per the [Polkadot ERC-20 precompile documentation](https://docs.polkadot.com/smart-contracts/precompiles/erc20/).
The asset identity above comes from chain metadata, not a ticker search.
[Referendum 1944](https://polkadot.subsquare.io/referenda/1944) describes the
phase-one stable-backed rollout; it is not evidence that a later DOT-vault phase
is operational, nor that Averray supports the asset.

## EIP-2612 support and its boundary

At that block:

- `nonces(0x1111111111111111111111111111111111111111)` → **0**.
- `DOMAIN_SEPARATOR()` →
  `0xb3675fc682a2ed5ada11385df6202ae7eb8dd4356b2240c672cef39ed6eba9f1`.
- That equals `TypedDataEncoder.hashDomain({ name: "dotUSD", version: "1",
  chainId: 420420419, verifyingContract: "0x00001ec100000000000000000000000001200000" })`.
- An `eth_call` to `permit(address,address,uint256,uint256,uint8,bytes32,bytes32)`
  with zero r/s and a future deadline reverted **Invalid signature** (RPC code 3),
  rather than an unknown selector. No valid authorization was signed or submitted.

This establishes the deployed permit ABI/getters and signature-validation path,
consistent with the [SDK precompile implementation](https://paritytech.github.io/polkadot-sdk/master/src/pallet_assets_precompiles/lib.rs.html).
A successful allowance mutation, replay prevention and expiry/nonce failure
matrix still need a local-fork/testnet drill in D2, not a production write in D1.
Do not infer EIP-3009 support or gas sponsorship from permit support.

## TreasuryPolicy ceremony requirements

`TreasuryPolicy` at `0x226F14252A98BD2eA140271647De20132F09AF20`:

- `owner()` → `0x01E6eed856e989201F4FF6346E18EAb7e46C874C`.
- `approvedAssets(dotUSD_precompile)` → **false**.
- [TreasuryPolicy.sol](../contracts/TreasuryPolicy.sol) `setApprovedAsset(address,bool)`
  is `onlyOwner`, not a pauser/service-operator capability; it emits AssetApprovalUpdated.
- [mainnet-multisig-owner.json](../deployments/mainnet-multisig-owner.json) records
  threshold 2 of 3. Re-deriving `createKeyMulti(signatories, 2)` gives native account
  `0x93511e8deef3e7ec69cc1f18a573176da9870a0fb474ab2e0c18d88a5e74fd47`;
  its keccak-derived H160 matches owner(). At the pinned native block,
  `revive.originalAccount(owner)` returns that same account.

Future approval requires the existing [2-of-3 operator ceremony](MULTISIG_SETUP.md)
executing the reviewed `setApprovedAsset` call through the native multisig's
revive call, with post-state verification. This memo supplies no execution payload.
Also decide the asset-specific `setMinClaimFee` and risk policy before admission.
Approval alone does not configure the backend or authorize a pool/credit strategy.

Important contract boundary: `recordOutflow(account, amount)` aggregates raw
amounts per account/day **without an asset key**. Two six-decimal assets are
numerically aligned, but summing them assumes a valuation relationship. A
multi-asset policy must resolve this deliberately; do not silently add a 1:1 rate.

## Backend assumptions and required changes (not implemented)

Paths below are relative to `mcp-server/src/`. The appendix inventories every file
matched by the reproducible audit plus the imported Verify boundary. Historical
fixtures/receipts must not be relabelled; new consumer fixtures belong with D2.

| Area / sources | Present assumption → required D2 work or explicit exclusion |
|---|---|
| `core/assets.js`, `blockchain/config.js`, `services/strategy-asset-config.js` | Default escrow = USDC/1337/6 decimals/70000 min balance. `DOTUSD` is absent from symbol metadata and happens to fall back to 6. Add explicit chain/address/ID/decimals/min-balance metadata only after approval; keep USDC default and reject unknown assets instead of inferring support. |
| `core/job-catalog-service.js`, `core/assets.js` | Unit invariant: only DOT/PAS receive native-gas reward haircuts. dotUSD normalizes to DOTUSD, not DOT, and must remain non-native. Pin mixed-case dotUSD as false and preserve the existing USDC net-reward invariant. |
| `blockchain/gateway.js`, `core/account-mutation-service.js`, `core/platform-service.js` | Configured assets use decimals for parseUnits/formatUnits; unknown chain addresses fall back to 18. Require the actual configured asset through balances, deposit, withdraw, raw/display conversion and snapshots. Keep uint256 strings exact and test unknown addresses/large amounts. |
| `core/external-posting-service.js`, `external-posting-policy.js`, `designated-claimants.js`, `poster-onboarding.js` | Explicit USDC-only reward validation, 1337/6-decimal checks, USDC min/max/designated caps and deposit instructions. A config entry cannot bypass these; introduce a reviewed per-asset posting policy rather than replacing the canonical token pointer. |
| `core/claim-economics.js`, `worker-exposure.js`, `worker-daily-exposure.js` | Subsidy/exposure budgets and conversion rates are USDC-denominated; dotUSD has no explicit conversion rate. Preserve fail-closed behavior. Decide rates/depeg policy and asset-specific minimum fees; never count a dotUSD base unit as USDC merely because decimals match. |
| `core/catalogue-daily-budget.js`, `catalogue-lane-discipline.js`, `verifier-class-rewards.js`; `jobs/ingest-*.js`, `services/bootstrap-jobs.js` | Scheduler rewards/caps are USDC, and lane accounting refuses non-USDC. Keep those lanes USDC unless separately ratified; no automatic rewrite of curated jobs or economics. |
| `core/deposit-claim-priority.js`, `worker-progression.js`, `tier-perks-non-yield.js`, `onboarding-inventory.js` | Deposit-backed thresholds, perks and explanatory strings use USDC principal. A dotUSD job is not evidence of a USDC deposit. Separate qualifying collateral from reward currency. |
| `core/funded-jobs.js`, `badge-metadata.js`, `agent-profile.js`; `services/payout-receipt-backfill.js` | Snapshots, rewards and receipts use explicit symbol/decimals where present, USDC defaults otherwise. Carry chain/address/symbol/decimals end-to-end, including the app/SDK fixtures. Never reinterpret old signed receipts. |
| `services/overnight-ledger.js`, `transparency-service.js`, `github-author-visibility.js`; `core/retained-workers.js` | Six-decimal USDC totals, labels, asset filters and retained-worker cost. Keep separate per-asset totals or an explicit valuation with unavailable evidence; never mix currencies into a USDC field or turn missing evidence into zero. |
| `services/earnings-door.js`, `treasury-summary.js`, `first-withdrawal-gas-grant.js`; `core/earnings-door-copy.js` | Balances, withdrawal eligibility/grants and door copy assume the present USDC lane. Make asset context truthful and update consumers together; do not claim a grant works for dotUSD before testing its exact admission conditions. |
| Pool, credit, idle/locked keeper, venue, bank/XCM and subsidy readers (appendix) | These products bind USDC pool/adapter/token addresses, Hydration assets and six-decimal principal. Leave them USDC-only. dotUSD support is not an alias swap or a new approved strategy; lending/collateral/venue work needs its own design and ceremony. |
| `services/verification-profile-registry.js`, `verify-revenue-metrics.js`, `payments/*`, `core/verify-product-copy.js`, `verdict-presentation.js` | Paid Verify remains Base USDC with EIP-3009. Keep quote/capture/refusal/receipt units and x402 Base-only law unchanged. Poster-ramp bridging is also not a dotUSD route. |
| `services/bootstrap.js`, `protocols/http/*`, `protocols/mcp/tools.js`, `core/discovery-manifest.js`, `agent-surface-parity.js`, `health-capability.js`, `auth/capabilities.js` | Wiring, money contexts, routes and discovery advertise USDC-specific capabilities. Any eventual D2 surface change must list app hooks/pages, SDK, ops scripts, generated discovery and marketing readers with shape-current fixtures. Do not advertise an unsupported asset early. |

## Reproduce the chain reads

From a workspace with dependencies installed, use the native hash above with
`api.at(hash)`, then `at.query.assets.metadata(7873)`, `at.query.assets.asset(7873)`
and `at.query.revive.originalAccount("0x01e6eed856e989201f4ff6346e18eab7e46c874c")`.
The initial identification used bounded `assets.metadata.entriesPaged` reads of
100 entries at that finalized hash (maximum 30 pages), matching the on-chain
symbol/name. Metadata and EVM calls agreed; ticker identity alone was not trusted.

```sh
node --input-type=module <<'NODE'
import { ApiPromise, WsProvider } from '@polkadot/api';
import { createKeyMulti } from '@polkadot/util-crypto';
import { keccak256 } from 'ethers';
import { readFileSync } from 'node:fs';
const record = JSON.parse(readFileSync('deployments/mainnet-multisig-owner.json'));
const key = '0x' + Buffer.from(createKeyMulti(record.signatories.map(s => s.accountId32), record.threshold)).toString('hex');
console.log({threshold: record.threshold, signatories: record.signatories.length, key, owner: '0x' + keccak256(key).slice(-40)});
const timer = setTimeout(() => { console.error('read deadline'); process.exit(1); }, 30000);
const provider = new WsProvider('wss://polkadot-asset-hub-rpc.polkadot.io', false);
await provider.connect();
const api = await ApiPromise.create({provider, noInitWarn: true});
try {
  const at = await api.at('0x785a15c57a2c647298e25dfe4b239f1c8c89c79c764418ae3b39e368beb3d3cb');
  console.log((await at.query.assets.metadata(7873)).toHuman());
  console.log((await at.query.assets.asset(7873)).toHuman());
  console.log((await at.query.revive.originalAccount(record.multisig.ownerEnvValue)).toHex());
} finally { clearTimeout(timer); await api.disconnect(); }
NODE
```

```sh
task_rpc=https://eth-rpc.polkadot.io/
task_block=21634457
task_token=0x00001ec100000000000000000000000001200000
cast block --rpc-url "$task_rpc" "$task_block" --field hash
cast call --rpc-url "$task_rpc" --block "$task_block" "$task_token" 'name()(string)'
cast call --rpc-url "$task_rpc" --block "$task_block" "$task_token" 'symbol()(string)'
cast call --rpc-url "$task_rpc" --block "$task_block" "$task_token" 'decimals()(uint8)'
cast call --rpc-url "$task_rpc" --block "$task_block" "$task_token" 'nonces(address)(uint256)' 0x1111111111111111111111111111111111111111
cast call --rpc-url "$task_rpc" --block "$task_block" "$task_token" 'DOMAIN_SEPARATOR()(bytes32)'
cast call --rpc-url "$task_rpc" --block "$task_block" 0x226F14252A98BD2eA140271647De20132F09AF20 'owner()(address)'
cast call --rpc-url "$task_rpc" --block "$task_block" 0x226F14252A98BD2eA140271647De20132F09AF20 'approvedAssets(address)(bool)' "$task_token"
# Expected revert, NOT a transaction or a real signature:
cast call --rpc-url "$task_rpc" --block "$task_block" "$task_token" 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)' 0x1111111111111111111111111111111111111111 0x2222222222222222222222222222222222222222 0 2000000000 27 0x0000000000000000000000000000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000000000000000000000000000
```

No support claim should be inferred from an RPC failure. Historical state must
still be available to reproduce the pinned reads.

## Checks and audit inventory

Node 22 existing unit checks (no test or production changes):

- `node --test mcp-server/src/core/assets.test.js mcp-server/src/blockchain/config.test.js mcp-server/src/core/claim-economics.test.js mcp-server/src/core/worker-exposure.test.js`: **49 passed, 0 failed**.
- `node --test mcp-server/src/core/job-catalog-net-reward.test.js`: **5 passed, 0 failed** (includes the USDC native-haircut invariant).

The reproducible lexical sweep at `1a925e41` found 643 matching lines in the files
below. Non-test fixtures were excluded; imported dependencies were followed for
the payment gate and receipt paths above. The two KMS timing hits divide
nanoseconds by 1,000,000 and are **not currency assumptions**. Demo files are
examples, not production admission. This is a scoped audit, not a license to
mass-replace every USDC string.

```sh
rg -n 'USDC|usdc|1337|DEFAULT_ESCROW_ASSET|parseUnits|formatUnits|1_000_000|1e6|10 \*\* 6|decimals.*6' mcp-server/src --glob '!*.test.js' --glob '!**/fixtures/**' --glob '!**/__fixtures__/**'
```

<!-- inventory follows; paths are relative to mcp-server/src -->

| Source file (first matching line) | Matching lines |
|---|---:|
| [auth/capabilities.js:185](../mcp-server/src/auth/capabilities.js) | 1 |
| [auth/kms-jwt-signer.js:69](../mcp-server/src/auth/kms-jwt-signer.js) | 1 |
| [blockchain/abis.js:316](../mcp-server/src/blockchain/abis.js) | 1 |
| [blockchain/config.js:327](../mcp-server/src/blockchain/config.js) | 2 |
| [blockchain/gateway.js:7](../mcp-server/src/blockchain/gateway.js) | 10 |
| [blockchain/kms-signer.js:60](../mcp-server/src/blockchain/kms-signer.js) | 1 |
| [blockchain/xcm-message-builder.js:17](../mcp-server/src/blockchain/xcm-message-builder.js) | 1 |
| [core/account-mutation-service.js:7](../mcp-server/src/core/account-mutation-service.js) | 3 |
| [core/agent-profile.js:5](../mcp-server/src/core/agent-profile.js) | 2 |
| [core/agent-surface-parity.js:178](../mcp-server/src/core/agent-surface-parity.js) | 1 |
| [core/assets.js:1](../mcp-server/src/core/assets.js) | 15 |
| [core/badge-metadata.js:6](../mcp-server/src/core/badge-metadata.js) | 2 |
| [core/catalogue-daily-budget.js:9](../mcp-server/src/core/catalogue-daily-budget.js) | 22 |
| [core/catalogue-lane-discipline.js:17](../mcp-server/src/core/catalogue-lane-discipline.js) | 10 |
| [core/claim-economics.js:1](../mcp-server/src/core/claim-economics.js) | 37 |
| [core/deposit-claim-priority.js:12](../mcp-server/src/core/deposit-claim-priority.js) | 12 |
| [core/deposit-pool-venue-mark.js:154](../mcp-server/src/core/deposit-pool-venue-mark.js) | 1 |
| [core/designated-claimants.js:15](../mcp-server/src/core/designated-claimants.js) | 1 |
| [core/discovery-manifest.js:14](../mcp-server/src/core/discovery-manifest.js) | 10 |
| [core/earnings-door-copy.js:8](../mcp-server/src/core/earnings-door-copy.js) | 1 |
| [core/external-posting-policy.js:1](../mcp-server/src/core/external-posting-policy.js) | 1 |
| [core/external-posting-service.js:5](../mcp-server/src/core/external-posting-service.js) | 71 |
| [core/funded-jobs.js:1](../mcp-server/src/core/funded-jobs.js) | 3 |
| [core/health-capability.js:793](../mcp-server/src/core/health-capability.js) | 5 |
| [core/job-catalog-service.js:536](../mcp-server/src/core/job-catalog-service.js) | 3 |
| [core/onboarding-inventory.js:123](../mcp-server/src/core/onboarding-inventory.js) | 1 |
| [core/platform-service.js:367](../mcp-server/src/core/platform-service.js) | 1 |
| [core/poster-onboarding.js:101](../mcp-server/src/core/poster-onboarding.js) | 6 |
| [core/retained-workers.js:55](../mcp-server/src/core/retained-workers.js) | 4 |
| [core/tier-perks-non-yield.js:163](../mcp-server/src/core/tier-perks-non-yield.js) | 1 |
| [core/verdict-presentation.js:1](../mcp-server/src/core/verdict-presentation.js) | 10 |
| [core/verifier-class-rewards.js:15](../mcp-server/src/core/verifier-class-rewards.js) | 6 |
| [core/verify-product-copy.js:5](../mcp-server/src/core/verify-product-copy.js) | 4 |
| [core/worker-daily-exposure.js:18](../mcp-server/src/core/worker-daily-exposure.js) | 29 |
| [core/worker-exposure.js:6](../mcp-server/src/core/worker-exposure.js) | 49 |
| [core/worker-progression.js:15](../mcp-server/src/core/worker-progression.js) | 6 |
| [demo/backfill-bank-v22-deposit-evidence.js:9](../mcp-server/src/demo/backfill-bank-v22-deposit-evidence.js) | 1 |
| [demo/e2e-local.js:1](../mcp-server/src/demo/e2e-local.js) | 10 |
| [demo/redis-persistence-check.js:25](../mcp-server/src/demo/redis-persistence-check.js) | 1 |
| [demo/verify-witness-compose-smoke.js:46](../mcp-server/src/demo/verify-witness-compose-smoke.js) | 1 |
| [jobs/ingest-github-issues.js:10](../mcp-server/src/jobs/ingest-github-issues.js) | 2 |
| [jobs/ingest-open-data-datasets.js:5](../mcp-server/src/jobs/ingest-open-data-datasets.js) | 2 |
| [jobs/ingest-openapi-specs.js:5](../mcp-server/src/jobs/ingest-openapi-specs.js) | 2 |
| [jobs/ingest-osv-advisories.js:5](../mcp-server/src/jobs/ingest-osv-advisories.js) | 2 |
| [jobs/ingest-standards-specs.js:5](../mcp-server/src/jobs/ingest-standards-specs.js) | 2 |
| [jobs/ingest-wikipedia-maintenance.js:6](../mcp-server/src/jobs/ingest-wikipedia-maintenance.js) | 2 |
| [payments/adapters/cdp/settlement-adapter.js:257](../mcp-server/src/payments/adapters/cdp/settlement-adapter.js) | 1 |
| [payments/x402-poster-ramp.js:46](../mcp-server/src/payments/x402-poster-ramp.js) | 12 |
| [protocols/http/earnings-door-routes.js:11](../mcp-server/src/protocols/http/earnings-door-routes.js) | 1 |
| [protocols/http/idle-balance-consent-routes.js:42](../mcp-server/src/protocols/http/idle-balance-consent-routes.js) | 1 |
| [protocols/http/public-metadata-routes.js:117](../mcp-server/src/protocols/http/public-metadata-routes.js) | 2 |
| [protocols/http/server.js:78](../mcp-server/src/protocols/http/server.js) | 5 |
| [protocols/http/usdc-liquidity-routes.js:4](../mcp-server/src/protocols/http/usdc-liquidity-routes.js) | 3 |
| [protocols/mcp/tools.js:207](../mcp-server/src/protocols/mcp/tools.js) | 10 |
| [services/bank-deposit-evidence.js:51](../mcp-server/src/services/bank-deposit-evidence.js) | 2 |
| [services/bank-lane-feed.js:296](../mcp-server/src/services/bank-lane-feed.js) | 2 |
| [services/bank-xcm-v22-runtime.js:13](../mcp-server/src/services/bank-xcm-v22-runtime.js) | 12 |
| [services/bootstrap-jobs.js:1](../mcp-server/src/services/bootstrap-jobs.js) | 4 |
| [services/bootstrap.js:205](../mcp-server/src/services/bootstrap.js) | 11 |
| [services/credit-book-door.js:35](../mcp-server/src/services/credit-book-door.js) | 1 |
| [services/credit-pool-door.js:503](../mcp-server/src/services/credit-pool-door.js) | 1 |
| [services/deposit-pool-door.js:27](../mcp-server/src/services/deposit-pool-door.js) | 6 |
| [services/deposit-pool-observability.js:14](../mcp-server/src/services/deposit-pool-observability.js) | 1 |
| [services/deposit-pool-venue-history.js:6](../mcp-server/src/services/deposit-pool-venue-history.js) | 1 |
| [services/deposit-pool-yield-status.js:1](../mcp-server/src/services/deposit-pool-yield-status.js) | 11 |
| [services/earnings-door.js:1](../mcp-server/src/services/earnings-door.js) | 4 |
| [services/first-withdrawal-gas-grant.js:1](../mcp-server/src/services/first-withdrawal-gas-grant.js) | 11 |
| [services/github-author-visibility.js:72](../mcp-server/src/services/github-author-visibility.js) | 3 |
| [services/idle-balance-allocation-chain.js:75](../mcp-server/src/services/idle-balance-allocation-chain.js) | 2 |
| [services/idle-balance-allocation-keeper.js:110](../mcp-server/src/services/idle-balance-allocation-keeper.js) | 5 |
| [services/idle-balance-consent-service.js:17](../mcp-server/src/services/idle-balance-consent-service.js) | 8 |
| [services/locked-tier-service.js:16](../mcp-server/src/services/locked-tier-service.js) | 16 |
| [services/overnight-ledger.js:1](../mcp-server/src/services/overnight-ledger.js) | 44 |
| [services/payout-receipt-backfill.js:1](../mcp-server/src/services/payout-receipt-backfill.js) | 6 |
| [services/pool-v22-commitments.js:59](../mcp-server/src/services/pool-v22-commitments.js) | 1 |
| [services/strategy-asset-config.js:25](../mcp-server/src/services/strategy-asset-config.js) | 1 |
| [services/substrate-subsidy-reader.js:6](../mcp-server/src/services/substrate-subsidy-reader.js) | 7 |
| [services/transparency-service.js:26](../mcp-server/src/services/transparency-service.js) | 45 |
| [services/treasury-summary.js:1](../mcp-server/src/services/treasury-summary.js) | 2 |
| [services/usdc-liquidity-status.js:5](../mcp-server/src/services/usdc-liquidity-status.js) | 25 |
| [services/venue-balance-reader.js:19](../mcp-server/src/services/venue-balance-reader.js) | 1 |
| [services/verification-profile-registry.js:7](../mcp-server/src/services/verification-profile-registry.js) | 2 |
| [services/verify-revenue-metrics.js:1](../mcp-server/src/services/verify-revenue-metrics.js) | 6 |
| [services/xcm-balance-observer.js:187](../mcp-server/src/services/xcm-balance-observer.js) | 1 |
| [services/yield-attribution-service.js:6](../mcp-server/src/services/yield-attribution-service.js) | 7 |
