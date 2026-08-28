# PACKET — Make the venue ceremony name its pool explicitly

Status: READY FOR CODEX · 2026-08-27 · Author: Claude (architect+gate) ·
Repo: **platform, mcp-server + scripts** · One PR. **No contract changes.**
Operator decision 2026-08-27: **measure before binding**, which this unblocks.

## Why

`scripts/ops/pool-venue-ceremony.mjs` takes its target from
`deployments.contracts?.depositPool` and has **no `--pool` override**. That key
changed meaning under it: before the A6 cutover it meant legacy v2; it now
means v2.1. So which pool a money ceremony targets currently depends on **which
worktree it is run from** — a stale checkout silently targets a different pool
than a fresh one. That is not a hypothetical; both conditions exist on this
machine today.

It also never checks that the resolved pool *has* a venue. Pointed at v2.1
(`venueAdapter() == address(0)`) it would build a full deployment plan and fail
on-chain.

And the observability guard — correct in intent — compares the monitor snapshot
against the resolved pool. The monitor watches only
`gateway.config.depositPoolAddress`, so **no ceremony can run against the
legacy pool at all**, even read-only. That blocks the ratified plan to measure
the venue before permanently binding one to v2.1.

## What to build

**A — `--pool <address>`, required whenever it differs from the manifest
default.** The ceremony must state which pool it is acting on rather than
inheriting it from a file whose meaning has already shifted once. Log the
resolved address prominently in every mode.

**B — A precondition: the target pool must have a venue bound.** Refuse before
building any plan if `venueAdapter() == address(0)`, with a named error. Fail
early and legibly rather than on-chain.

**C — Observability that can describe the requested pool.** The backend already
carries `legacyDepositPoolV2Address` in config. Expose a snapshot for the
legacy pool so `assertObservability` can be satisfied for a ceremony that
legitimately targets it. **Keep the guard** — an unobserved yield ceremony must
still be refused; widen what can be observed, never weaken the check.

## Non-negotiables (each pinned by a test)

1. With `--pool` omitted and a manifest whose `depositPool` differs from the
   legacy address, the resolved pool is logged and matches the manifest — no
   silent inheritance from a stale tree.
2. A pool with `venueAdapter() == address(0)` is refused with a named error
   before any plan is built.
3. `assertObservability` still refuses a mismatched or missing snapshot —
   prove by mutation that a wrong-pool snapshot fails.
4. A ceremony targeting the legacy pool can obtain a matching snapshot and pass
   the guard.
5. No change to deployment economics, fee gating, staging, or signing.

## Out of scope

Ceremony B itself, the venue measurement, contract changes, and anything that
moves funds. This PR only makes the ceremony say which pool it means.

## Handback

PR number; green CI; the five test names; and the exact command that would run
a **dry-run** deploy against legacy v2 `0x6061f0aC…` from a current checkout.
