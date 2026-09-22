# RUNSHEET — make the canary's accidental claimant whole, and clear the arbitration queue

Written 2026-09-22. Executor: Pascal. Claude verifies each step from chain.

## Why the overturn, not a side payment

Worker `0x29A23c57B07B09806A3447cc76C6C70BBE13BBBA` claimed our canary's
orphaned job `worker-canary-1790030423761` and was rejected at
2026-09-22 13:05:36Z (details: `PACKET_CANARY_JOB_CLAIMABLE_BY_OUTSIDERS.md`).
If nothing happens, `finalizeRejectedJob` slashes their 0.01 stake and 0.05 fee
after **2026-09-29 13:05Z** and leaves a slash on their record. A worker-favour
dispute resolution instead pays the reward, releases stake and fee in full
(`_settleSuccessfulClaimEconomics`) and mints a badge. The overturn route
(#1377) is generic: any rejected session inside the on-chain dispute window.

## Step 1 — overturn (Mac, before 2026-09-29 13:05Z)

`eval $(op signin)` first if the 1Password session expired.

```bash
cd ~/averray-opsrun && export AWS_JWT_REGION=$(op read 'op://mainnet-backend/aws-jwt-signer-mainnet/aws-region') AWS_JWT_KEY_ID=$(op read 'op://mainnet-backend/aws-jwt-signer-mainnet/kms-key-id') JWT_PUBLIC_KEY_PEM=$(op read 'op://mainnet-backend/aws-jwt-signer-mainnet/public-key-pem-base64' | base64 -d) && T=$(node scripts/ops/mint-admin-jwt.mjs --profile mainnet --roles admin --expires-in-days 1 --use-kms --quiet) && curl -sS -X POST https://api.averray.com/admin/sessions/overturn -H "authorization: Bearer $T" -H "content-type: application/json" -d '{"sessionId":"worker-canary-1790030423761:0x29A23c57B07B09806A3447cc76C6C70BBE13BBBA","rationale":"Platform fault: this was a disposable test job of the hosted worker canary. The claim and the cleanup of the canary both received a 502 from the backend right after the 2026-09-21 22:39Z deploy, so the job stayed listed and was claimable through the public API. It was never meant for outside workers and its benchmark terms are canary-specific. The claimant should not carry a rejection or lose stake and fee for our listing failure."}' | python3 -c 'import json,sys; d=json.load(sys.stdin); print("canary claimant:", d.get("status") or d.get("error"), "|", (d.get("operatorOverturn") or {}).get("openedAt") or d.get("message"), "| window", (d.get("operatorOverturn") or {}).get("windowEndsAt"))'; unset T
```

Expected: `disputed`, an opened-at time, window end 2026-09-29T13:05:36Z.
Claude then reads the escrow: state 5 (Disputed).

## Step 2 — one arbitration session, three disputes (app, before 2026-09-29 20:24Z)

Operator app → Disputes drawer, arbitrator phone wallet
`0x7a246c722E9821D1eF861D01e1Ec43d7852b9707` on chain 420420419
(flow: `PACKET_ARBITRATION_FROM_THE_APP.md`, #1380). For each: verdict
**dismissed**, payout = full remaining, paste the rationale (it is published),
Prepare, sign on the phone.

| dispute | session | payout | rationale to paste |
|---|---|---|---|
| `dispute-99bd8759536d` | playsouthwales PR 128 | 1.0 | Platform fault: rejected on a disclosure-footer sentence the job never disclosed and a Vercel authorization prompt miscounted as failing CI, both fixed in #1377. The PR carried the claimant wallet and session and was merged by the maintainer on 2026-09-12. |
| `dispute-0760de0b2118` | TricklePay withdraw-disabled test 149 | 2.0 (as recommended 2026-09-15) | Platform fault: rejected on a disclosure-footer sentence the job never disclosed although the PR carried a matching claim session line, fixed in #1377. Under the corrected rules the submission is human review, not a rejection. |
| `dispute-b0651391023f` | canary job, claimant 0x29A23c57 | 0.1 | Platform fault: our canary's disposable job stayed listed after a deploy-time 502 and was claimable by outside workers. The claimant is made whole: reward paid, stake and fee returned. |

Claude verifies each `DisputeResolved` and the worker's AAC position
(the canary claimant's `jobStakeLocked` 0.06 → 0, liquid +0.06 +payout).
