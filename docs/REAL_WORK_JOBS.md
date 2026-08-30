# Real-work three-job bundle

`docs/real-work-jobs.json` is the ratified P-JOBS-REAL-THREE catalog bundle.
It is one operator-curated posting ceremony, not an ingestion feed and not a
canary:

- 3 jobs, exactly 2 USDC each
- 0 onboarding-waiver jobs
- 0 disposable proofs
- 6 USDC rewards plus the ratified 0.18 USDC brokered-gas budget
- Polkadot Hub chain `420420419`, USDC asset id `1337`
- honestly served as `operator-curated`, never as external demand

The live targets were checked on 2026-08-30 before the definitions were
written:

1. TricklePay issue
   [#165](https://github.com/TricklePay/tricklepay-frontend/issues/165), using
   `schema://jobs/github-pr-evidence-output` and the live `github_pr` verifier.
2. The Data.gov catalog record and CDC CSV for
   [Wastewater Viral Activity Level](https://catalog.data.gov/dataset/cdc-wastewater-viral-activity-level-for-sars-cov-2-influenza-a-and-rsv),
   using the existing open-data input/output schemas. The deterministic
   verifier requires the submitted URLs to equal the two pinned source URLs
   and fetches both before approval.
3. TricklePay issue
   [#136](https://github.com/TricklePay/tricklepay-frontend/issues/136), using
   `schema://jobs/coding-output`. Its pull request must reach 90/100, which
   requires live passing checks; a live failing check is an explicit rejection.

Both TricklePay jobs require the existing Averray disclosure footer to identify
the actual claimant wallet or claim session. `CONTRIBUTING.md` permits the work,
the two issues explicitly invite pull requests, and the repository had zero
open pull requests when selected.

## Posting ceremony

The publisher has no partial selector. It reads the public board first and
refuses unless all of these are true:

- every public `chainId` is `420420419`
- the reward bank is readable as USDC and has at least 6.18 liquid
- either none of the three ids exists or all three do
- the manifest still contains exactly three 2-USDC, non-waived, curated jobs

Dry-run after the verifier code is deployed:

```bash
node scripts/ops/post-real-work-job-bundle.mjs --dry-run
```

Then execute with a dedicated short-lived admin token:

```bash
ADMIN_JWT='<admin-jwt>' \
node scripts/ops/post-real-work-job-bundle.mjs --execute
```

After posting, the script reads the public catalog and refuses success unless
all three simultaneously serve as claimable 2-USDC jobs with
`contentTrust=operator-curated`, `posterTier=operator-curated`,
`postingRoute=curated`, and `onboardingWaiverEligible=false`.

The jobs use the normal curated lazy-funding rail: the single ceremony proves
the live reward bank can cover the full ratified bundle and the public
claimability gate agrees. It does not misstate lazy bank backing as external
poster escrow.
