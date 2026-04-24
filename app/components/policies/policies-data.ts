import type { Approval, Policy, SignerKey } from "./types";
import { SIGNERS } from "./signers";

const approved = (k: SignerKey, at: string, sig: string): Approval => ({
  key: k,
  ...SIGNERS[k],
  state: "signed",
  at,
  sig,
});
const pending = (k: SignerKey): Approval => ({
  key: k,
  ...SIGNERS[k],
  state: "pending",
});

export const POLICIES: Policy[] = [
  {
    id: "p-01",
    tag: "claim/deps-sec-only@v4",
    scope: "claim",
    scopeLabel: "Claim",
    severity: "gating",
    signersReq: 2,
    signersTotal: 3,
    signerKeys: ["fd2e", "9a13", "3e42"],
    activeSince: "2026-03-11",
    lastChange: {
      text: "Raised max-cvss from 6.0 to 7.5 for auto-pass",
      author: "fd2e",
      at: "2026-04-19 11:04 UTC",
    },
    state: "Active",
    revision: 4,
    rooms: ["runs/coding/*", "runs/deps-bump/*"],
    handler: "verifier/deps_sec_only.ts",
    gates: "Auto-claim on dependency bumps where only security advisories changed.",
    attachedJobs: [
      { id: "run-2741", title: "deps/sec-only bump", at: "14:08 UTC" },
      { id: "run-2720", title: "lodash 4.17.20 → 4.17.21", at: "11:02 UTC" },
      { id: "run-2714", title: "next 14.1.2 → 14.1.4 (CVE-2024-34351)", at: "09:41 UTC" },
    ],
    rule: {
      v4: `{
  "kind": "claim.auto",
  "scope": "deps-bump",
  "require": {
    "advisory_type": "security",
    "semver_delta": ["patch", "minor"],
    "max_cvss": 7.5
  },
  "deny": {
    "lockfile_drift": true,
    "transitive_majors": true
  },
  "receipt": {
    "co_sign": ["verifier_handler"],
    "attach_cvss_trail": true
  }
}`,
      v3: `{
  "kind": "claim.auto",
  "scope": "deps-bump",
  "require": {
    "advisory_type": "security",
    "semver_delta": ["patch", "minor"],
    "max_cvss": 6.0
  },
  "deny": {
    "lockfile_drift": true,
    "transitive_majors": true
  },
  "receipt": {
    "co_sign": ["verifier_handler"],
    "attach_cvss_trail": true
  }
}`,
      v2: `{
  "kind": "claim.auto",
  "scope": "deps-bump",
  "require": {
    "advisory_type": "security",
    "semver_delta": ["patch"],
    "max_cvss": 6.0
  },
  "deny": {
    "lockfile_drift": true
  },
  "receipt": { "co_sign": ["verifier_handler"] }
}`,
      v1: `{
  "kind": "claim.auto",
  "scope": "deps-bump",
  "require": { "advisory_type": "security" }
}`,
    },
    approvals: [
      approved("fd2e", "2026-04-19 11:04 UTC", "0x7a0c…b11e"),
      approved("9a13", "2026-04-19 11:09 UTC", "0x84df…2241"),
      approved("3e42", "2026-04-19 11:12 UTC", "0x9e11…6ab0"),
    ],
    history: [
      { rev: 4, author: "fd2e", at: "2026-04-19", summary: "Raised max-cvss ceiling to 7.5 to cover HIGH advisories.", active: true },
      { rev: 3, author: "9a13", at: "2026-02-06", summary: "Allow minor semver deltas, not just patch.", active: false },
      { rev: 2, author: "fd2e", at: "2025-12-22", summary: "Deny lockfile drift; require verifier co-sign.", active: false },
      { rev: 1, author: "fd2e", at: "2025-10-01", summary: "Initial policy — security advisories only.", active: false },
    ],
  },
  {
    id: "p-02",
    tag: "claim/writer-cited@v3",
    scope: "claim",
    scopeLabel: "Claim",
    severity: "gating",
    signersReq: 2,
    signersTotal: 3,
    signerKeys: ["fd2e", "9a13", "c8f1"],
    activeSince: "2026-02-02",
    lastChange: {
      text: "Require ≥2 internal citations per 300 words",
      author: "9a13",
      at: "2026-04-15 09:20 UTC",
    },
    state: "Active",
    revision: 3,
    rooms: ["runs/writer-gov/*", "runs/docs/*"],
    handler: "verifier/writer_cited.ts",
    gates: "Content writer outputs must cite internal docs at a minimum density.",
    attachedJobs: [
      { id: "run-2738", title: "docs refresh — v3.1", at: "13:58 UTC" },
      { id: "run-2701", title: "builders/xcm primer", at: "Apr 22 10:12" },
    ],
    rule: {
      v3: `{
  "kind": "claim.auto",
  "scope": "writer.output",
  "require": {
    "citations.internal.per_300w": 2,
    "citations.external.allowed": false,
    "heading_depth.max": 3
  },
  "receipt": { "attach_citation_graph": true }
}`,
      v2: `{
  "kind": "claim.auto",
  "scope": "writer.output",
  "require": {
    "citations.internal.per_300w": 1,
    "citations.external.allowed": false
  }
}`,
      v1: `{
  "kind": "claim.auto",
  "scope": "writer.output",
  "require": { "citations.external.allowed": false }
}`,
    },
    approvals: [
      approved("fd2e", "2026-04-15 09:20 UTC", "0x1b77…04e2"),
      approved("9a13", "2026-04-15 09:24 UTC", "0xaa3c…91d0"),
      approved("c8f1", "2026-04-15 09:40 UTC", "0x5e02…7712"),
    ],
    history: [
      { rev: 3, author: "9a13", at: "2026-04-15", summary: "Citation density ≥ 2 per 300 words; depth cap added.", active: true },
      { rev: 2, author: "fd2e", at: "2026-01-18", summary: "Require ≥ 1 internal citation per 300 words.", active: false },
      { rev: 1, author: "fd2e", at: "2025-09-11", summary: "Initial — ban external links.", active: false },
    ],
  },
  {
    id: "p-03",
    tag: "claim/handoff-sig@v2",
    scope: "claim",
    scopeLabel: "Claim",
    severity: "hard-stop",
    signersReq: 3,
    signersTotal: 3,
    signerKeys: ["fd2e", "9a13", "3e42"],
    activeSince: "2025-11-04",
    lastChange: {
      text: "ed25519 required on every handoff payload",
      author: "3e42",
      at: "2026-03-01 08:12 UTC",
    },
    state: "Active",
    revision: 2,
    rooms: ["runs/coding-hand/*"],
    handler: "verifier/handoff_sig.ts",
    gates: "Agent-to-agent handoffs must carry a valid signature over the payload.",
    attachedJobs: [{ id: "run-2739", title: "sig-mismatch on handoff — disputed", at: "14:02 UTC" }],
    rule: {
      v2: `{
  "kind": "claim.gate",
  "scope": "handoff.payload",
  "require": {
    "signature.alg": "ed25519",
    "signature.over": ["payload_hash", "prev_receipt"],
    "ttl_seconds": 180
  },
  "on_fail": "hard_stop"
}`,
      v1: `{
  "kind": "claim.gate",
  "scope": "handoff.payload",
  "require": {
    "signature.present": true,
    "ttl_seconds": 300
  },
  "on_fail": "dispute"
}`,
    },
    approvals: [
      approved("fd2e", "2026-03-01 08:12 UTC", "0x0c44…a1fe"),
      approved("9a13", "2026-03-01 08:14 UTC", "0xe1b8…5d02"),
      approved("3e42", "2026-03-01 08:19 UTC", "0x7715…9a14"),
    ],
    history: [
      { rev: 2, author: "3e42", at: "2026-03-01", summary: "Upgrade to ed25519, tighten TTL to 180s, on_fail → hard_stop.", active: true },
      { rev: 1, author: "fd2e", at: "2025-11-04", summary: "Initial — require any signature, dispute on fail.", active: false },
    ],
  },
  {
    id: "p-04",
    tag: "settle/dual-sign@v5",
    scope: "settle",
    scopeLabel: "Settle",
    severity: "hard-stop",
    signersReq: 3,
    signersTotal: 3,
    signerKeys: ["fd2e", "9a13", "b70c"],
    activeSince: "2025-08-19",
    lastChange: {
      text: "Floor raised: co-sign required over 50 DOT (was 100)",
      author: "b70c",
      at: "2026-04-08 16:44 UTC",
    },
    state: "Active",
    revision: 5,
    rooms: ["runs/*/settle", "treasury/outflows"],
    handler: "verifier/settle_dual_sign.ts",
    gates: "Any settlement that releases DOT from AgentAccountCore requires two operator signatures.",
    attachedJobs: [
      { id: "run-2731", title: "settle r_4df19 — 72 DOT", at: "12:40 UTC" },
      { id: "run-2718", title: "settle r_4dc02 — 120 DOT", at: "10:04 UTC" },
      { id: "run-2705", title: "settle r_4dab1 — 58 DOT", at: "Apr 22 14:50" },
    ],
    rule: {
      v5: `{
  "kind": "settle.gate",
  "source": "AgentAccountCore",
  "require": {
    "co_sign.min": 2,
    "co_sign.over_amount_dot": 50,
    "window.seconds": 900
  },
  "on_fail": "hard_stop",
  "receipt": { "attach_signature_chain": true }
}`,
      v4: `{
  "kind": "settle.gate",
  "source": "AgentAccountCore",
  "require": {
    "co_sign.min": 2,
    "co_sign.over_amount_dot": 100,
    "window.seconds": 900
  },
  "on_fail": "hard_stop",
  "receipt": { "attach_signature_chain": true }
}`,
      v3: `{
  "kind": "settle.gate",
  "require": {
    "co_sign.min": 2,
    "co_sign.over_amount_dot": 250
  },
  "on_fail": "hard_stop"
}`,
      v2: `{
  "kind": "settle.gate",
  "require": { "co_sign.min": 2 }
}`,
      v1: `{ "kind": "settle.gate", "require": { "co_sign.min": 1 } }`,
    },
    approvals: [
      approved("fd2e", "2026-04-08 16:44 UTC", "0x2a8d…f401"),
      approved("9a13", "2026-04-08 16:47 UTC", "0xbe70…10ac"),
      approved("b70c", "2026-04-08 16:52 UTC", "0x4410…29bf"),
    ],
    history: [
      { rev: 5, author: "b70c", at: "2026-04-08", summary: "Co-sign floor: 50 DOT (was 100). Attach full signature chain to receipt.", active: true },
      { rev: 4, author: "fd2e", at: "2026-02-11", summary: "Lowered floor from 250 → 100 DOT after treasury review.", active: false },
      { rev: 3, author: "fd2e", at: "2025-12-05", summary: "Added TTL window of 15 minutes for co-sign collection.", active: false },
      { rev: 2, author: "fd2e", at: "2025-10-22", summary: "Require 2 co-signs for all settles, no amount gate.", active: false },
      { rev: 1, author: "fd2e", at: "2025-08-19", summary: "Initial — single-sign settle.", active: false },
    ],
  },
  {
    id: "p-05",
    tag: "settle/receipt-hash-match@v2",
    scope: "settle",
    scopeLabel: "Settle",
    severity: "hard-stop",
    signersReq: 2,
    signersTotal: 3,
    signerKeys: ["fd2e", "3e42", "9a13"],
    activeSince: "2025-10-10",
    lastChange: {
      text: "Verifier now checks receipt hash across last 3 blocks",
      author: "3e42",
      at: "2026-02-28 13:05 UTC",
    },
    state: "Active",
    revision: 2,
    rooms: ["runs/*/settle"],
    handler: "verifier/settle_receipt_match.ts",
    gates: "Settlement tx must quote a receipt hash that matches the on-chain attestation.",
    attachedJobs: [],
    rule: {
      v2: `{
  "kind": "settle.gate",
  "require": {
    "receipt.hash.matches_attestation": true,
    "block_window": 3
  },
  "on_fail": "hard_stop"
}`,
      v1: `{
  "kind": "settle.gate",
  "require": { "receipt.hash.matches_attestation": true }
}`,
    },
    approvals: [
      approved("fd2e", "2026-02-28 13:05 UTC", "0x91a0…5501"),
      approved("3e42", "2026-02-28 13:11 UTC", "0x5f24…c8b2"),
      approved("9a13", "2026-02-28 13:14 UTC", "0x1d4e…9a8e"),
    ],
    history: [
      { rev: 2, author: "3e42", at: "2026-02-28", summary: "Block window = 3 to tolerate re-orgs.", active: true },
      { rev: 1, author: "fd2e", at: "2025-10-10", summary: "Initial — receipt hash must match.", active: false },
    ],
  },
  {
    id: "p-06",
    tag: "xcm/relay-allowlist@v6",
    scope: "xcm",
    scopeLabel: "XCM",
    severity: "hard-stop",
    signersReq: 3,
    signersTotal: 3,
    signerKeys: ["fd2e", "9a13", "c8f1"],
    activeSince: "2025-07-04",
    lastChange: {
      text: "Added AssetHub (1000) and Bridge Hub (1002); removed deprecated parachain 2034",
      author: "c8f1",
      at: "2026-04-11 07:58 UTC",
    },
    state: "Active",
    revision: 6,
    rooms: ["xcm/outbound/*"],
    handler: "verifier/xcm_allowlist.ts",
    gates: "Outbound XCM messages may only target parachains on the allowlist.",
    attachedJobs: [{ id: "run-2726", title: "xcm → AssetHub (1000) · 48 DOT", at: "11:15 UTC" }],
    rule: {
      v6: `{
  "kind": "xcm.gate",
  "require": {
    "dest.paraId.in": [1000, 1002, 2004, 2030],
    "fee.cap_dot": 2,
    "weight.cap": "5_000_000_000"
  },
  "deny": { "reserveAssetDeposited.unknownAsset": true },
  "on_fail": "hard_stop"
}`,
      v5: `{
  "kind": "xcm.gate",
  "require": {
    "dest.paraId.in": [1000, 2004, 2030, 2034],
    "fee.cap_dot": 2
  },
  "on_fail": "hard_stop"
}`,
      v4: `{
  "kind": "xcm.gate",
  "require": {
    "dest.paraId.in": [1000, 2004, 2034],
    "fee.cap_dot": 5
  }
}`,
      v3: `{
  "kind": "xcm.gate",
  "require": { "dest.paraId.in": [1000, 2034] }
}`,
      v2: `{ "kind": "xcm.gate", "require": { "dest.paraId.in": [1000] } }`,
      v1: `{ "kind": "xcm.gate", "require": { "dest.allowlist": true } }`,
    },
    approvals: [
      approved("fd2e", "2026-04-11 07:58 UTC", "0xfe19…0a2b"),
      approved("9a13", "2026-04-11 08:01 UTC", "0xac87…d0f4"),
      approved("c8f1", "2026-04-11 08:14 UTC", "0x2240…9e16"),
    ],
    history: [
      { rev: 6, author: "c8f1", at: "2026-04-11", summary: "+ AssetHub, Bridge Hub; − 2034 deprecation; weight cap introduced.", active: true },
      { rev: 5, author: "fd2e", at: "2026-01-28", summary: "Fee cap lowered 5 → 2 DOT.", active: false },
      { rev: 4, author: "fd2e", at: "2025-11-30", summary: "Add 2030; introduce fee cap.", active: false },
      { rev: 3, author: "9a13", at: "2025-10-14", summary: "Add 2034.", active: false },
      { rev: 2, author: "fd2e", at: "2025-09-01", summary: "Reduce to AssetHub only.", active: false },
      { rev: 1, author: "fd2e", at: "2025-07-04", summary: "Initial — any allowlisted dest.", active: false },
    ],
  },
  {
    id: "p-07",
    tag: "xcm/fee-cap@v3",
    scope: "xcm",
    scopeLabel: "XCM",
    severity: "gating",
    signersReq: 2,
    signersTotal: 3,
    signerKeys: ["fd2e", "b70c", "9a13"],
    activeSince: "2025-11-11",
    lastChange: {
      text: "Cap lowered from 5 → 2 DOT per message",
      author: "b70c",
      at: "2026-01-28 10:30 UTC",
    },
    state: "Active",
    revision: 3,
    rooms: ["xcm/outbound/*"],
    handler: "verifier/xcm_fee_cap.ts",
    gates: "Per-message fee ceiling on outbound XCM (separate from treasury budget).",
    attachedJobs: [],
    rule: {
      v3: `{
  "kind": "xcm.gate",
  "require": { "fee.cap_dot": 2 },
  "on_fail": "gate"
}`,
      v2: `{ "kind": "xcm.gate", "require": { "fee.cap_dot": 5 } }`,
      v1: `{ "kind": "xcm.gate", "require": { "fee.cap_dot": 10 } }`,
    },
    approvals: [
      approved("fd2e", "2026-01-28 10:30 UTC", "0x6622…118e"),
      approved("b70c", "2026-01-28 10:33 UTC", "0xdd21…9073"),
      approved("9a13", "2026-01-28 10:40 UTC", "0x8a18…e502"),
    ],
    history: [
      { rev: 3, author: "b70c", at: "2026-01-28", summary: "Fee cap 5 → 2 DOT.", active: true },
      { rev: 2, author: "fd2e", at: "2025-12-10", summary: "Fee cap 10 → 5 DOT.", active: false },
      { rev: 1, author: "fd2e", at: "2025-11-11", summary: "Initial — 10 DOT cap.", active: false },
    ],
  },
  {
    id: "p-08",
    tag: "badge/mint-after-3-passes@v2",
    scope: "badge",
    scopeLabel: "Badge",
    severity: "gating",
    signersReq: 2,
    signersTotal: 3,
    signerKeys: ["fd2e", "c8f1", "5d09"],
    activeSince: "2025-09-20",
    lastChange: {
      text: "Pass count raised from 3 → 5 for coding-1",
      author: "c8f1",
      at: "2026-04-17 14:20 UTC",
    },
    state: "Active",
    revision: 2,
    rooms: ["badges/coding-*", "badges/governance-*"],
    handler: "verifier/badge_mint_gate.ts",
    gates: "Badge mint requires N consecutive clean verifier passes.",
    attachedJobs: [{ id: "run-2737", title: "mint coding-1 → writer-gov-1", at: "13:40 UTC" }],
    rule: {
      v2: `{
  "kind": "badge.mint.gate",
  "require": {
    "consecutive_passes.min": 5,
    "window_days": 14,
    "no_open_disputes": true
  }
}`,
      v1: `{
  "kind": "badge.mint.gate",
  "require": { "consecutive_passes.min": 3 }
}`,
    },
    approvals: [
      approved("fd2e", "2026-04-17 14:20 UTC", "0x3c90…aa11"),
      approved("c8f1", "2026-04-17 14:25 UTC", "0x78e2…0c4b"),
      pending("5d09"),
    ],
    history: [
      { rev: 2, author: "c8f1", at: "2026-04-17", summary: "Consecutive passes 3 → 5, add 14-day window, require no open disputes.", active: true },
      { rev: 1, author: "fd2e", at: "2025-09-20", summary: "Initial — 3 consecutive clean passes.", active: false },
    ],
  },
  {
    id: "p-09",
    tag: "badge/revoke-on-dispute@v1",
    scope: "badge",
    scopeLabel: "Badge",
    severity: "hard-stop",
    signersReq: 2,
    signersTotal: 3,
    signerKeys: ["fd2e", "9a13", "c8f1"],
    activeSince: "2025-09-20",
    lastChange: { text: "Created", author: "fd2e", at: "2025-09-20 08:00 UTC" },
    state: "Active",
    revision: 1,
    rooms: ["badges/*"],
    handler: "verifier/badge_revoke.ts",
    gates: "Open dispute on a signed receipt auto-suspends any badges earned by that run.",
    attachedJobs: [{ id: "run-2739", title: "sig-mismatch on handoff — badge suspended", at: "14:02 UTC" }],
    rule: {
      v1: `{
  "kind": "badge.revoke.auto",
  "trigger": "dispute.opened",
  "action": "suspend",
  "reinstate_on": "dispute.resolved.ok"
}`,
    },
    approvals: [
      approved("fd2e", "2025-09-20 08:00 UTC", "0xf1b0…4498"),
      approved("9a13", "2025-09-20 08:02 UTC", "0x2205…13e0"),
      approved("c8f1", "2025-09-20 08:11 UTC", "0xa77b…55f1"),
    ],
    history: [
      { rev: 1, author: "fd2e", at: "2025-09-20", summary: "Initial — auto-suspend on dispute, reinstate on resolution.", active: true },
    ],
  },
  {
    id: "p-10",
    tag: "co-sign/quorum-2-of-3@v2",
    scope: "co-sign",
    scopeLabel: "Co-sign",
    severity: "gating",
    signersReq: 3,
    signersTotal: 3,
    signerKeys: ["fd2e", "9a13", "b70c"],
    activeSince: "2025-08-01",
    lastChange: {
      text: "Default quorum from 1-of-2 to 2-of-3",
      author: "fd2e",
      at: "2026-02-14 11:00 UTC",
    },
    state: "Active",
    revision: 2,
    rooms: ["*"],
    handler: "verifier/quorum.ts",
    gates: "Default co-sign threshold for sensitive receipts (settle, xcm, badge-mint).",
    attachedJobs: [],
    rule: {
      v2: `{
  "kind": "co_sign.default",
  "threshold": "2_of_3",
  "applies_to": ["settle", "xcm", "badge.mint", "policy.propose"]
}`,
      v1: `{
  "kind": "co_sign.default",
  "threshold": "1_of_2",
  "applies_to": ["settle"]
}`,
    },
    approvals: [
      approved("fd2e", "2026-02-14 11:00 UTC", "0x0044…887a"),
      approved("9a13", "2026-02-14 11:02 UTC", "0xa1cc…2920"),
      approved("b70c", "2026-02-14 11:05 UTC", "0x5dd3…0101"),
    ],
    history: [
      { rev: 2, author: "fd2e", at: "2026-02-14", summary: "Raise default quorum; extend applies-to list.", active: true },
      { rev: 1, author: "fd2e", at: "2025-08-01", summary: "Initial — 1-of-2 on settle only.", active: false },
    ],
  },
  {
    id: "p-11",
    tag: "worker/gas-separation@v1",
    scope: "worker",
    scopeLabel: "Worker",
    severity: "hard-stop",
    signersReq: 2,
    signersTotal: 3,
    signerKeys: ["fd2e", "b70c", "9a13"],
    activeSince: "2025-10-02",
    lastChange: { text: "Created", author: "b70c", at: "2025-10-02 09:14 UTC" },
    state: "Active",
    revision: 1,
    rooms: ["workers/*"],
    handler: "verifier/worker_gas.ts",
    gates: "Native gas wallet and in-app balance must stay separate; no cross-flow.",
    attachedJobs: [],
    rule: {
      v1: `{
  "kind": "worker.gate",
  "deny": {
    "cross_flow.app_balance_to_gas": true,
    "cross_flow.gas_to_app_balance": true
  },
  "on_fail": "hard_stop"
}`,
    },
    approvals: [
      approved("fd2e", "2025-10-02 09:14 UTC", "0x4a22…bb01"),
      approved("b70c", "2025-10-02 09:16 UTC", "0x99fe…12d4"),
      approved("9a13", "2025-10-02 09:22 UTC", "0x3300…5e7a"),
    ],
    history: [
      { rev: 1, author: "b70c", at: "2025-10-02", summary: "Initial — separate gas & app balance, hard stop on cross-flow.", active: true },
    ],
  },
  {
    id: "p-12",
    tag: "worker/claim-stake-min@v3",
    scope: "worker",
    scopeLabel: "Worker",
    severity: "gating",
    signersReq: 2,
    signersTotal: 3,
    signerKeys: ["fd2e", "b70c", "c8f1"],
    activeSince: "2025-10-14",
    lastChange: {
      text: "Minimum raised from 5 → 10 DOT",
      author: "b70c",
      at: "2026-03-22 15:30 UTC",
    },
    state: "Active",
    revision: 3,
    rooms: ["workers/*/claim"],
    handler: "verifier/claim_stake.ts",
    gates: "Worker must have the required DOT deposited in AgentAccountCore before a claim is accepted.",
    attachedJobs: [{ id: "run-2732", title: "stake top-up · coding-hand-1", at: "12:02 UTC" }],
    rule: {
      v3: `{
  "kind": "worker.gate",
  "require": { "claim_stake.min_dot": 10 },
  "source": "AgentAccountCore"
}`,
      v2: `{ "kind": "worker.gate", "require": { "claim_stake.min_dot": 5 } }`,
      v1: `{ "kind": "worker.gate", "require": { "claim_stake.min_dot": 1 } }`,
    },
    approvals: [
      approved("fd2e", "2026-03-22 15:30 UTC", "0x7711…aa09"),
      approved("b70c", "2026-03-22 15:33 UTC", "0xba45…0c0c"),
      pending("c8f1"),
    ],
    history: [
      { rev: 3, author: "b70c", at: "2026-03-22", summary: "Stake minimum 5 → 10 DOT.", active: true },
      { rev: 2, author: "fd2e", at: "2025-12-01", summary: "Stake minimum 1 → 5 DOT.", active: false },
      { rev: 1, author: "fd2e", at: "2025-10-14", summary: "Initial — 1 DOT minimum stake.", active: false },
    ],
  },
  {
    id: "p-13",
    tag: "treasury/daily-outflow-cap@v4",
    scope: "treasury",
    scopeLabel: "Treasury",
    severity: "hard-stop",
    signersReq: 3,
    signersTotal: 3,
    signerKeys: ["fd2e", "b70c", "c8f1"],
    activeSince: "2025-09-02",
    lastChange: {
      text: "Daily cap 1,000 → 750 DOT after Q1 review",
      author: "b70c",
      at: "2026-04-02 09:00 UTC",
    },
    state: "Active",
    revision: 4,
    rooms: ["treasury/outflows"],
    handler: "verifier/treasury_cap.ts",
    gates: "Rolling 24-hour outflow ceiling from treasury vaults.",
    attachedJobs: [],
    rule: {
      v4: `{
  "kind": "treasury.gate",
  "require": {
    "window_hours": 24,
    "outflow.cap_dot": 750
  },
  "on_fail": "hard_stop"
}`,
      v3: `{
  "kind": "treasury.gate",
  "require": {
    "window_hours": 24,
    "outflow.cap_dot": 1000
  }
}`,
      v2: `{ "kind": "treasury.gate", "require": { "outflow.cap_dot": 2000 } }`,
      v1: `{ "kind": "treasury.gate", "require": { "outflow.cap_dot": 5000 } }`,
    },
    approvals: [
      approved("fd2e", "2026-04-02 09:00 UTC", "0x2a11…f8b0"),
      approved("b70c", "2026-04-02 09:04 UTC", "0x0e55…aa21"),
      approved("c8f1", "2026-04-02 09:22 UTC", "0xffee…1010"),
    ],
    history: [
      { rev: 4, author: "b70c", at: "2026-04-02", summary: "Daily cap 1000 → 750 DOT.", active: true },
      { rev: 3, author: "b70c", at: "2026-01-14", summary: "Add 24h window; cap 2000 → 1000 DOT.", active: false },
      { rev: 2, author: "fd2e", at: "2025-11-01", summary: "Cap 5000 → 2000 DOT.", active: false },
      { rev: 1, author: "fd2e", at: "2025-09-02", summary: "Initial — 5000 DOT cap.", active: false },
    ],
  },
  {
    id: "p-14",
    tag: "treasury/reserve-floor@v2",
    scope: "treasury",
    scopeLabel: "Treasury",
    severity: "hard-stop",
    signersReq: 3,
    signersTotal: 3,
    signerKeys: ["fd2e", "b70c", "c8f1"],
    activeSince: "2025-10-28",
    lastChange: {
      text: "Floor raised to 8% of rolling 30d payouts",
      author: "b70c",
      at: "2026-03-30 10:12 UTC",
    },
    state: "Active",
    revision: 2,
    rooms: ["treasury/*"],
    handler: "verifier/treasury_reserve.ts",
    gates: "Reserve must stay above a percentage of rolling 30-day payouts.",
    attachedJobs: [],
    rule: {
      v2: `{
  "kind": "treasury.gate",
  "require": { "reserve.floor_pct_of_30d": 8 },
  "on_fail": "hard_stop"
}`,
      v1: `{ "kind": "treasury.gate", "require": { "reserve.floor_pct_of_30d": 5 } }`,
    },
    approvals: [
      approved("fd2e", "2026-03-30 10:12 UTC", "0x8800…4411"),
      approved("b70c", "2026-03-30 10:14 UTC", "0xbbcc…aa22"),
      approved("c8f1", "2026-03-30 10:30 UTC", "0xd1d0…e5ee"),
    ],
    history: [
      { rev: 2, author: "b70c", at: "2026-03-30", summary: "Reserve floor 5% → 8% of 30d payouts.", active: true },
      { rev: 1, author: "fd2e", at: "2025-10-28", summary: "Initial — 5% floor.", active: false },
    ],
  },
  {
    id: "p-15",
    tag: "xcm/bridge-hub-allow@v1",
    scope: "xcm",
    scopeLabel: "XCM",
    severity: "gating",
    signersReq: 3,
    signersTotal: 3,
    signerKeys: ["fd2e", "9a13", "c8f1"],
    activeSince: null,
    lastChange: {
      text: "Proposed — awaiting 2 more signers",
      author: "c8f1",
      at: "2026-04-23 18:20 UTC",
    },
    state: "Pending",
    revision: 1,
    rooms: ["xcm/outbound/bridge-hub"],
    handler: "verifier/xcm_bridge_hub.ts",
    gates: "New: Route messages via Bridge Hub (1002) for Kusama/Ethereum destinations.",
    attachedJobs: [],
    rule: {
      v1: `{
  "kind": "xcm.gate",
  "proposed": true,
  "require": {
    "dest.paraId": 1002,
    "hop.allow": ["kusama-bridge", "ethereum-bridge"],
    "fee.cap_dot": 3
  }
}`,
    },
    approvals: [
      approved("c8f1", "2026-04-23 18:20 UTC", "0xaaa0…1177"),
      pending("fd2e"),
      pending("9a13"),
    ],
    history: [
      { rev: 1, author: "c8f1", at: "2026-04-23", summary: "Proposed — open Bridge Hub route.", active: true },
    ],
  },
  {
    id: "p-16",
    tag: "settle/manual-floor-raise@v1",
    scope: "settle",
    scopeLabel: "Settle",
    severity: "gating",
    signersReq: 3,
    signersTotal: 3,
    signerKeys: ["fd2e", "9a13", "b70c"],
    activeSince: null,
    lastChange: {
      text: "Proposed — awaiting 1 more signer",
      author: "b70c",
      at: "2026-04-24 06:44 UTC",
    },
    state: "Pending",
    revision: 1,
    rooms: ["runs/*/settle"],
    handler: "verifier/settle_floor.ts",
    gates: "Lower the manual-review trigger from 500 DOT to 250 DOT.",
    attachedJobs: [],
    rule: {
      v1: `{
  "kind": "settle.gate",
  "proposed": true,
  "require": { "manual_review.over_dot": 250 },
  "on_fail": "gate"
}`,
    },
    approvals: [
      approved("b70c", "2026-04-24 06:44 UTC", "0x1234…5678"),
      approved("fd2e", "2026-04-24 06:49 UTC", "0x7e11…90cc"),
      pending("9a13"),
    ],
    history: [
      { rev: 1, author: "b70c", at: "2026-04-24", summary: "Proposed — lower manual-review floor.", active: true },
    ],
  },
  {
    id: "p-17",
    tag: "badge/governance-2-criteria@v1",
    scope: "badge",
    scopeLabel: "Badge",
    severity: "advisory",
    signersReq: 2,
    signersTotal: 3,
    signerKeys: ["fd2e", "c8f1", "5d09"],
    activeSince: null,
    lastChange: {
      text: "Proposed — awaiting 2 more signers",
      author: "c8f1",
      at: "2026-04-22 14:50 UTC",
    },
    state: "Pending",
    revision: 1,
    rooms: ["badges/governance-2"],
    handler: "verifier/badge_gov2.ts",
    gates: "Criteria to mint governance-2 badge (tier-2 governance trust).",
    attachedJobs: [],
    rule: {
      v1: `{
  "kind": "badge.mint.gate",
  "proposed": true,
  "require": {
    "clean_passes.min": 20,
    "dispute_rate.max_pct": 1.0,
    "co_sign_history.min": 10
  }
}`,
    },
    approvals: [
      approved("c8f1", "2026-04-22 14:50 UTC", "0xccee…2299"),
      pending("fd2e"),
      pending("5d09"),
    ],
    history: [
      { rev: 1, author: "c8f1", at: "2026-04-22", summary: "Proposed — governance-2 mint criteria.", active: true },
    ],
  },
  {
    id: "p-18",
    tag: "claim/reviewer-tenure@v1",
    scope: "claim",
    scopeLabel: "Claim",
    severity: "advisory",
    signersReq: 2,
    signersTotal: 3,
    signerKeys: ["fd2e", "9a13", "c8f1"],
    activeSince: null,
    lastChange: {
      text: "Draft — never proposed",
      author: "fd2e",
      at: "2026-04-10 16:12 UTC",
    },
    state: "Draft",
    revision: 1,
    rooms: ["runs/*/review"],
    handler: "verifier/reviewer_tenure.ts",
    gates: "(Draft) Reviewer agents must hold coding-1 for ≥ 30 days before counting toward verification.",
    attachedJobs: [],
    rule: {
      v1: `{
  "kind": "claim.gate",
  "draft": true,
  "require": { "reviewer.badge.coding-1.age_days": 30 }
}`,
    },
    approvals: [pending("fd2e"), pending("9a13"), pending("c8f1")],
    history: [{ rev: 1, author: "fd2e", at: "2026-04-10", summary: "Draft — reviewer tenure requirement.", active: true }],
  },
  {
    id: "p-19",
    tag: "treasury/monthly-report@v1",
    scope: "treasury",
    scopeLabel: "Treasury",
    severity: "advisory",
    signersReq: 2,
    signersTotal: 3,
    signerKeys: ["fd2e", "b70c", "5d09"],
    activeSince: null,
    lastChange: {
      text: "Draft — data source wiring pending",
      author: "b70c",
      at: "2026-04-20 11:33 UTC",
    },
    state: "Draft",
    revision: 1,
    rooms: ["treasury/*"],
    handler: "verifier/treasury_report.ts",
    gates: "(Draft) Monthly outflow report must be published to the public log on the 1st.",
    attachedJobs: [],
    rule: {
      v1: `{
  "kind": "treasury.advisory",
  "draft": true,
  "publish": {
    "cadence": "monthly",
    "on_day": 1,
    "channel": "public_log"
  }
}`,
    },
    approvals: [pending("fd2e"), pending("b70c"), pending("5d09")],
    history: [{ rev: 1, author: "b70c", at: "2026-04-20", summary: "Draft — monthly report cadence.", active: true }],
  },
  {
    id: "p-20",
    tag: "xcm/teleport-only@v1",
    scope: "xcm",
    scopeLabel: "XCM",
    severity: "hard-stop",
    signersReq: 3,
    signersTotal: 3,
    signerKeys: ["fd2e", "9a13", "c8f1"],
    activeSince: "2025-07-04",
    lastChange: {
      text: "Retired — superseded by xcm/relay-allowlist@v4+",
      author: "fd2e",
      at: "2025-11-30 17:00 UTC",
    },
    state: "Retired",
    revision: 1,
    rooms: ["xcm/outbound/*"],
    handler: "verifier/xcm_teleport.ts",
    gates: "(Retired) Only teleport-type messages permitted on outbound XCM.",
    attachedJobs: [],
    rule: {
      v1: `{
  "kind": "xcm.gate",
  "retired": true,
  "require": { "instruction.type": "TeleportAsset" }
}`,
    },
    approvals: [
      approved("fd2e", "2025-11-30 17:00 UTC", "0xffff…eeee"),
      approved("9a13", "2025-11-30 17:02 UTC", "0xdddd…cccc"),
      approved("c8f1", "2025-11-30 17:08 UTC", "0xbbbb…aaaa"),
    ],
    history: [{ rev: 1, author: "fd2e", at: "2025-07-04", summary: "Initial — teleport-only gate. Retired 2025-11-30.", active: true }],
  },
  {
    id: "p-21",
    tag: "claim/manual-review-all@v1",
    scope: "claim",
    scopeLabel: "Claim",
    severity: "gating",
    signersReq: 2,
    signersTotal: 3,
    signerKeys: ["fd2e", "9a13", "3e42"],
    activeSince: "2025-06-10",
    lastChange: {
      text: "Retired — replaced by scoped auto-claim policies",
      author: "fd2e",
      at: "2025-10-01 09:00 UTC",
    },
    state: "Retired",
    revision: 1,
    rooms: ["runs/*"],
    handler: "verifier/manual_review.ts",
    gates: "(Retired) Every claim requires manual review — used during initial rollout.",
    attachedJobs: [],
    rule: {
      v1: `{
  "kind": "claim.gate",
  "retired": true,
  "require": { "manual_review": true }
}`,
    },
    approvals: [
      approved("fd2e", "2025-10-01 09:00 UTC", "0xa1a1…b2b2"),
      approved("9a13", "2025-10-01 09:01 UTC", "0xc3c3…d4d4"),
      approved("3e42", "2025-10-01 09:05 UTC", "0xe5e5…f6f6"),
    ],
    history: [{ rev: 1, author: "fd2e", at: "2025-06-10", summary: "Initial — manual review all. Retired 2025-10-01.", active: true }],
  },
  {
    id: "p-22",
    tag: "co-sign/policy-change-quorum@v2",
    scope: "co-sign",
    scopeLabel: "Co-sign",
    severity: "hard-stop",
    signersReq: 3,
    signersTotal: 3,
    signerKeys: ["fd2e", "9a13", "c8f1"],
    activeSince: "2025-09-08",
    lastChange: {
      text: "All hard-stop policy changes now require unanimous co-sign",
      author: "c8f1",
      at: "2026-03-05 12:40 UTC",
    },
    state: "Active",
    revision: 2,
    rooms: ["governance/policies/*"],
    handler: "verifier/policy_change_quorum.ts",
    gates: "Governance-level: any change to a hard-stop policy needs unanimous signer approval.",
    attachedJobs: [],
    rule: {
      v2: `{
  "kind": "co_sign.governance",
  "target": "policy.change",
  "when": { "target.severity": "hard-stop" },
  "threshold": "unanimous",
  "on_fail": "hard_stop"
}`,
      v1: `{
  "kind": "co_sign.governance",
  "target": "policy.change",
  "threshold": "2_of_3"
}`,
    },
    approvals: [
      approved("fd2e", "2026-03-05 12:40 UTC", "0x1919…aaff"),
      approved("9a13", "2026-03-05 12:44 UTC", "0x2828…bbee"),
      approved("c8f1", "2026-03-05 13:02 UTC", "0x3737…ccdd"),
    ],
    history: [
      { rev: 2, author: "c8f1", at: "2026-03-05", summary: "Hard-stop changes now require unanimous sign.", active: true },
      { rev: 1, author: "fd2e", at: "2025-09-08", summary: "Initial — 2-of-3 for all policy changes.", active: false },
    ],
  },
];

export const SPARK_30D = [
  0, 0, 1, 0, 2, 0, 1, 0, 0, 3, 1, 0, 0, 1, 0, 2, 0, 0, 1, 0, 0, 4, 1, 0, 0, 2, 0, 1, 0, 1,
];
