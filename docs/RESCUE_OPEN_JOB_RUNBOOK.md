# Rescue an unclaimed Open job

**Scope:** operator-mediated tombstone rescue for an Open EscrowCore job whose
funds must return to its recorded poster. This is a support procedure, not a
poster self-service cancellation. Expected completion is approximately seven
days because the contract's live `DISPUTE_WINDOW` must lapse.

The procedure uses only existing EscrowCore lifecycle calls:

1. mark the job onboarding-waiver eligible;
2. broker `claimJobFor(jobId, janitor)`;
3. broker `submitWorkFor(jobId, janitor, TOMBSTONE_HASH)`;
4. reject with `resolveSinglePayout(..., false, OPERATOR_RESCUE, ...)`;
5. after the live dispute window, call permissionless
   `finalizeRejectedJob(jobId)`.

Finalization invokes EscrowCore's normal refund logic. Unreleased reward,
unreleased protocol fee, operations reserve, and contingency reserve move from
reserved back to liquid **only for the poster already stored on-chain**. The
script never accepts a refund recipient.

## Preconditions and approval record

Before starting, record the support request and obtain operator approval for the
specific job ID. Delist the external job first. The API claim path serializes
delist and claim, but a direct on-chain claim can still win; if the job is no
longer Open, the rescue must stop and the ordinary lifecycle takes precedence.

The script enforces these chain facts before the first write:

- job state is `Open`, payout mode is `Single`, and no worker is recorded;
- the job's `claimTtls(jobId)` is greater than zero (the external-draft
  validator makes this a standing invariant for newly posted jobs);
- the `JobCreated` block is at least one hour old; the safety floor may be
  raised with `--min-open-age-seconds` but never lowered;
- TreasuryPolicy is unpaused;
- the proposed signer holds both `settlementBroker` and `verifier` roles;
- the janitor has onboarding-waiver headroom under the live policy value; and
- the canonical tombstone document and fixed `OPERATOR_RESCUE` reason are the
  exact values encoded in the calls.

Pascal approved waiver-flag use for labeled rescues in
`POSTER_CANCEL_RECLAIM_DESIGN.md` decision ③. Do not run a non-waived rescue:
that creates fake slash economics and misleading telemetry.

### Create the janitor at first need

Decision ② designates a fresh EOA, vaulted as `averray-janitor`, used for
nothing except these rescues. Create it only when the first rescue is approved.
The existing generator keeps the private key out of stdout and shell history:

```bash
node scripts/ops/rotate-admin-generate-key.mjs \
  --out .keys/averray-janitor.txt \
  --write-to-op \
  --vault prod-critical \
  --title averray-janitor \
  --note 'Dedicated Polkadot Hub mainnet operator-rescue janitor; no other use.'

op item edit averray-janitor --vault prod-critical \
  'chain[text]=Polkadot Asset Hub mainnet (chainId 420420419)'
op read 'op://prod-critical/averray-janitor/address'
rm .keys/averray-janitor.txt
```

Confirm the item contains the expected public address and a concealed private
key before deleting the mode-0600 temporary file. Do not fund the janitor and
do not use its key for this procedure: `claimJobFor` and `submitWorkFor` are
brokered by the operator signer. Record the public address in the incident.

The waiver is bounded by the live `onboardingWaiverClaimCount`. When its
headroom is exhausted, stop. Do not silently use a paid claim; designate a new
fresh janitor through the same approval process.

## Phase 1 — inspect the exact rescue

Use `current` for `contracts.escrowCore` or `legacy` for
`contracts.legacyEscrowCore`. Dry-run is the default and does not read a secret,
sign, or send a transaction.

```bash
node scripts/ops/rescue-open-job.mjs \
  --profile mainnet \
  --escrow current \
  --phase prepare \
  --job-id 0x<32-byte-job-id> \
  --janitor 0x<averray-janitor-address> \
  --expected-signer 0x<operator-and-verifier-address>
```

Archive the output with the support record. Review all five calldata entries,
the live job/poster/asset amounts, waiver headroom, one-hour age gate, the
tombstone hash, the fixed reason code, and the printed `plan hash`.

## Phase 2 — claim, tombstone, and reject

The production operator/verifier is KMS-backed. Run where its AWS role has
`kms:GetPublicKey` and `kms:Sign`:

```bash
KMS_KEY_ID=<mainnet-signer-kms-key> AWS_REGION=<region> \
node scripts/ops/rescue-open-job.mjs \
  --profile mainnet \
  --escrow current \
  --phase prepare \
  --job-id 0x<32-byte-job-id> \
  --janitor 0x<averray-janitor-address> \
  --expected-signer 0x<operator-and-verifier-address> \
  --expected-plan-hash 0x<hash-from-reviewed-dry-run> \
  --confirm 'RESCUE 0x<32-byte-job-id>' \
  --use-kms \
  --execute
```

A concealed 1Password EOA can be selected instead with
`--signer-secret-ref 'op://vault/item/field'`; never place a raw key in an
environment variable or argument. The derived signer must equal
`--expected-signer` and hold both required roles.

The script stops after each receipt unless the expected next state is visible:
waiver enabled and preview fully waived; Claimed by the janitor with zero claim
stake/fee; Submitted with the canonical tombstone evidence; then Rejected with
the `OPERATOR_RESCUE` event reason. If a process interruption lands only part of
the sequence, inspect the chain, repeat the dry-run with `--resume`, review its
new plan hash, and execute that exact reduced plan. `--resume` accepts only a
partial rescue already bound to the same janitor and tombstone; it cannot adopt
an ordinary worker lifecycle.

The janitor must not open a dispute.

## Phase 3 — finalize after the live dispute window

The dry-run remains safe before the deadline: it prints the exact calldata and
the remaining seconds. It binds finalization to the job's canonical tombstone
and `OPERATOR_RESCUE` rejection event.

```bash
node scripts/ops/rescue-open-job.mjs \
  --profile mainnet \
  --escrow current \
  --phase finalize \
  --job-id 0x<32-byte-job-id> \
  --janitor 0x<averray-janitor-address> \
  --expected-signer 0x<permissionless-finalizer-address>
```

After `rejectedAt + DISPUTE_WINDOW`, execute the reviewed plan:

```bash
node scripts/ops/rescue-open-job.mjs \
  --profile mainnet \
  --escrow current \
  --phase finalize \
  --job-id 0x<32-byte-job-id> \
  --janitor 0x<averray-janitor-address> \
  --expected-signer 0x<permissionless-finalizer-address> \
  --expected-plan-hash 0x<hash-from-finalize-dry-run> \
  --confirm 'FINALIZE 0x<32-byte-job-id>' \
  --signer-secret-ref 'op://vault/item/private key' \
  --execute
```

Finalization is permissionless; a KMS signer may be used instead. The script
requires `Closed`, the same recorded poster, and exact reserved-to-liquid
movement for the refundable total. Archive the transaction hashes, blocks, and
before/after AAC position. Mark the support request refunded only after those
checks pass.

## Abort conditions

Stop without variations if any assertion fails, especially: a different state,
worker, poster, escrow address, chain, tombstone hash, reason code, role result,
waiver result, TTL, creation event, dispute deadline, plan hash, or balance
delta. Do not change a recipient, shorten either live window, open a dispute,
approve a payout, or retry a transaction blindly.
