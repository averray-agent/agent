# RUNSHEET — Ceremony B signing package (ready to sign)

Status: **PAIR DEPLOYED AND VERIFIED — four calls ready** · 2026-09-05 ·
Executor: Pascal. Paused for the night 2026-09-05, to sign next morning.

## The deployed pair — verified on-chain

| | |
|---|---|
| lane `HydrationUsdcAdapterV22` | **`0x2E01Bff98adB023e4061044F8D1E2516151b3FB3`** (9,948 bytes) |
| adapter `HydrationDepositPoolAdapter` | **`0x0e3929F1698550e66dC532beB7790663A7a3734B`** (8,882 bytes) |
| source commit | `9ada467d` |
| lane creation bytecode | `0x997ddcced2590a77dda1a555e07916e9e55231f28e130b5b26d6bc9fc10e1efe` |
| adapter creation bytecode | `0xe862dde09519a056c22c17d3bc8071a9b9f1f8df3eeecca4636de7a04ae49a44` |

Both hashes **independently reproduced** on a second machine from a different
commit — the deployed bytecode is attributable, which is what a set-once bind
requires.

Gate (all passed): `adapter.lane()` = the lane · `lane.agentAccountCore()` =
the adapter · `adapter.pool()` = `0x9B35A102…` (**v2.1**, not legacy) ·
asset = USDC · policy = `0x226F1425…` · lossReporter = `0x01E6eed8…`.

## Preconditions — verified 2026-09-05, RE-CHECK before signing

Both pools `activeVenueDeploymentId == 0` and `activeVenueRecallId == 0`;
wrapper `dispatchPaused == false`. **Re-read these in the morning** — a
settlement or deployment overnight invalidates them.

## The four calls (Nova Spektr "Call data")

Weight limits `refTime 20e9 / proofSize 800k / deposit 0.5 DOT` — the values
that worked for the write-off. The earlier `4e9/100k` from an old note FAILED.

**1 — pause dispatch**
```
0x5a01f20b35a3f85ec864127b551ce8a64446fc0ed2bc000700c817a80402d430000700f2052a01901f59d6fb0000000000000000000000000000000000000000000000000000000000000001
```

**2 — register the lane**
```
0x5a01f20b35a3f85ec864127b551ce8a64446fc0ed2bc000700c817a80402d430000700f2052a011101eda96b664141435f49444c455f485944524154494f4e5f563100000000000000000000000000000000000000000000002e01bff98adb023e4061044f8d1e2516151b3fb3
```

**3 — unpause**
```
0x5a01f20b35a3f85ec864127b551ce8a64446fc0ed2bc000700c817a80402d430000700f2052a01901f59d6fb0000000000000000000000000000000000000000000000000000000000000000
```

**4 — bind the venue. IRREVERSIBLE.**
```
0x5a019b35a102d656fb86d798af81959e09961dec28e0000700c817a80402d430000700f2052a01905711cd380000000000000000000000000e3929f1698550e66dc532beb7790663a7a3734b
```

Eyeball check: 1–3 target `f20b35a3…` (wrapper); **4 targets `9b35a102…`
(v2.1), never `6061f0ac…` (legacy)**. Call 2 embeds `2e01bff9…` (lane); call 4
embeds `0e3929f1…` (adapter). All `value 0`.

Keep 1–3 in one session — pausing halts ALL XCM dispatch.

## After binding — what is true and what is not

v2.1 becomes **able** to earn. It will not be earning: `deployToVenue` caps at
`NOTICE_7_DAYS`, whose break-even is **23.76 deployable** against roughly
**10.05**. The first cycle is therefore **operator-subsidised at ~0.0297 per
7 days (~0.22/yr)** and the page must say so — see
`RUNSHEET_YIELD_FOR_THE_FIRST_DEPOSITOR.md`.

## Also waiting

**The three 2-USDC jobs** are throttled by `oss-anchored`'s rolling 24h backlog
(3 unclaimed, max 3). The window rolls **~2026-09-05T17:46Z**; re-run the bundle
after that. The admin token path is solved — SIWE-mint with the admin EOA, which
returns roles `["admin","verifier"]`. There is **no stored admin refresh token**;
`op://prod-smoke/admin-refresh-token` was deleted a month ago.
