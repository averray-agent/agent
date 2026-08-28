# PACKET — The dispatch step has the same defect, and is mid-ceremony

Status: **READY FOR CODEX — TIME-SENSITIVE** · 2026-08-28 · Author: Claude
(architect+gate) · Repo: **platform, scripts** · One PR.
Same shape as #1317; this is that fix applied to the step I failed to scope.

## Live state — a ceremony is open

Deployment **4** was created on legacy v2 at 2026-08-28T20:31Z (tx
`0xe152e284…`). The pool moved 4.500000 USDC to the venue adapter
`0xE2801E6C…`, which now holds it **on Asset Hub**. `managedAssets(pool)` reads
exactly 4.500000, so **no friction has been incurred and no value has crossed
to Hydration.** `returnBy` is **2026-09-04T16:25:12Z**.

The XCM dispatch is a separate step and it cannot run:

- `scripts/ops/pool-venue-dispatch.mjs:25` imports `KmsSigner` with **no
  `credentialsProvider`** — the identical defect #1317 fixed in the ceremony
  driver. Mainnet KMS is Roles Anywhere via `PROFILE_BLOCKCHAIN_SIGNER`; the
  default chain resolves nothing.
- The backend image ships only `ceremony-module-loader.mjs`, `ceremony-rpc.mjs`
  and `pool-venue-ceremony.mjs`. **`pool-venue-dispatch.mjs` is not in the
  image**, so it cannot run where the key is usable.

## What to build

Apply #1317's pattern to `pool-venue-dispatch.mjs`: build the signer with
`buildKmsCredentialsProvider({ profile: PROFILE_BLOCKCHAIN_SIGNER })`, resolve
its imports against both the checkout and the image layout (it pulls
`kms-signer.js`, `abis.js` and `venue-balance-reader.js` from
`../../mcp-server/src/...`), and ship it plus any newly required runtime helper
in the Dockerfile — **only what it needs**, matching the narrow scope #1317
used.

Note the existing `check-dockerfile-deployments.test.mjs` guard already fails
when `src` reads a path the image does not ship; keep that satisfied.

## Preserve every existing guard

Staging enforces a fee-and-float relationship: `--float-headroom` must be at
least `--max-fee-per-leg` or it refuses. The ratified pair is **40,000 /
50,000**. **Do not change, relax, or default around any of it** — this PR is
about where the script can authenticate, not what it permits.

## Non-negotiables (each pinned by a test)

1. `--use-kms` binds the `averray-signer` Roles Anywhere provider — asserted.
2. Dual-layout module resolution, with a named error listing both attempted
   paths rather than a bare MODULE_NOT_FOUND.
3. Dry run remains the default and requests no credentials.
4. The fee/float refusal is unchanged — prove by mutation that
   `--float-headroom` below `--max-fee-per-leg` still refuses.
5. No change to dispatch economics, leg construction, or the guards.

## Handback

PR number; green CI; the test names; and the **exact command** that dry-runs
`stage-dispatch` for adapter request
`0xaa16f9a02dec9c2e8399ef427abeb1cfc0a4515a92d16bb47354ea1eec6e63a7`
(deployment 4) from inside `agent-mainnet-backend`.

## Why time matters, mildly

The 7-day window is already running while the funds sit undispatched and
earning nothing. That does not endanger anything — worst case we recall an
undispatched deployment for the cost of gas — but **the final rate must be
computed from days ACTUALLY AT THE VENUE, not from the window length.**
Record the dispatch-landed timestamp; it is the real start of the measurement.
