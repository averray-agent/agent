# Averray Threat Model

This document tracks launch-critical trust assumptions for the Polkadot agent
runtime. It focuses on the v1.0.0-rc1 backbone: verifier authority, discovery
integrity, disclosure logging, and hash-bound receipts.

## Verifier Key Compromise

`VerifierRegistry` limits verifier authority to addresses explicitly authorized
on-chain. A compromised verifier key can still issue verdicts until
`removeVerifier` is called, so operational monitoring remains required.

Planned mitigations:

- rotate verifier keys on a fixed cadence
- alert on verdict-volume anomalies
- require multiple verifiers for high-value jobs in a later release

## Platform Signer Compromise

The deployment owner/publisher controls `VerifierRegistry`, `DiscoveryRegistry`,
and `DisclosureLog` administration. Until those roles move to multisig, platform
signer custody is the trust boundary.

## Disclosure Window Abuse

Failed submission and verifier-reasoning content can remain private before the
future disclosure window elapses. The on-chain verdict and receipt events remain
public from day one, so failure counts stay visible even when content is delayed.

## Maintainer-Side Reputation Poisoning

Hostile or misaligned upstream maintainers can close Averray-funded PRs without
substantive review. The bootstrap metric should be computed by upstream source
and repo, and repos that produce bad signal should be removed from sourcing.
