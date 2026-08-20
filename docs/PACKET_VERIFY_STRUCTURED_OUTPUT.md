# PACKET — Verify profile 3: `structured-output-evidence-v1`

**Author:** Claude (architect) · **Ratifier:** Pascal · **Date:** 2026-08-20
**Implementer:** Codex · **Deliverable:** ONE PR (mcp-server). Completes the three-profile Verify shelf.

## 1. What it verifies (and deliberately does not)

A buyer pays to verify a **structured output an agent produced**: a JSON document that
must (a) conform to the buyer's declared JSON Schema and (b) carry citations whose
quoted spans actually appear in the cited source documents.

**Deterministic core — no judgment, no network.** "Cited-source support" in v1 means
**verbatim quote presence** (whitespace-normalized) in the referenced source artifact.
It is NOT an assessment that sources semantically support claims — the successCriteria
statement says so explicitly. Semantic support requires judgment, which
`AUTO_DECIDABLE_MODES` (frozen) forbids; that is a future profile, not scope creep here.

The sealed runner needs **no network**: all three inputs arrive as sha256-pinned
artifacts (same `GIT_ARTIFACT_SCHEMA` shape profile 1 uses), materialized before the
sandbox, hashes re-verified INSIDE the runner per the witness law.

## 2. Registry entry (verification-profile-registry.js)

- `name: "structured-output-evidence-v1"`, `version: 1`, `handler: "deterministic"`,
  `handlerVersion: 1`, `price: VERIFY_PROFILE_PRICE` (flat, shared), `status: "published"`.
- Export `STRUCTURED_OUTPUT_EVIDENCE_PROFILE_REF = "structured-output-evidence-v1@1"`.
- `inputSchema` (additionalProperties: false throughout):
  - `target`: `{ output: ARTIFACT, schema: ARTIFACT, sources: ARTIFACT[] (minItems 1, maxItems 16) }`
    — ARTIFACT = the existing sha256/bytes/locator(https)/format shape; `format: "json"`
    for output and schema, free-form for sources (text/markdown/json).
  - `inputs`: `{ citationsPointer?: string }` — RFC 6901 JSON Pointer into the output
    document, default `"/citations"`, maxLength 256.
- **Citation convention (part of the profile contract):** the value at
  `citationsPointer` must be a non-empty array of
  `{ source: integer (index into target.sources), quote: string (1..2048 chars) }`.
  An absent or empty citations array is a **FAIL** of citation resolution, not a skip —
  the profile's name is *evidence*; schema-only buyers are a future profile (§7).

## 3. Checks → evidence outputs (matchMode `contains_all`)

`STRUCTURED_OUTPUT_EVIDENCE_CHECKS`:
1. `output-integrity` → `structured_output_integrity_pass` — all artifact hashes
   re-verified in-runner; output and schema parse as JSON.
2. `schema-valid` → `structured_schema_valid_pass` — the declared schema compiles
   (JSON Schema draft 2020-12, bounded depth ≤ 32).
3. `schema-conformance` → `structured_schema_conformance_pass` — output validates.
4. `citation-resolution` → `structured_citation_resolution_pass` — citations array
   present per §2, every `source` index in range, every `quote` non-empty.
5. `quote-support` → `structured_quote_support_pass` — every quote appears verbatim in
   its referenced source after normalization (collapse whitespace runs to single
   spaces, trim; NO case folding, NO fuzzy matching — normalization is part of the
   pinned contract and documented in the profile).

Verdict: PASS only when all five evidence outputs are present. Any check failing on the
buyer's materials = **FAIL (billed — a decisive verdict)**. Runner death, artifact
fetch failure, or in-runner hash mismatch = **inconclusive, never billed** — reuse the
existing taxonomy; add a reason string only if none of the existing
`VERIFY_INCONCLUSIVE_REASONS` fits (additive-only change to that list).

## 4. successCriteria statement (verbatim — truth-boundary reviewed)

> "The output document parsed as JSON, validated against the declared schema, and every
> cited quote appears verbatim (whitespace-normalized) in its referenced source
> artifact during one bounded check. Verbatim presence is not an assessment that the
> sources semantically support the claims, and this is not a certification."

## 5. Limits

`timeoutMs: 30_000` · `sizeBytes: 8_388_608` total materialized (output ≤ 1 MiB,
schema ≤ 256 KiB, each source ≤ 2 MiB — enforced individually) · `cpuLimit: 1` ·
`memoryMb: 256` · `processLimit: 64` · `temporaryStorageMb: 32` ·
`outputLimitBytes: 512 * 1024`.

## 6. Fixtures, drills, CI

- Known-good replay fixture (`services/__fixtures__/structured-output-evidence-v1-known-good.json`):
  two sources, a conformant document, ≥3 citations, all five outputs present.
- Mutation drills (each must FAIL/flip by name):
  1. one word altered inside one quote → `quote-support` fails;
  2. one required schema property removed from the output → `schema-conformance` fails;
  3. citations array emptied → `citation-resolution` fails;
  4. source artifact bytes changed without updating sha256 → inconclusive, **unbilled**,
     with the billing assertion in the test (capture never attempted).
- Whitespace-normalization edge test: quote with a newline inside matches the same text
  wrapped differently in the source (documents the normalization contract).
- **Container law:** compose-level CI proves the fixture inside the built witness
  images (green host CI ≠ boots in its container — third-time law).
- Registry tests mirror profile 2's: ref exported, listed at `/verify/profiles`,
  schema round-trips, price shared.

## 7. Out of scope (explicit)

Semantic/LLM support judgment (frozen out) · live-URL citation fetching (no network;
egress proxy stays profile-2-only) · schema-only mode (future profile) · any
`AUTO_DECIDABLE_MODES` widening · marketing changes (the /verify page and manifest
render profiles live from the registry — nothing to edit).

## 8. Acceptance gates

1. CI green including the compose-level fixture run.
2. `GET /verify/profiles` (prod, post-deploy) lists all THREE profiles.
3. All four mutation drills verified red-then-green in the PR's test output.
4. Claude gates the successCriteria statement and citation-convention docs before merge.
