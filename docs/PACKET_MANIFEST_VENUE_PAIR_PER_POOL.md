# PACKET — The ceremony resolves ONE venue adapter for TWO pools

Status: **READY FOR CODEX — blocks the first yield cycle** · 2026-09-05 ·
Author: Claude (architect+gate) · Repo: **platform** · One PR.
**No contracts. No funds. Manifest + script resolution only.**

## The failure

```
pool-venue-ceremony failed: Pool venueAdapter 0x0e3929F1698550e66dC532beB7790663A7a3734B
                            != manifest 0xE2801E6C640e0180798912649fD567E1Ea459a35.
```

`pool-venue-ceremony.mjs:732` reads a **single global key**:

```js
const manifestAdapter = getAddress(deployments.contracts?.hydrationDepositPoolAdapter);
```

Ceremony B (2026-09-05) bound **v2.1** to a new pair. There are now two:

| pool | adapter | lane |
|---|---|---|
| legacy v2 `0x6061f0aC…` | `0xE2801E6C…` | `0x88eE7027…` |
| **v2.1 `0x9B35A102…`** | **`0x0e3929F1…`** | **`0x2E01Bff9…`** |

**One key cannot describe two pools.** The guard is correct — it refuses to run
a ceremony against an adapter the repo does not know — but its lookup is
pool-blind, so it now blocks every v2.1 ceremony while passing legacy.

## What to build

**A — Record the v2.1 pair in the manifest.** The file already uses a versioned
convention (`hydrationDepositPoolAdapterV2`, `depositPoolLaneV2` — both legacy),
so follow it. The new pair's provenance, for the record:

- source commit `9ada467d`
- adapter creation bytecode `0xe862dde09519a056c22c17d3bc8071a9b9f1f8df3eeecca4636de7a04ae49a44`
- lane creation bytecode `0x997ddcced2590a77dda1a555e07916e9e55231f28e130b5b26d6bc9fc10e1efe`

Both hashes were reproduced independently on a second machine before binding.

**B — Resolve the expected adapter FOR THE TARGETED POOL.** The guard must
compare `pool.venueAdapter()` against the manifest entry belonging to
`--pool`, not a global key. A pool with no manifest entry must **fail closed**
naming the pool — never fall back to another pool's adapter.

**C — Check `pool-venue-dispatch.mjs` too.** Its `VENUE PAIRING` line appears
chain-derived (`pool.venueAdapter()` → `adapter.lane()`), which is already
pool-correct. **Confirm that rather than assume it**, and if it reads any global
manifest key, fix it the same way.

## Non-negotiables (each pinned by a test)

1. A ceremony targeting v2.1 resolves v2.1's adapter; one targeting legacy
   resolves the legacy adapter — same binary, same manifest, different `--pool`.
2. A `--pool` with **no** manifest entry fails closed naming that pool; it must
   never silently use another pool's adapter.
3. A manifest entry that disagrees with the live `venueAdapter()` still fails —
   the guard's protective behaviour is unchanged, only its lookup.
4. Legacy ceremonies behave exactly as before — prove by running the existing
   legacy path.
5. No contract, funds, or signing-path change.

## Why this matters beyond convenience

The pool now has an external depositor whose 6.5 USDC earns nothing until a
cycle runs. This guard is the only thing between that and the first deployment.

## Handback

PR number; green CI; the five test names; the new manifest keys; and a v2.1
`deploy` dry run reaching `staticCall: success`.
