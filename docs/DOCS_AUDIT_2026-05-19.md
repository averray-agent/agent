# Docs Audit - 2026-05-19

- **Status:** current docs-governance audit
- **Baseline reviewed:** `origin/main` at `163bd76`
- **Canonical roadmap:** [`PROJECT_ROADMAP.md`](./PROJECT_ROADMAP.md)

This audit records the second-pass review that made
`PROJECT_ROADMAP.md` the operating guideline for the project.

## Scope

Reviewed:

- all top-level `docs/*.md` files by inventory and targeted search;
- the roadmap/spec/audit/security/launch docs in detail;
- current open GitHub PRs and issues;
- recent merge history around audit closure PRs;
- Polkadot USDC/ERC20 precompile facts through the Polkadot docs MCP.

Not reviewed line-by-line:

- every schema JSON file;
- every fixture under `docs/fixtures`;
- every historical distribution/business note.

This was a roadmap/documentation-consistency audit, not a source-code
security audit.

## Authority Decision

`PROJECT_ROADMAP.md` is now the active guideline for:

- what is done;
- what is open;
- what is deferred;
- next work sequencing;
- launch and mainnet readiness layers.

Older docs are allowed to remain as detailed references, but they must not be
used as the current status source when they conflict with the roadmap.

## Corrections Made In This Pass

| Area | Finding | Correction |
| --- | --- | --- |
| Roadmap baseline | `PROJECT_ROADMAP.md` still referenced pre-merge baseline `ca32856`. | Updated baseline to `163bd76`. |
| Roadmap governance | No explicit rule said the roadmap wins over stale detail docs. | Added `Roadmap Authority` section to `PROJECT_ROADMAP.md`. |
| Source doc map | The latest docs audit itself was not listed. | Added this audit to the source-doc table. |
| Framework roadmap | `CORE_FRAMEWORK_ROADMAP.md` still said `AVERRAY_WORKING_SPEC.md` was the roadmap boundary. | Reworded it so `PROJECT_ROADMAP.md` owns status and sequencing, while the working spec owns architecture. |
| Historical spec audit | `SPEC_AUDIT_2026-05-13.md` said `AVERRAY_WORKING_SPEC.md` v2.9 was the primary source of truth. | Reworded the section as historical source context and pointed current status at `PROJECT_ROADMAP.md`. |
| Working spec reconciliation log | The v2.7 log said the framework roadmap pointed at the working spec as current source of truth. | Added a v2.11 documentation-governance entry noting that `PROJECT_ROADMAP.md` supersedes status ownership. |
| Audit remediation stale closures | `AUDIT_REMEDIATION.md` still marked `P1.2`, `P2.5`, `P2.5b`, and `P3.8` open even though later PRs closed them. | Updated their status lines with the closing PR/commit evidence. |
| Placeholder PR references | `AUDIT_REMEDIATION.md` still had `PR #<TBD>` for Package E. | Replaced with PR `#425`. |

## Current Document Roles

| Document | Role after audit |
| --- | --- |
| `PROJECT_ROADMAP.md` | Active status, sequencing, and project completion guideline. |
| `PRODUCTION_CHECKLIST.md` | Operator go/no-go checklist. Its unchecked boxes remain launch gates until closed. |
| `AVERRAY_WORKING_SPEC.md` | Product architecture, business model, and long-range strategy. |
| `CORE_FRAMEWORK_ROADMAP.md` | Framework detail reference for jobs, sessions, verification, SDK, timelines, and operations. |
| `AUDIT_REMEDIATION.md` | Detailed audit finding rationale and close criteria; not the current sequencing source. |
| `SPEC_AUDIT_2026-05-13.md` | Historical reconciliation snapshot. |
| `PRODUCT_PROOF_GATE.md` | Product-proof smoke and hosted evidence reference. |
| `SECRETS_MIGRATION.md` | Secrets and custody migration detail reference. |
| `PHASE_4B_STAGE_2C_PLAN.md` | KMS JWT Stage 2C cutover detail reference. |
| `THREAT_MODEL.md` | Risk and mitigation reference. |
| `RC1_WORKING_SPEC.md` | Historical design context only. |
| `RC1_IMPLEMENTATION_PLAN.md` | Historical rc1 slice tracker only. |

## Missing Governance Found

Before this audit, the repo had good detail docs but no explicit rule for which
one wins when they disagree. That created three practical risks:

- stale audit trackers could reopen work already closed by code;
- historical plans could look like current sequencing;
- future agents could update a detail doc without updating the operating
  roadmap.

The roadmap now carries the rule: status-changing PRs update
`PROJECT_ROADMAP.md`.

## Remaining Open Work Confirmed

This audit did not discover a new P0 launch blocker beyond the roadmap. The
current open work remains:

- P0 testnet launch gates in `PRODUCTION_CHECKLIST.md`;
- KMS JWT Stage 2C-2 draft PR `#439`;
- Phase 4e security plan PR `#440`;
- P1 platform hardening items: route split, frontend auth guard, verifier
  replay hardening, schema registration, dispute/arbitration semantics,
  timeline UX verification, and workflow generalization;
- mainnet readiness and native XCM/vDOT gates.

Open GitHub issues in `averray-agent/agent` at audit time: none.

## Polkadot Docs MCP Check

The audit rechecked the USDC/ERC20 precompile facts already carried in
`PROJECT_ROADMAP.md` against `smart-contracts/precompiles/erc20.md`:

- USDC Trust-Backed Asset ID `1337`;
- 6 decimals;
- precompile address `0x0000053900000000000000000000000001200000`;
- ERC20 precompile implements transfer, transferFrom, approve, allowance,
  balanceOf, and totalSupply;
- metadata functions are not implemented.

No roadmap correction was needed for those facts.
