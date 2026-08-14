# PKT-WITNESS-001 handoff

Measured 2026-08-14 with Witness image
`sha256:13846375c8a2a2432cf9ea17b2350b79515f54608c0cf736c52c91df89cc5027`.
The authoritative per-repository reports and captured attempts are in
[`evidence/corpus`](evidence/corpus); [`summary.json`](evidence/corpus/summary.json)
is derived from those reports.

## Distribution

| Classification | Count |
|---|---:|
| `HERMETIC` | 1 |
| `FROZEN_DEPENDENCIES` | 4 |
| `MOCKED_EXTERNAL_SYSTEM` | 0 |
| `REQUIRES_NETWORK` | 4 |
| `UNMATERIALIZABLE` | 1 |

Five of ten repositories were materializable by the Phase-1 Witness: one with no
dependency work and four after a frozen cache was prepared. Four require a network
or a preparation path not pinned in this image. One requires an absent Rust
toolchain.

Preparation median across all ten repositories was **0.000 seconds**. Among the four
repositories that actually required preparation, the median was **17.464 seconds**.
The worst case was `averray-agent/agent`: **129.896 seconds** of preparation, a
**263,378,946-byte** cache, and **248.240 seconds** total.

| Repository | Classification | Base | Preparation | Cache bytes | Total |
|---|---|---:|---:|---:|---:|
| `Kc1t/alethe-agents` | `FROZEN_DEPENDENCIES` | 0 | 17.695s | 82,297,396 | 45.698s |
| `reticlehq/reticle` | `REQUIRES_NETWORK` | 127 | 0.000s | 0 | 4.176s |
| `ConvoBrains/zero-cost-crm` | `FROZEN_DEPENDENCIES` | 1 | 11.138s | 66,923,946 | 15.342s |
| `depre-dev/averray-reference-agent` | `FROZEN_DEPENDENCIES` | 1 | 17.233s | 37,055,307 | 124.028s |
| `depre-dev/averray-send-test` | `HERMETIC` | 0 | 0.000s | 0 | 1.225s |
| `averray-agent/agent` | `FROZEN_DEPENDENCIES` | 1 | 129.896s | 263,378,946 | 248.240s |
| `expressjs/express` | `REQUIRES_NETWORK` | 127 | 0.000s | 0 | 1.303s |
| `pytest-dev/pluggy` | `REQUIRES_NETWORK` | 4 | 0.000s | 0 | 1.237s |
| `pallets/click` | `REQUIRES_NETWORK` | 4 | 0.000s | 0 | 1.327s |
| `BurntSushi/ripgrep` | `UNMATERIALIZABLE` | 127 | 0.000s | 0 | 1.320s |

Three materializable repositories already fail their base check:
`zero-cost-crm`, `averray-reference-agent`, and `averray-agent/agent`. Their commands
cannot be frozen as pass-on-base acceptance criteria without first resolving or
changing the baseline policy. This is independent of their materialization result.

Observed non-materializable reasons were preserved rather than normalized away:

- `reticle` declares pnpm and invokes Turbo, but the Phase-1 image has no pinned pnpm
  cache preparation path.
- Express has no committed npm lockfile on the measured revision; Mocha is absent
  without fetching dependencies.
- Pluggy requires pytest 8 or newer but has no frozen requirements input understood
  by this phase.
- Click cannot import its own test dependency closure and has no frozen requirements
  input understood by this phase.
- Ripgrep's check command cannot start because Cargo is not in the image.

## Drills

[`evidence/drills.json`](evidence/drills.json) records the full red/green values.

| Drill | Without execution guard | With execution guard |
|---|---|---|
| Genuine network dependency | `RED`: statically guessed `HERMETIC` | `GREEN`: `REQUIRES_NETWORK`, exit 1 |
| Missing toolchain | `RED`: untyped error | `GREEN`: typed `UNMATERIALIZABLE` |
| Lockfile + test script, still non-hermetic | `RED`: statically guessed `HERMETIC` | `GREEN`: `REQUIRES_NETWORK`, exit 1 |
| NetworkMode `none` | `RED`: bridge control exposed non-loopback | `GREEN`: container observed only `lo` and Docker mode `none` |

## Architecture clarifications

Three details in the architecture need tightening; none contradict Phase 1 strongly
enough to stop this packet.

1. Section 3.1 asks whether a repository can be "materialized completely offline,"
   while the packet correctly requires Git clone and submodule acquisition
   host-side with network. The architecture should distinguish **source acquisition**
   from **offline dependency materialization and check execution**.
2. Candidate modifiability is not a property of a command alone. It depends on the
   job's allowed/protected-path policy, which is not part of the minimal Phase-1 CLI.
   This implementation records the default assumption `allowedPaths: ["**"]` and
   supports repeatable `--protected-path` inputs; the frozen Verification Contract
   should make that policy mandatory later.
3. `MOCKED_EXTERNAL_SYSTEM` cannot be inferred merely from an offline success. It
   needs an explicit, hashed frozen-input declaration (and later, stronger provenance
   or access evidence). This implementation only emits it when `--frozen-input` is
   supplied and the check actually runs offline.

## Scope and checks

The change affects only the new top-level `witness/` package plus the root
`test:witness` script. It does not change backend, frontend, indexer, Caddy,
contracts, public site, worker, or settlement code. It requires Docker for real
preflights and no new npm/PyPI/Cargo dependency or VPS secret.

Checks run:

- `npm run test:witness`
- `npm run test:ops` (1,019 passed, 1 skipped, 0 failed)
- `node --check` over all four Witness CLIs
- `npm --prefix witness run drills -- --out evidence/drills.json`
- `npm --prefix witness run corpus -- --out-dir evidence/corpus --timeout 180`
