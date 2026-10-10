# Hub USDC: local floor versus on-chain minimum

Decision, 2026-10-10 (X1 follow-up 5b): deliberately retain
`DEFAULT_ESCROW_ASSET.minBalanceRaw = "70000"` (0.07 USDC) as the local
conservative reward-admission and proof floor. This does **not** describe
Polkadot Hub's asset minimum and is not a Polkadot-docs-backed number.
No value, deployment configuration, contract, or economics changes here.

The [pinned D1 chain read](DOTUSD_READ_ONLY_SPIKE.md#identity-and-pinned-observations)
at finalized block **21634457**, native hash
`0x785a15c57a2c647298e25dfe4b239f1c8c89c79c764418ae3b39e368beb3d3cb`,
records `assets.asset(1337).minBalance = 10000` (USDC) and
`assets.asset(7873).minBalance = 10000` (dotUSD), both six-decimal assets.
That is 0.01 token on chain. The retained policy is seven times the observed
USDC minimum; the extra 60000 raw is a conservative local margin, not a fee,
gas estimate, or runtime requirement. The cost is stricter job admission:
rewards from 10000 through 69999 raw can satisfy the observed chain minimum
but still fail the local reward check.

## Consumer audit before any future value change

Direct non-test consumers of `minBalanceRaw` (repository audit, 2026-10-10):

| File | Use / consequence of changing the floor |
|---|---|
| `mcp-server/src/core/assets.js` | Defines the default; `knownAssetMinBalanceRaw` supplies the USDC fallback. |
| `mcp-server/src/blockchain/config.js` | Normalizes `SUPPORTED_ASSETS_JSON`; explicit configured values take precedence over the default. |
| `mcp-server/src/core/platform-service-helpers.js` | Converts configured/default asset floor to raw BigInt. |
| `mcp-server/src/core/platform-service.js` | `validateJobRewardMinBalance` gates created jobs, ingested candidates, and compatible historical definitions. |
| `mcp-server/src/blockchain/gateway.js` | Includes the configured floor in supported-asset summaries consumed by admin/readiness clients. |
| `scripts/ops/run-hosted-worker-loop.mjs` | Checks reward readiness and records `settlementAsset` / `rewardReadiness` evidence. |
| `scripts/ops/check-product-proof-gate.mjs` | Requires evidence to match the local default and its reward floor. |
| `scripts/ops/check-mainnet-smoke-proof.mjs` | Requires the local floor in smoke evidence and enforces it on rewards. |
| `scripts/ops/check-mainnet-usdc-config.mjs` | Validates the separate runtime-evidence minimum as a positive integer; does not require it to equal 70000. |
| `scripts/ops/derive-settlement-env.mjs` | Emits an explicit 70000 policy in `SUPPORTED_ASSETS_JSON`. |
| `deploy/backend.env.template` | Explicit 70000 policy; changing only the default would not change configured production admission. |
| `deploy/backend.mainnet.env.template` | Generated mirror of that explicit policy; regenerate rather than hand-edit. |

There are no direct `minBalanceRaw` readers in the app, SDK, indexer, or
contracts. The API field is retained for compatibility; consumers must treat
the configured value as policy, not a fresh runtime read. Test/evidence
fixtures keep 70000 for local policy and may use the observed 10000 for runtime
evidence. The roadmap, production checklist, product-proof guide, credentials
plan, and D1 memo distinguish these two meanings. Base USDC Verify admission
uses `balanceOf(payer) >= price`, not this Hub job-reward floor.
