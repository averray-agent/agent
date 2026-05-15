# Product-Proof Gate

This gate is the last public-surface check before production claims. It keeps
two things separate:

1. Read-only public contract checks: discovery, onboarding, schemas, and trust
   pages must agree.
2. Worker-loop evidence: a real hosted session must have completed
   discover -> sign in -> preflight -> claim -> submit -> verify ->
   badge/profile.

## Read-Only Gate

Run:

```bash
npm run check:product-proof
```

The script checks:

- `https://averray.com/.well-known/agent-tools.json`
- `https://api.averray.com/agent-tools.json`
- `https://api.averray.com/onboarding`
- `https://averray.com/trust/`
- `https://averray.com/schemas/`
- `https://averray.com/agents/`
- `https://averray.com/builders/`
- `https://averray.com/llms.txt`
- the public badge and profile JSON schemas
- the job schema index includes the built-in first-wave schemas, plus a sample
  job schema fetch

The public discovery manifest and API mirror must be byte-for-byte equivalent
after JSON parsing. This is the check that protects external agents from
learning one contract from the public site and another from the API host.

## Worker-Loop Evidence

The deploy workflow can generate this evidence itself when run manually with:

- `smoke_check_product_proof_gate=1`
- `product_proof_require_worker_loop=1`

That path uses the production `ADMIN_JWT` secret, creates a tiny benchmark job,
preflights it as the token wallet, validates the structured product-proof
submission through `/jobs/validate-submission`, probes one invalid
`submission.output` wrapper through the same read-only validation route, claims
it, submits matching evidence, runs the verifier, and writes the evidence file
before running the required gate. It does not print the token. The worker loop
fails closed before claim unless the valid schema validation succeeds, the
invalid schema validation is rejected without a submit attempt, the token
exposes the full loop capability set, the hosted stack reports canonical v1
USDC settlement readiness, and the worker wallet has enough AgentAccountCore
USDC liquidity for the reward.

The hosted smoke token must resolve from `/auth/session` with capabilities for:
`account:read`, `admin:status`, `jobs:create`, `jobs:preflight`, `jobs:claim`,
`jobs:submit`, `verifier:run`, and `session:read`. In practice this means the
1Password `prod-smoke/admin-jwt` item should be minted with both `admin` and
`verifier` roles before the manual production workflow is run.

For a local/manual run, first complete one hosted loop and write evidence:

```bash
PRODUCT_PROOF_EVIDENCE_FILE=/tmp/product-proof-evidence.json \
ADMIN_JWT="$ADMIN_TOKEN" \
npm run product-proof:worker-loop
```

The worker-loop command writes a local evidence file like:

```json
{
  "apiBaseUrl": "https://api.averray.com",
  "wallet": "0x...",
  "jobId": "product-proof-worker-loop-...",
  "sessionId": "sess_...",
  "verificationOutcome": "approved",
  "authReadiness": {
    "roles": ["admin", "verifier"],
    "capabilitiesPresent": [
      "account:read",
      "admin:status",
      "jobs:create",
      "jobs:preflight",
      "jobs:claim",
      "jobs:submit",
      "verifier:run",
      "session:read"
    ]
  },
  "settlementReadiness": {
    "settlementReady": true,
    "asset": {
      "symbol": "USDC",
      "address": "0x0000053900000000000000000000000001200000",
      "assetClass": "trust_backed",
      "assetId": 1337,
      "decimals": 6,
      "minBalanceRaw": "70000",
      "approved": true
    }
  },
  "rewardReadiness": {
    "asset": "USDC",
    "rewardRaw": "100000",
    "minBalanceRaw": "70000"
  },
  "liquidityReadiness": {
    "wallet": "0x...",
    "asset": "USDC",
    "requiredRaw": "100000",
    "availableRaw": "100000"
  },
  "preflightReadiness": {
    "jobId": "product-proof-worker-loop-...",
    "wallet": "0x...",
    "eligible": true,
    "claimable": true,
    "requiredOutputSchema": "schema://jobs/product-proof-worker-loop"
  },
  "validationReadiness": {
    "jobId": "product-proof-worker-loop-...",
    "valid": true,
    "schemaRef": "schema://jobs/product-proof-worker-loop",
    "schemaValidates": "payload.submission",
    "submissionKind": "structured",
    "validatedBeforeClaim": true
  },
  "invalidValidationReadiness": {
    "jobId": "product-proof-worker-loop-...",
    "valid": false,
    "submitSafe": false,
    "schemaRef": "schema://jobs/product-proof-worker-loop",
    "schemaValidates": "payload.submission",
    "code": "invalid_submission_shape",
    "path": "payload.submission.output",
    "checkedBeforeClaim": true,
    "submitAttempted": false
  },
  "claimReadiness": {
    "status": "claimed",
    "sessionId": "sess_..."
  },
  "submitStatus": "submitted",
  "sessionStatus": "resolved",
  "completedAt": "2026-05-13T11:11:31.000Z"
}
```

Then run:

```bash
PRODUCT_PROOF_REQUIRE_WORKER_LOOP=1 \
PRODUCT_PROOF_EVIDENCE_FILE=/path/to/product-proof-evidence.json \
npm run check:product-proof
```

The script fetches the badge and profile documents and verifies that:

- the evidence host matches the checked API host
- the evidence proves canonical v1 USDC settlement readiness
- the reward clears the USDC minBalance and the worker has enough USDC liquidity
- the job preflight was eligible and claimable before claim
- the product-proof submission passed schema validation before claim
- one intentionally invalid `submission.output` wrapper failed validation before
  claim and did not call `/jobs/submit`
- the submit, verification, and session statuses reached submitted, approved,
  and resolved
- the badge uses `averray.schemaVersion = "v1"`
- the badge session, job, and worker match the evidence file
- the profile uses `schemaVersion = "v1"`
- the profile wallet matches the evidence file
- the profile badge list contains the completed session

Do not mark the product-proof checklist complete from screenshots alone. The
evidence file and passing gate output are the durable proof.
