# Operator rescue tombstone

`OPERATOR_RESCUE_TOMBSTONE_V1`

This document is the canonical evidence payload for Averray's operator-mediated
rescue of an unclaimed Open escrow job. Its UTF-8 file bytes are hashed with
Keccak-256 and submitted as the job's `evidenceHash`.

The tombstone means only this:

- the job had remained Open beyond the documented safety floor;
- the operator deliberately moved it through the existing claim, submission,
  rejection, and permissionless-finalization lifecycle;
- the designated janitor supplied no work and claims no reward; and
- finalization may refund assets only to the poster already recorded in
  `EscrowCore.jobs(jobId).poster`.

It is not a delivery, failed worker submission, verifier quality judgment, or
transfer instruction. The matching rejection reason is the Solidity `bytes32`
string `OPERATOR_RESCUE`.

This file is an immutable protocol-label artifact. Do not edit it in place;
publish a versioned successor and update the rescue tooling if its meaning ever
changes.
