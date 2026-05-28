# Mainnet Audit Package

This is the external-auditor handoff for Averray mainnet readiness. It is a
package map and acceptance checklist, not an audit report and not sign-off.

The goal is simple: an auditor should be able to clone the repo, read this
document, reproduce the critical checks, and know exactly which findings block
mainnet real funds.

## Current Status

- Testnet/RC1 proof gates are complete in the roadmap.
- Mainnet real-funds readiness is not complete.
- External audit is still open.
- Native XCM/vDOT/yield is deferred unless explicitly added to a separate audit
  engagement.

Before engaging an auditor, freeze an audit candidate:

```bash
git fetch origin main
git checkout origin/main
git tag audit/mainnet-YYYY-MM-DD
git rev-parse HEAD
```

Record the freeze commit, tag, and any deployed contract addresses in the audit
issue or engagement brief. Do not ask the auditor to review a moving target.

## Audit Outcomes Required

The external audit is complete only after all of the following are true:

- Auditor reviewed the frozen commit and named scope below.
- Auditor delivered severity-ranked findings: Critical, High, Medium, Low,
  Informational.
- All Critical and High findings are fixed or explicitly rejected with written
  risk acceptance before any real-funds mainnet launch.
- Fixes for Critical and High findings are reviewed by the auditor or by an
  agreed independent reviewer.
- Final report, remediation PRs, and the final reviewed commit are linked from
  `docs/PROJECT_ROADMAP.md`.
- The mainnet deployment uses the same audited artifact set, or every
  post-audit delta is separately reviewed.

## Primary Scope

### Solidity Contracts

Mandatory review:

- [`contracts/TreasuryPolicy.sol`](../contracts/TreasuryPolicy.sol)
- [`contracts/AgentAccountCore.sol`](../contracts/AgentAccountCore.sol)
- [`contracts/EscrowCore.sol`](../contracts/EscrowCore.sol)
- [`contracts/ReputationSBT.sol`](../contracts/ReputationSBT.sol)
- [`contracts/DiscoveryRegistry.sol`](../contracts/DiscoveryRegistry.sol)
- [`contracts/StrategyAdapterRegistry.sol`](../contracts/StrategyAdapterRegistry.sol)
- [`contracts/lib/ReentrancyGuard.sol`](../contracts/lib/ReentrancyGuard.sol)
- [`contracts/lib/SafeTransfer.sol`](../contracts/lib/SafeTransfer.sol)
- [`contracts/interfaces/IStrategyAdapter.sol`](../contracts/interfaces/IStrategyAdapter.sol)

Mainnet launch should not include native XCM/vDOT/yield until the separate
native-XCM evidence gate and strategy-adapter audit are complete. If those
contracts are added to the launch scope, include:

- [`contracts/XcmWrapper.sol`](../contracts/XcmWrapper.sol)
- [`contracts/strategies/XcmVdotAdapter.sol`](../contracts/strategies/XcmVdotAdapter.sol)
- [`contracts/interfaces/IXcmWrapper.sol`](../contracts/interfaces/IXcmWrapper.sol)
- [`contracts/interfaces/IXcmStrategyAdapter.sol`](../contracts/interfaces/IXcmStrategyAdapter.sol)
- [`docs/STRATEGY_ADAPTER_AUDIT_SCOPE.md`](./STRATEGY_ADAPTER_AUDIT_SCOPE.md)

Test-only or deferred:

- [`contracts/mocks/MockERC20.sol`](../contracts/mocks/MockERC20.sol)
- [`contracts/strategies/MockVDotAdapter.sol`](../contracts/strategies/MockVDotAdapter.sol)

### Backend Money And Control Routes

Mandatory review:

- [`mcp-server/src/auth/`](../mcp-server/src/auth)
- [`mcp-server/src/core/state-store.js`](../mcp-server/src/core/state-store.js)
- [`mcp-server/src/core/capability-grants.js`](../mcp-server/src/core/capability-grants.js)
- [`mcp-server/src/core/platform-service.js`](../mcp-server/src/core/platform-service.js)
- [`mcp-server/src/core/job-schema-registry.js`](../mcp-server/src/core/job-schema-registry.js)
- [`mcp-server/src/protocols/http/auth-routes.js`](../mcp-server/src/protocols/http/auth-routes.js)
- [`mcp-server/src/protocols/http/job-routes.js`](../mcp-server/src/protocols/http/job-routes.js)
- [`mcp-server/src/protocols/http/verifier-routes.js`](../mcp-server/src/protocols/http/verifier-routes.js)
- [`mcp-server/src/protocols/http/admin-capability-routes.js`](../mcp-server/src/protocols/http/admin-capability-routes.js)
- [`mcp-server/src/protocols/http/admin-jobs-routes.js`](../mcp-server/src/protocols/http/admin-jobs-routes.js)
- [`mcp-server/src/protocols/http/admin-xcm-routes.js`](../mcp-server/src/protocols/http/admin-xcm-routes.js)
- [`mcp-server/src/protocols/http/dispute-routes.js`](../mcp-server/src/protocols/http/dispute-routes.js)
- [`mcp-server/src/protocols/http/payment-routes.js`](../mcp-server/src/protocols/http/payment-routes.js)
- [`mcp-server/src/protocols/http/gas-routes.js`](../mcp-server/src/protocols/http/gas-routes.js)
- [`mcp-server/src/protocols/http/event-routes.js`](../mcp-server/src/protocols/http/event-routes.js)
- [`mcp-server/src/protocols/http/operational-routes.js`](../mcp-server/src/protocols/http/operational-routes.js)
- [`mcp-server/src/protocols/http/server.js`](../mcp-server/src/protocols/http/server.js)

The HTTP server has been route-split. `server.js` now primarily owns shared
plumbing: CORS preflight, request logging, metric labeling, route ordering,
idempotency helpers, and normalized errors. Review it as shared middleware, not
as the canonical location for every route.

### Deployment, Secrets, And Operations

Mandatory review:

- [`docs/THREAT_MODEL.md`](./THREAT_MODEL.md)
- [`docs/PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md)
- [`docs/MAINNET_PARAMETERS.md`](./MAINNET_PARAMETERS.md)
- [`docs/INCIDENT_RESPONSE.md`](./INCIDENT_RESPONSE.md)
- [`docs/MULTISIG_SETUP.md`](./MULTISIG_SETUP.md)
- [`docs/PHASE_4E_PLAN.md`](./PHASE_4E_PLAN.md)
- [`docs/PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md`](./PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md)
- [`docs/SECRETS.md`](./SECRETS.md)
- [`docs/SECRETS_MIGRATION.md`](./SECRETS_MIGRATION.md)
- [`deployments/mainnet.env.example`](../deployments/mainnet.env.example)
- [`scripts/ops/check-mainnet-usdc-config.mjs`](../scripts/ops/check-mainnet-usdc-config.mjs)
- [`scripts/ops/check-mainnet-env-secrets-proof.mjs`](../scripts/ops/check-mainnet-env-secrets-proof.mjs)
- [`scripts/ops/check-mainnet-smoke-proof.mjs`](../scripts/ops/check-mainnet-smoke-proof.mjs)
- [`scripts/ops/check-incident-response-proof.mjs`](../scripts/ops/check-incident-response-proof.mjs)

## Polkadot Hub Assumptions

These assumptions were checked against the Polkadot docs MCP when this package
was refreshed:

- `reference/polkadot-hub/smart-contracts.md`: Polkadot Hub supports Solidity
  contracts through REVM/EVM-compatible tooling.
- `smart-contracts/precompiles/erc20.md`: Trust-Backed assets have deterministic
  ERC20 precompile addresses. USDC is asset ID `1337`, has 6 decimals, and uses
  precompile `0x0000053900000000000000000000000001200000`.
- `smart-contracts/precompiles/erc20.md`: the ERC20 precompile implements core
  ERC20 calls only; optional metadata functions `name()`, `symbol()`, and
  `decimals()` are not implemented through the precompile.
- `smart-contracts/for-eth-devs/accounts.md`: native Polkadot accounts must use
  `pallet_revive.map_account()` before they can safely interact with the
  Ethereum-compatible smart-contract layer through Ethereum tooling.
- `smart-contracts/explorers.md`: BlockScout, Routescan, and Subscan are valid
  Polkadot Hub evidence surfaces for transaction status, account history, and
  smart-contract interaction history.

Any auditor-facing mainnet asset, account, or explorer claim should cite one of
these docs paths or newer official Polkadot documentation.

## Critical Invariants To Break

Auditors should try to disprove these before reviewing lower-risk style issues.

1. **Funds are never double-spent.** A job, milestone, dispute, or settlement
   path cannot pay the same reserved balance twice.
2. **Job state machines cannot be skipped.** Claim, submit, verify, dispute,
   release, slash, and settle transitions must reject stale or out-of-order
   calls.
3. **Claims are mutation-safe.** A retry, timeout, or network failure cannot
   create an unintended second claim or submit for the same logical run.
4. **Idempotency is bound to actor and payload.** Reusing an idempotency key
   with a different body, wallet, service token, or session cannot replay a
   privileged mutation.
5. **Service tokens cannot escape their grant.** A service token must receive
   only the grant-backed capabilities linked by `capabilityGrantId`, not admin
   defaults or user base capabilities.
6. **Verifier replay is stable.** Replaying a verifier result must detect
   policy/config drift and cannot approve a result under a different rule set
   without an explicit audit trail.
7. **Pause halts value movement.** Paused contracts reject claim, submit,
   settle, dispute, release, and treasury/account value mutations.
8. **The pauser cannot administer funds.** A compromised pauser can only grief
   by pausing/unpausing, not change owner, verifier, arbitrator, asset, or
   service-operator state.
9. **USDC accounting uses raw base units consistently.** Rewards, reserves,
   deposits, claims, fees, min-balance checks, and UI/API projections must not
   mix DOT, PAS, display units, and USDC raw units.
10. **Mainnet env cannot reuse testnet keys.** Mainnet signers, service tokens,
    KMS keys, RPCs, contract addresses, and wallet seeds must be fresh and
    provably not the testnet material.
11. **Native account mapping is explicit.** Any native owner/multisig account
    that interacts with contracts through Ethereum tooling must have documented
    `map_account()` evidence.
12. **Observability does not leak secrets.** `/admin/status`, event streams,
    logs, alert payloads, and artifacts must never reveal private keys, bearer
    tokens, JWTs, webhook URLs, API keys, or seed material.

## Known Launch Choices

- Contracts are not proxy-upgradeable in v1. A serious bug requires redeploy
  and migration, not proxy admin intervention.
- Timelock governance is not in v1. Mainnet owner governance is expected to be a
  hardware-backed multisig with documented role separation.
- Yield/native XCM is not part of first real-funds launch unless separately
  audited.
- Backend KMS signing is required for mainnet. Long-lived raw private keys and
  static AWS access-key fallbacks are not acceptable mainnet launch posture.
- Mainnet JWTs must use KMS-backed ES256. HMAC fallback is a testnet rollback
  legacy and is scheduled for retirement after the soak window.
- Metrics, alerts, backups, restore drill, service-token proof, and worker-loop
  product proof are already proven for testnet/RC1. Mainnet still needs fresh
  mainnet evidence.

## Required Reproduction Commands

Run from a clean clone of the frozen audit commit:

```bash
npm install

# Contracts
forge build
forge test

# Backend and HTTP route modules
npm --workspace mcp-server test

# Root regression suite
npm test

# Operator app
npm run typecheck:app
npm run build:frontend

# Public site
npm run build:site

# Indexer
npm run typecheck:indexer

# SDK generated types
npm run check:sdk-types
```

For hosted or private mainnet configuration evidence, auditors should expect
redacted JSON artifacts validated by these scripts:

```bash
node scripts/ops/check-mainnet-usdc-config.mjs \
  --env /path/to/private-mainnet.env \
  --runtime-evidence docs/evidence/mainnet-usdc-asset-config-YYYY-MM-DD.json \
  --require-runtime \
  --json

node scripts/ops/check-mainnet-env-secrets-proof.mjs \
  --file docs/evidence/mainnet-env-secrets-YYYY-MM-DD.json \
  --max-completed-age-hours 24 \
  --json

node scripts/ops/check-mainnet-smoke-proof.mjs \
  --file docs/evidence/mainnet-smoke-YYYY-MM-DD.json \
  --max-completed-age-hours 24 \
  --json

node scripts/ops/check-incident-response-proof.mjs \
  --file docs/evidence/incident-response-YYYY-MM-DD.json \
  --max-completed-age-hours 24 \
  --require-mainnet \
  --json
```

Do not include secret values in evidence artifacts. Artifacts should prove
configuration shape and freshness without exposing private material.

## Mainnet Pre-Audit Checklist

Use this checklist before sending the package to an auditor:

- [ ] Freeze commit/tag recorded.
- [ ] `docs/PROJECT_ROADMAP.md` has no stale open-PR/open-issue status.
- [ ] `docs/MAINNET_PARAMETERS.md` is the intended launch profile.
- [ ] `deployments/mainnet.env.example` matches the intended launch profile.
- [ ] Mainnet USDC docs assumptions still match official Polkadot docs.
- [ ] Final in-scope contract set is named.
- [ ] Any excluded contracts are explicitly not deployed or not enabled.
- [ ] Expected owner, pauser, verifier, arbitrator, and service-operator roles
      are named by role, not by private key.
- [ ] Mainnet multisig and all native accounts that need EVM interaction have
      account-mapping evidence.
- [ ] Mainnet KMS/JWT/secrets architecture has a redacted evidence plan.
- [ ] Testnet-only rollback fallbacks are listed with retirement dates.
- [ ] Known risks and deferred work are named in the engagement brief.

## Auditor Questions To Answer Explicitly

Ask the auditor for written answers on these topics:

- Can any path drain or double-spend escrowed funds?
- Can any actor settle without a valid claim, submit, and verification path?
- Can stale idempotency, retry, or timeout behavior mutate twice?
- Can a service token, delegated wallet, or query-token SSE path escalate scope?
- Can a verifier replay result approve under a different policy/config version?
- Can a malicious token or precompile behavior break USDC accounting?
- Can a native Polkadot account mapping mistake strand funds?
- Can admin, pauser, arbitrator, verifier, or service-operator roles be
  reassigned without the intended owner authority?
- Can logs, events, artifacts, or status routes leak secrets?
- Are mainnet env/secrets checks strong enough to catch testnet material reuse?

## Deliverables Requested From Auditor

1. Written report with severity-ranked findings.
2. Reproduction steps or tests for Critical and High findings.
3. Explicit "must fix before mainnet" list.
4. Review of remediation commits for Critical and High findings.
5. Final sign-off statement naming the reviewed commit/tag and audited scope.

Preferred proof format for contract bugs: Foundry tests near the existing
contract test suites. Preferred proof format for backend bugs: Node tests near
the affected route or auth module.

## Mainnet Blockers After Audit

Even after a clean audit, mainnet is still blocked until:

- fresh hardware-backed mainnet multisig is created and mapped where needed
- mainnet contracts are deployed from audited artifacts
- deploy key transfers ownership to the multisig
- verifier, arbitrator, pauser, and service operators are assigned and rehearsed
- mainnet USDC config proof validates
- mainnet env/secrets proof validates
- at least three low-value mainnet smoke runs validate
- incident-response proof validates with mainnet mode

## Contact

- Primary: <pkuriger@averray.com>
- Escalation: <ops@averray.com>
- Response SLA during audit: within 2 business days for questions, within
  1 business day for Critical findings.
