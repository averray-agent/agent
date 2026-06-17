# Main Audit - 2026-06-17

Status: internal main audit, not external auditor sign-off.

Baseline:

- Branch: `codex/main-audit-2026-06-17`
- Commit: `775f469` (`build(deps): bump the npm_and_yarn group across 1 directory with 7 updates (#660)`)
- Open PRs at audit start:
  - `#662` - `ops: gate mainnet AUTH_CHAIN_ID + SHARE_URL_SECRET in the env-secrets proof`
  - `#663` - `docs: MAINNET_CREDENTIALS_PLAN - credential inventory + provisioning runbook`
- Open issues at audit start: none

Scope reviewed:

- Mainnet roadmap and audit package: `docs/PROJECT_ROADMAP.md`, `docs/AUDIT_PACKAGE.md`, `docs/MAINNET_PARAMETERS.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/THREAT_MODEL.md`
- Contracts: `contracts/EscrowCore.sol`, `contracts/AgentAccountCore.sol`, `contracts/TreasuryPolicy.sol`
- Backend settlement/auth/capability surfaces: job claim/submit, verifier settlement, dispute verdicts, service-token capability grants, share URLs, mainnet env proof scripts
- Polkadot docs MCP cross-checks for Polkadot Hub USDC and account mapping assumptions

Polkadot docs cross-check:

- USDC on Polkadot Hub is Trust-Backed Asset ID `1337`, 6 decimals, ERC20 precompile `0x0000053900000000000000000000000001200000`.
- Native Polkadot accounts must call `pallet_revive.map_account()` before Ethereum-style contract tooling can use the mapped EVM account.
- Polkadot Hub supports Solidity contracts through its EVM-compatible smart-contract environment.

## Executive Summary

The codebase is stronger than the pre-audit baseline: contract pause/role boundaries are present, service-token capabilities fail closed, dispute payout unit conversion is fixed, and verifier settlement already has an on-chain convergence guard.

It is still not mainnet real-funds ready. I found one hard mainnet launch blocker and two chain/local convergence blockers that can strand real jobs or disputes after a successful chain write but before local persistence completes.

## Findings

### MAIN-001 - High - KMS-only mainnet auth posture cannot boot/login without HMAC secrets

Evidence:

- `scripts/ops/check-mainnet-env-secrets-proof.mjs` requires mainnet proof to report `auth.jwtBackend === "kms"`, `auth.jwtPrimaryAlg === "kms"`, `auth.hmacVerifyAccepted === false`, and raw/HMAC JWT secrets not rendered (`rawFallbacks.authJwtSecretsRendered` and `rawFallbacks.rawJwtSigningSecretRendered` must be false).
- `mcp-server/src/auth/config.js:68-78` still requires `AUTH_JWT_SECRETS` or `AUTH_JWT_SECRET` whenever `AUTH_MODE=strict`, before considering `JWT_BACKEND=kms`.
- `mcp-server/src/protocols/http/auth-routes.js:137-142` and `:260-265` still reject SIWE verify / refresh when `authConfig.signingSecret` is absent, even though `signTokenFromConfig` can issue ES256 through KMS.
- Offline reproduction:

```text
ConfigError: AUTH_MODE=strict requires AUTH_JWT_SECRETS (or AUTH_JWT_SECRET). Set at least one secret with >=32 chars.
```

Impact:

- The desired mainnet posture requires KMS-only JWT signing and no rendered HMAC signing secret.
- Current backend config cannot satisfy that posture and still boot/sign users in.
- Keeping an HMAC secret rendered just to appease config contradicts the mainnet proof gate and leaves a symmetric admin-token minting secret in the environment.

Recommended fix:

- Make strict-mode HMAC secret requirements conditional on `JWT_BACKEND` requiring HMAC verification/signing.
- For `JWT_BACKEND=kms`, require only the KMS JWT signer configuration and public-key material.
- Replace the auth route `authConfig.signingSecret` prechecks with a signer-readiness check compatible with ES256-only mode.
- Add tests for strict `JWT_BACKEND=kms` with no `AUTH_JWT_SECRETS` and for `/auth/verify` + `/auth/refresh` issuing ES256 tokens under that config.

### MAIN-002 - High - On-chain claim can be stranded if local session persistence fails

Evidence:

- `mcp-server/src/core/job-execution-service.js:187-202` performs the chain-side claim.
- `mcp-server/src/core/job-execution-service.js:223-229` creates and persists the local session only after the on-chain claim has returned.
- There is submit convergence for the same problem shape: `submitWork` catches a possible mined-but-receipt-lost path, calls `onChainSubmitLanded`, and then converges the local session (`mcp-server/src/core/job-execution-service.js:292-352`).
- The event listener publishes `escrow.job_claimed` with a derived `sessionId` (`mcp-server/src/blockchain/event-listener.js:70-80`), but it does not reconstruct or persist missing claim sessions.

Impact:

- If `claimJob` mines and the subsequent `stateStore.upsertSession` or funded-job write fails, the chain job is `Claimed` but Averray has no durable session/idempotency record for the worker.
- A retry with the same or new idempotency key sees the chain job no longer open and fails `job_not_claimable`.
- The worker cannot submit because the API has no session ID to use.
- The job remains locked until claim timeout or manual recovery.

Recommended fix:

- Add claim-side convergence comparable to `onChainSubmitLanded`.
- Options:
  - Persist a `claim_pending` record before the chain call, then finalize it after the chain receipt.
  - Or, after detecting on-chain state `Claimed` with this worker, synthesize/upsert the expected session on retry.
  - Or, make the chain event consumer reconstruct missing sessions from `JobClaimed` events.
- Add a test where `blockchainGateway.claimJob` succeeds and `stateStore.upsertSession` fails once; retry must return/converge the claimed session without calling `claimJob` again.

### MAIN-003 - High - Dispute verdict resolution is not idempotent across post-chain persistence failure

Evidence:

- The dispute verdict route calls `gateway.resolveDispute` at `mcp-server/src/protocols/http/dispute-routes.js:249-255`.
- The durable mutation receipt is written afterward at `mcp-server/src/protocols/http/dispute-routes.js:286`.
- The local session transition is written after that at `mcp-server/src/protocols/http/dispute-routes.js:287-300`.
- Verifier settlement already has the correct pattern for this class of bug: `mcp-server/src/services/verifier-service.js:43-64` checks whether the chain job is already resolved and then converges local state instead of re-settling.

Impact:

- If `resolveDispute` mines and the mutation receipt write fails, retrying the same verdict has no receipt to replay and will call `resolveDispute` again.
- The contract has already closed the job, so the retry likely reverts `InvalidState`.
- If the receipt write succeeds but the session transition fails, later retries return the receipt early while the local session can remain `disputed`.
- This can wedge an arbitration path even though chain settlement already happened.

Recommended fix:

- Add dispute-side chain convergence before calling `resolveDispute`, similar to verifier's `onChainAlreadySettled`.
- Persist dispute verdict receipt and session state convergently when chain state is already `Closed`.
- Add tests for:
  - Chain resolve succeeds, receipt write fails, retry converges without a second chain resolve.
  - Receipt write succeeds, session write fails, retry completes the session transition.

### MAIN-004 - Medium - Mainnet env proof gaps are in flight, not yet closed on this baseline

Evidence:

- `deployments/mainnet.env.example` has the correct USDC asset address and conservative policy values, but current baseline does not include `AUTH_CHAIN_ID` or `SHARE_URL_SECRET`.
- Open PR `#662` is specifically intended to gate mainnet `AUTH_CHAIN_ID` and `SHARE_URL_SECRET` in the env-secrets proof.
- `mcp-server/src/core/share-links.js` falls back to `authConfig.signingSecret` if `SHARE_URL_SECRET` is absent. Under MAIN-001's correct KMS-only posture, `authConfig.signingSecret` should be absent, so production share URLs need an explicit `SHARE_URL_SECRET`.

Impact:

- Until `#662` lands and proof is rerun, mainnet proof can miss two launch-sensitive configuration requirements:
  - SIWE chain binding for mainnet.
  - Dedicated share URL signing secret distinct from JWT signing.

Recommended fix:

- Merge/review `#662`.
- Rerun mainnet env/secrets proof after merge.
- Do not mark this closed until the proof artifact shows `AUTH_CHAIN_ID` and `SHARE_URL_SECRET` are present without leaking raw secrets.

### MAIN-005 - Low - Money math still uses display-unit Number in one arbitration helper

Evidence:

- `resolveRemainingPayout` in the dispute route computes display-unit remaining payout with JavaScript `Number` values before `gateway.resolveDispute` converts to asset base units.
- The gateway conversion is fixed and tested for USDC (`mcp-server/src/blockchain/gateway.js:1028-1034`, `mcp-server/src/blockchain/gateway.test.js:165-204`).

Impact:

- Current launch caps make this unlikely to lose precision in practice.
- Future larger limits or more decimal-heavy assets could reintroduce rounding risk before the base-unit conversion.

Recommended fix:

- Not a launch blocker if mainnet v1 stays within conservative caps.
- Prefer carrying raw base units or decimal strings through dispute resolution before conversion.

## Positive Controls Observed

- Contract tests passed: `forge test` completed 110 tests, 0 failed.
- Contract pause surface is broad:
  - `EscrowCore` mutating entrypoints use `whenNotPaused` and role modifiers.
  - `AgentAccountCore` settlement requires `onlyEscrow`, `whenNotPaused`, and supported assets.
  - `TreasuryPolicy` pauser can only set pause state; owner controls roles/caps/assets.
- Service tokens fail closed:
  - `resolveCapabilities` gives service tokens no base capabilities.
  - Middleware only merges a matching active grant and returns the base set on grant lookup failure.
- Verifier payout settlement is already convergent across post-chain persistence failure.
- Dispute payout decimal conversion is fixed in the gateway and covered by a unit test.

## Verification Run

Commands run:

```text
forge test
```

Result:

```text
Ran 9 test suites: 110 tests passed, 0 failed, 0 skipped.
```

Backend test baseline:

```text
npm --workspace mcp-server test
```

Result: not a valid product signal in this local worktree. The run failed because local dependencies are incomplete for KMS/XCM test imports (`@aws-sdk/client-kms`, `@aws-sdk/credential-provider-ini`, `jose`, `@paraspell/sdk-core`) and the local Node runtime is `v25.5.0`. Treat this as an audit-environment limitation and rerun in CI or after restoring the expected dependency/runtime environment.

## Mainnet Readiness Verdict

Not ready for mainnet real funds.

Required before mainnet launch:

1. Fix MAIN-001 and prove strict KMS-only auth works without HMAC JWT secrets.
2. Fix MAIN-002 so chain-claimed jobs cannot be stranded by local persistence failure.
3. Fix MAIN-003 so dispute verdict settlement is convergent/idempotent after chain success.
4. Merge/prove `#662` and `#663`, then produce fresh mainnet env/secrets evidence.
5. Run a fresh external audit package/freeze after these remediations.

