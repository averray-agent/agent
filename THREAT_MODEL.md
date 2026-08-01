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

## External Poster Review Authority

C3 grants one authority: a poster may approve or reject the current submission
on their own external job. The authority is accepted only from a wallet-backed
SIWE session (never a service token), only when the authenticated wallet equals
the job's recorded on-chain poster, the catalog source is `external`, and the
job is still `Submitted`. Admin support paths remain separate and unchanged.

Approval has no caller-controlled money fields. It may settle only the reviewed
job, only to that job's recorded submitter, and only from amounts already
escrowed at creation: the full snapshotted worker reward goes to the worker and
the snapshotted protocol fee goes to the treasury. The poster cannot select a
recipient, increase or redirect an amount, reach another job, or release funds
that were not committed to that job. Approval therefore has no asset-theft
shape: at worst, a poster voluntarily pays their own escrow for bad work.
Rejection does not slash immediately; it records the existing rejection state
and starts the worker's existing dispute window and terminal protections.

The settlement broker now accepts a poster-supplied decision for this narrow
external-job path. Before any broker action, the backend must bind all of the
following to one canonical submission:

- a wallet SIWE subject to the external job's on-chain poster;
- the requested job id to an external catalog record and live escrow job;
- `Submitted` state to the single recorded submitter and submission receipt;
- settlement recipients and amounts to the live escrow record and its
  snapshotted reward and protocol fee, never request-body values; and
- the decision, poster wallet, rationale hash, submission identity, and time to
  one durable, idempotent review receipt.

The contract's state transition and `SettlementSplit` receipt are the final
money boundary. A forged or replayed instruction that fails any binding is
refused before broadcast; replay of a completed review returns the recorded
outcome without another settlement transaction.

Self-dealing is possible: a poster can claim through a second wallet and then
self-approve. Economically this moves the poster's own reward to another wallet
they control while irreversibly paying the protocol fee, and the worker-side
bond still locks liquidity while the job is in flight. This creates no claim on
another user's assets. It can manufacture activity, badges, or reputation, so
those signals must not be treated as independent demand without Sybil analysis;
the asset risk is accepted because the poster funds the full loop and loses the
fee.

Review, expiry, and escalation are competing state transitions, not advisory
timestamps. The backend must serialize decisions per submission and re-check
the live escrow state immediately before action:

- if claim expiry or reopening wins before a valid submission, review is
  refused because the job is no longer `Submitted`;
- if review and poster-silence escalation race, only the first durable decision
  may proceed and the loser returns the recorded result or an honest state
  conflict;
- duplicate review requests share the submission-scoped idempotency key and
  cannot create a second chain write; and
- once escalation has opened a dispute, poster approval or rejection is
  refused because the dispute path exclusively owns resolution.

Poster-silence escalation uses a live-configured review window. When it expires,
one brokered operation records the review-timeout rejection and immediately
opens the dispute for the recorded worker with `openDisputeFor`. Keeping these
actions in one brokered step avoids leaving a silent worker slash-exposed in an
intermediate rejected state.

The arbitration fail-close gate is deliberately split by capability. Recording
a dispute verdict still requires a configured signer that can execute that
verdict on-chain; otherwise the API would claim a decision that cannot settle
and must fail closed. Opening an escalation does not claim to resolve it and is
allowed when arbitration is out-of-band hardware: `openDisputeFor` is already a
bounded service-operator action, and the resulting dispute retains both the
hardware-arbitrator path and permissionless timeout terminals. This split adds
no new resolution authority and prevents poster silence from weakening worker
protections.
