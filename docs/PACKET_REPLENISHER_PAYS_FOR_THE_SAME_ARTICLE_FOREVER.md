# PACKET — The Wikipedia replenisher re-ingests completed articles as fresh inventory

Status: ready for implementation. One PR. The lane is **paused in production**
(#1361, `WIKIPEDIA_INGEST_ENABLED=false`) until this lands; re-enabling is the
operator's call after the fix deploys.

## What happened (chain + catalogue, 2026-09-08 → 09-10)

`wiki-en-53577157-citation-repair-aufschrei` — one article, one pinned revision
(1370991727) — was reissued **r16 → r25 in ~48 h** and completed nine times by
three wallets, each paid 0.35 after retention:

| reissue | listed | claimed | by |
|---|---|---|---|
| r18–r20 | 09-09 14:14–15:44 | 11–45 min later | 0x4a83…bc87 |
| r21–r24 | 09-09 16:14 → 09-10 03:15 | 40 min–7 h later | 0x08ff…ad53 |
| r25 | 09-10 09:46 | still open at pause | — |

Wallet 0x08ff… ran a fully automated cycle (deposit 0.09 → claim → submit
within one minute → withdraw 0.44) roughly hourly and also took a second
article (58158792, r4). Nine completions bought nine proposals for the same
dead link; under the proposal-only policy none was applied upstream.

## Why — three facts that compose into a faucet

1. **Completed is not "seen".** `services/inventory-replenishment.js`
   `ACTIVE_SOURCE_STATES = {claimable, claimed, expired}`. The scheduler's
   `seenSources` is built from those only, so an exhausted/completed article
   is not excluded and is re-ingested via `withReissueJobId` with `reissueNumber`
   incremented. There is no cap on `reissueNumber`.
2. **Candidate order is deterministic.** `jobs/ingest-wikipedia-maintenance.js`
   reads the category with a fixed `cmlimit`, scores with `scoreArticle`
   (static features only) and sorts descending. The same article wins every
   run for as long as it stays in the category.
3. **The upstream signal never changes.** Proposal-only means the dead link is
   never fixed, so the article never leaves
   `Category:All articles with dead external links`. Nothing on our side
   records that we already bought a proposal for revision 1370991727.

The trigger is `minClaimableJobs = 2` (production default): every completion
drops claimable below 2, the 30-minute tick refills with the top-scored
candidate, which is the article just completed.

Not a defect: the verifier did what it is configured to do (benchmark:
2-of-3 keywords + revision-anchored URLs). Whether that verifier buys real
citation repair is a separate question, out of scope here.

## The fix

- **Completed sources are seen.** Extend the snapshot so a source key whose
  most recent job reached `exhausted`/completed/`resolved` is excluded from
  re-ingestion for a cooldown (`WIKIPEDIA_INGEST_COMPLETED_COOLDOWN_DAYS`,
  default 30) **unless the upstream state changed** — the article's current
  `revisionId` differs from the pinned one, or it left the category. Apply the
  same rule to every replenisher that uses `buildInventorySnapshot`
  (GitHub/OSV/OpenData ingestion share it; check each).
- **Hard cap per source.** `reissueNumber` ≤ `WIKIPEDIA_INGEST_MAX_REISSUES`
  (default 2) per (language, pageId, revisionId); beyond it the candidate is
  skipped with reason `reissue_cap_reached`, visible in the run summary.
- **Per-wallet, per-source once.** The claim gate refuses a wallet that has
  already been paid for the same source key (any reissue). Preflight must
  mirror it (parity lesson from the waiver packet).
- **Candidate diversity.** Break score ties and rotate the category listing
  (offset by run or `cmcontinue`) so the top article is not the only article.
- **Do not touch** the verifier, the lane registry caps, retention, or the
  proposal-only policy.

## Non-negotiables (each pinned by a test; I run the drills)

1. A completed source is not re-ingested inside the cooldown. Mutation: put
   `exhausted` back into the active set — must fail.
2. It **is** re-ingested when the upstream revision changed. Mutation: ignore
   the revision comparison — must fail.
3. `reissueNumber` never exceeds the cap; the summary names the skip reason.
   Mutation: drop the cap — must fail.
4. A wallet paid once for a source cannot claim its reissue; preflight and the
   claim gate agree (parity test on both). Mutation: remove from one side — must fail.
5. Two consecutive runs with identical category input produce different first
   candidates when the first was skipped. Mutation: remove rotation — must fail.
6. GitHub/OSV replenishers keep their current behaviour except for the shared
   completed-source rule (their existing tests stay green).

## Handback

PR number, green CI, the six test names, and a dry-run summary from the
scheduler against production data (`WIKIPEDIA_INGEST_DRY_RUN=1` path or the
equivalent) showing Aufschrei skipped with `completed_cooldown` and the next
candidate named. Re-enabling the lane is a separate operator decision.
