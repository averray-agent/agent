# PACKET — The env lane registry silently replaces per-lane code defaults with global ones

Status: READY FOR CODEX · 2026-09-05 · Author: Claude (architect+gate) ·
Repo: **platform** · One PR. **No contracts, no funds.** Follow-up to #1340.

## What the live 409 proved

Running the operator bundle after #1340 deployed:

```
lane_backlog_saturated  origin: "operator"  unclaimedCount: 3  maxUnclaimedBacklog: 3
                        operatorReserve: 1   postingLimit: 3   oldestUnclaimedAt: 2026-09-04T20:11:01Z
```

`origin` and `operatorReserve` prove #1340 is live and the operator gets the full
cap — correct. But **`operatorReserve` reads 1, not the 2 that #1340 set for
`oss-anchored`.**

## Why

`loadCatalogueLaneRegistry` (`catalogue-lane-discipline.js:67–70`) prefers
`CATALOGUE_LANE_REGISTRY_JSON` from env over `DEFAULT_CATALOGUE_LANE_REGISTRY`.
Production sets that env (`deploy/backend.mainnet.env.template`, generated from
`deploy/backend.env.template`). Its three entries carry **only** `hypothesis`,
`dailyCapRaw`, `stopCondition`, `paused`. So per entry:

| field | env | code default per lane | what runs |
|---|---|---|---|
| `operatorReserve` | absent | liveness 1 · oss-anchored **2** · benchmark 1 | `?? 1` → **1 everywhere** (`:103`) |
| `maxUnclaimedBacklog` | absent | liveness **2** · oss-anchored 3 · benchmark **2** | `?? DEFAULT (3)` → **3 everywhere** (`:95`) |

Two lanes are running a looser backlog than designed, and the one reserve that
mattered is half its intended size. **Any per-lane default added in code is dead
on arrival in prod until someone remembers the env JSON.** #1340 shipped a value
that could not take effect.

## Why the reserve size decides the bundle

Two of the three 2.0 USDC jobs target `oss-anchored`. The operator needs **two
free slots**. With reserve 1 the scheduler keeps the lane at 2 of 3, leaving one
— the all-or-none bundle **can never post**. With reserve 2 it keeps the lane at
1, leaving two — it posts as soon as the pre-#1340 backlog ages out.

## What to build

**A — Immediate: make the env registry explicit.** In `deploy/backend.env.template`
(the source; then re-run `render-mainnet-backend-env.mjs` — CI `--check` fails if
the generated file is stale), set for every lane the values the code intends:
`liveness {maxUnclaimedBacklog 2, operatorReserve 1}`, `oss-anchored {3, 2}`,
`benchmark-showcase {2, 1}`.

**B — Durable: merge, don't replace.** When an env entry exists for a lane that
also has a code default, **fill absent numeric fields from that lane's code
default**, not from a global constant. Global fallbacks apply only to lanes the
code does not know.

**C — Refuse silent drift.** Validation should fail (or at minimum log at
`warn` with the field name) when an env entry omits a field whose code default
for that lane differs from the global default. This is what would have caught
#1340 not taking effect.

## Non-negotiables (each pinned by a test)

1. An env registry that omits `operatorReserve` for `oss-anchored` yields **2**,
   not 1 — mutation: remove the field, assert 2.
2. An env registry that omits `maxUnclaimedBacklog` for `liveness` yields **2**,
   not 3.
3. A lane present only in env (unknown to code) still gets the documented global
   defaults — B must not break additive lanes.
4. Omitting a non-global field for a code-known lane fails validation or emits a
   named warning (C) — assert the message names lane and field.
5. The rendered mainnet template is regenerated and `--check` passes.

## Timing — what to expect after this lands

The lane holds three unclaimed jobs posted **before** #1340 (oldest
2026-09-04T20:11Z, all before ~2026-09-05T10:30Z). The reserve cannot evict them;
they age out of the 24h window between **~20:11Z today and ~10:30Z tomorrow**,
or leave sooner if claimed. With reserve 2 live, the scheduler refills only to
1, and the bundle posts on its next run after that. **Nothing shortens this
except a claim.**

## Handback

PR number; green CI; the five test names; the rendered env diff for all three
lanes; and a live `GET` of the lane config (or the next 409 body) showing
`operatorReserve: 2` for `oss-anchored`.
