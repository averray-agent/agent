# Threat Model

This document records the launch threat model for Averray's v1 control plane.
It is intentionally operational: each entry names the trust boundary, the
current mitigation, and the follow-up that would reduce the risk further.

## Scope

In scope:

- hosted API, operator app, indexer, and discovery manifest
- Hub TestNet contract control plane
- verifier, arbitrator, pauser, and owner roles
- funded-job receipts, disclosure windows, and recovery storage
- bootstrap job sourcing and upstream-status instrumentation

Out of scope:

- mainnet real-funds strategy operations before a separate mainnet launch review
- v2 arbitration quorum mechanics
- future Proof of Personhood integration before primary documentation exists

## Threats

### Verifier Key Compromise

Risk: a compromised verifier can approve or reject submissions dishonestly.

Current mitigation:

- verifier authorization is on-chain
- verifier authorization history includes `wasAuthorizedAt`, so later audits can
  identify which receipts were signed inside a compromised window
- high-value or subjective jobs remain out of v1 launch scope

Follow-up:

- publish a concrete verifier key-rotation cadence
- alert on verdict-volume and verdict-outcome anomalies
- require multiple verifiers for higher-value jobs in a later contract version

### Platform Signer Compromise

Risk: the signer that publishes discovery manifests or mutates platform-owned
configuration could publish stale or hostile metadata.

Current mitigation:

- `DiscoveryRegistry` stores the canonical manifest hash on-chain
- the GitHub workflow only publishes when the served manifest hash differs
- owner authority has moved toward the 2-of-3 multisig flow documented in
  [MULTISIG_SETUP.md](./MULTISIG_SETUP.md)

Follow-up:

- keep signer duties separated from hot operational wallets
- finish the recovery playbook dry run for lost-key scenarios
- require multisig review for any mainnet-adjacent owner mutation

### Pauser Compromise

Risk: a compromised pauser can freeze the system.

Current mitigation:

- the pauser role only freezes or unfreezes; it cannot move funds
- recovery is an owner or multisig rotation of the pauser

Follow-up:

- rehearse pause and unpause from the pauser key
- add alerting around pause-state changes

### Disclosure Window Abuse

Risk: failed attempts remain private during the disclosure window, which could
hide low-quality behavior for too long.

Current mitigation:

- on-chain lifecycle events still count the failure path
- delayed content visibility is resolved at read time, not by mutating records
- recovery storage is append-only and content-addressed

Follow-up:

- expose aggregate delayed-disclosure counts without revealing protected content
- run a periodic disclosure-window audit before launch claims

### Maintainer-Side Reputation Poisoning

Risk: a hostile or overloaded upstream maintainer can mass-close jobs and
damage worker reputation unfairly.

Current mitigation:

- repository caps bound exposure to any single maintainer surface
- denylist policy removes unsuitable repos
- week-12 reporting focuses on upstream merge rate rather than raw claim volume

Follow-up:

- monitor close reasons weekly
- keep security, standards, and hostile-maintainer surfaces denylisted by default

### Native XCM Observer Correlation Gap

Risk: async XCM settlement could be credited to the wrong request if return-leg
correlation is ambiguous.

Current mitigation:

- HTTP allocation routes accept intent, not raw caller-provided XCM bytes
- backend-generated messages append `SetTopic(requestId)`
- `XcmWrapper.queueRequest` validates SetTopic on queued payloads

Follow-up:

- run the Chopsticks/Bifrost preservation experiment
- if SetTopic is not preserved, choose and document the serialized-lane or
  amount-perturbation fallback before production-volume strategies

### Async XCM Input Surface

Risk: if callers could submit arbitrary XCM bytes, the wrapper would queue
messages outside platform policy.

Current mitigation:

- the live HTTP API is intent-based for allocate/deallocate
- backend policy assembles the message
- admin-only observation/finalization routes are idempotency guarded

Follow-up:

- keep raw-byte XCM interfaces out of public routes
- expand canonical request-hash receipts to every future settlement mutation

### USDC Issuer Dependency

Risk: v1 USDC escrow inherits issuer and regulatory risks, including freeze
events, depeg events, and blacklisting.

Current mitigation:

- launch parameters are explicit about USDC asset address and decimals
- supported assets metadata is published through the platform discovery surface
- USDC is treated as a v1 settlement choice, not a platform token

Follow-up:

- review legal and operational exposure before meaningful mainnet volume
- keep multi-asset settlement as a later mitigation

### Authentication Token Exposure

Risk: browser JWTs or API keys copied into chat, logs, or issue comments can be
used until expiry or revocation.

Current mitigation:

- JWTs expire and can be revoked through logout
- production auth is strict SIWE JWT auth
- secrets are stored in GitHub Actions secrets, not committed to the repo

Follow-up:

- rotate any API key or token pasted into shared chat
- add operator docs that distinguish signing secrets from bearer JWTs

## Launch Posture

Averray is production-like on testnet once the hosted smoke checks, discovery
publish flow, and bootstrap instrumentation are green. It is not mainnet-ready
until mainnet parameters, audit sign-off, incident ownership, and async XCM
staging evidence are complete.
