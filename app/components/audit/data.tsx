import type { AuditEvent } from "./types";

const FD = {
  handle: "operator-primary",
  address: "0xFd2E…6519",
  initials: "FD",
  tone: "sage",
} as const;
const NINEA = {
  handle: "operator-co-sign",
  address: "0x9A13…0cb2",
  initials: "9A",
  tone: "ink",
} as const;
const B70 = {
  handle: "treasury-lead",
  address: "0xB70c…4c7a",
  initials: "B7",
  tone: "clay",
} as const;
const VERIFIER = {
  handle: "verifier-2",
  address: "0x3E42…08d1",
  initials: "V2",
  tone: "blue",
} as const;
const C8 = {
  handle: "governance-council",
  address: "0xC8F1…ae51",
  initials: "C8",
  tone: "muted",
} as const;
const SYSTEM = {
  handle: "system",
  address: "averray.platform",
  initials: "··",
  tone: "muted",
} as const;
const CHAIN = {
  handle: "AgentAccountCore",
  address: "asset-hub · 0xaa11…",
  initials: "⧉",
  tone: "blue",
} as const;

// TODO(data): wire to useApi("/audit") once backend emits a stable
// event shape. Every entry below is synthetic but mirrors the SSE
// topic names the events.js stream already carries.

export const AUDIT_EVENTS: AuditEvent[] = [
  {
    id: "ev-osv-01",
    at: "14:09:52",
    day: "today",
    source: "operator",
    category: "verifier",
    action: "receipt.signed",
    actor: FD,
    summary: (
      <>
        Signed receipt <b>r_4e145</b> for OSV remediation run-2751 ·
        npm/minimist <b>1.2.5 → 1.2.6</b> (GHSA-vh95-rmgr-6w4m).
      </>
    ),
    target: "r_4e145",
    hash: "0x4f12…aa83",
    tone: "accent",
    link: { label: "Open receipt →", href: "/receipts" },
  },
  {
    id: "ev-datagov-01",
    at: "14:09:21",
    day: "today",
    source: "operator",
    category: "verifier",
    action: "receipt.signed",
    actor: FD,
    summary: (
      <>
        Signed receipt <b>r_4e144</b> for Data.gov audit run-2752 · GSA{" "}
        <b>Federal sample spending data</b> (CSV).
      </>
    ),
    target: "r_4e144",
    hash: "0x9b04…42c1",
    tone: "accent",
    link: { label: "Open receipt →", href: "/receipts" },
  },
  {
    id: "ev-01",
    at: "14:08:42",
    day: "today",
    source: "operator",
    category: "verifier",
    action: "receipt.signed",
    actor: FD,
    summary: (
      <>
        Signed receipt <b>r_4e12a</b> for run-2742 (writer-gov/cited@v3).
      </>
    ),
    target: "r_4e12a",
    hash: "0x7a0c…b11e",
    tone: "accent",
    link: { label: "Open receipt →", href: "/receipts" },
  },
  {
    id: "ev-02",
    at: "14:08:14",
    day: "today",
    source: "system",
    category: "runs",
    action: "session.submitted",
    actor: SYSTEM,
    summary: (
      <>
        Evidence submitted on <b>run-2742</b> · schema writer-gov v3 · 412B payload.
      </>
    ),
    target: "run-2742",
    link: { label: "Open run →", href: "/runs" },
  },
  {
    id: "ev-03",
    at: "14:07:41",
    day: "today",
    source: "contract",
    category: "xcm",
    action: "xcm.send",
    actor: CHAIN,
    summary: (
      <>
        XCM dispatched to <b>acala</b> · 62,000 DOT · block #24,918,425.
      </>
    ),
    hash: "0x99e2…14af",
    link: { label: "Treasury →", href: "/treasury" },
  },
  {
    id: "ev-04",
    at: "14:06:18",
    day: "today",
    source: "contract",
    category: "xcm",
    action: "xcm.received",
    actor: CHAIN,
    summary: (
      <>
        80,000 DOT received from <b>hydra-dx</b> · relay receipt r_8c0a.
      </>
    ),
    hash: "0x88e1…22b0",
    link: { label: "Treasury →", href: "/treasury" },
  },
  {
    id: "ev-05",
    at: "14:02:14",
    day: "today",
    source: "contract",
    category: "dispute",
    action: "stake.frozen",
    actor: CHAIN,
    summary: (
      <>
        45 DOT frozen in dispute-escrow for <b>run-2739</b> (signature mismatch).
      </>
    ),
    target: "d_4e10c",
    hash: "0xe811…0042",
    tone: "warn",
    link: { label: "Open dispute →", href: "/disputes" },
  },
  {
    id: "ev-06",
    at: "14:02:09",
    day: "today",
    source: "operator",
    category: "dispute",
    action: "dispute.opened",
    actor: VERIFIER,
    summary: (
      <>
        verifier-2 opened dispute <b>d_4e10c</b> on run-2739 — payload
        signature alg mismatch.
      </>
    ),
    target: "d_4e10c",
    tone: "warn",
    link: { label: "Open dispute →", href: "/disputes" },
  },
  {
    id: "ev-07",
    at: "13:58:02",
    day: "today",
    source: "contract",
    category: "treasury",
    action: "settle.finalized",
    actor: CHAIN,
    summary: (
      <>
        Settled <b>18.00 DOT</b> across worker/verifier/treasury for run-2738.
      </>
    ),
    target: "run-2738",
    hash: "0xbd9a…010c",
    tone: "accent",
    link: { label: "Open session →", href: "/sessions" },
  },
  {
    id: "ev-08",
    at: "13:27:19",
    day: "today",
    source: "operator",
    category: "policy",
    action: "policy.change.signed",
    actor: NINEA,
    summary: (
      <>
        Co-signed proposal <b>writer-gov/cited@v4</b> (citation density 2/300w).
      </>
    ),
    target: "writer-gov/cited@v4",
    hash: "0xaa3c…91d0",
    link: { label: "Open policy →", href: "/policies" },
  },
  {
    id: "ev-09",
    at: "12:42:15",
    day: "today",
    source: "contract",
    category: "runs",
    action: "stake.locked",
    actor: CHAIN,
    summary: (
      <>
        coding-hand-3 locked <b>5.00 DOT</b> claim stake for run-2739.
      </>
    ),
    hash: "0xb10c…4422",
    link: { label: "Open run →", href: "/runs" },
  },
  {
    id: "ev-10",
    at: "11:27:38",
    day: "today",
    source: "operator",
    category: "auth",
    action: "siwe.login",
    actor: FD,
    summary: <>operator-primary signed in via SIWE (session 4h TTL).</>,
  },
  {
    id: "ev-11",
    at: "11:04:12",
    day: "today",
    source: "operator",
    category: "policy",
    action: "policy.revision.proposed",
    actor: FD,
    summary: (
      <>
        Proposed <b>claim/deps-sec-only@v5</b> — raised max-cvss to 8.0.
        Awaiting 2 signers.
      </>
    ),
    target: "claim/deps-sec-only@v5",
    link: { label: "Open policy →", href: "/policies" },
  },
  {
    id: "ev-12",
    at: "09:50:03",
    day: "today",
    source: "system",
    category: "runs",
    action: "session.claimed",
    actor: SYSTEM,
    summary: (
      <>
        writer-gov-1 claimed <b>run-2744</b> (docs refresh v3.2).
      </>
    ),
    target: "run-2744",
    link: { label: "Open run →", href: "/runs" },
  },
  {
    id: "ev-13",
    at: "09:29:09",
    day: "today",
    source: "operator",
    category: "treasury",
    action: "treasury.allocate",
    actor: B70,
    summary: (
      <>
        Allocated <b>80,000 DOT</b> from treasury to bifrost vDOT lane.
      </>
    ),
    hash: "0x4410…29bf",
    tone: "accent",
    link: { label: "Treasury →", href: "/treasury" },
  },
  {
    id: "ev-14",
    at: "08:17:02",
    day: "today",
    source: "contract",
    category: "badge",
    action: "badge.minted",
    actor: CHAIN,
    summary: (
      <>
        <b>coding-1</b> minted to coding-hand-1 (tier-2 qualification).
      </>
    ),
    target: "coding-1",
    hash: "0x0c4b…aa11",
    link: { label: "Open agent →", href: "/agents" },
  },
  {
    id: "ev-15",
    at: "22:44:52",
    day: "yesterday",
    source: "system",
    category: "verifier",
    action: "verifier.checks.passing",
    actor: SYSTEM,
    summary: <>5/5 checks passed on run-2735 · coding/lint-strict@v2.</>,
    target: "run-2735",
  },
  {
    id: "ev-16",
    at: "19:12:04",
    day: "yesterday",
    source: "operator",
    category: "policy",
    action: "policy.retired",
    actor: C8,
    summary: (
      <>
        Retired <b>xcm/teleport-only@v1</b> — superseded by
        xcm/relay-allowlist@v6.
      </>
    ),
    target: "xcm/teleport-only@v1",
    link: { label: "Open policy →", href: "/policies" },
  },
  {
    id: "ev-17",
    at: "14:50:21",
    day: "yesterday",
    source: "contract",
    category: "treasury",
    action: "settle.rejected",
    actor: CHAIN,
    summary: (
      <>
        Settlement rejected on <b>run-2705</b> · receipt hash mismatch.
        58 DOT returned to treasury.
      </>
    ),
    target: "run-2705",
    hash: "0xaf20…1188",
    tone: "warn",
    link: { label: "Open session →", href: "/sessions" },
  },
  {
    id: "ev-18",
    at: "10:22:04",
    day: "2026-04-22",
    source: "operator",
    category: "dispute",
    action: "dispute.upheld",
    actor: FD,
    summary: (
      <>
        Upheld dispute <b>d_4df10</b> on run-2711. 7.00 DOT slashed to
        treasury per writer-gov/cited@v3.
      </>
    ),
    target: "d_4df10",
    hash: "0x8834…2277",
    tone: "bad",
    link: { label: "Open dispute →", href: "/disputes" },
  },
  {
    id: "ev-19",
    at: "10:22:04",
    day: "2026-04-22",
    source: "contract",
    category: "badge",
    action: "badge.suspended",
    actor: CHAIN,
    summary: (
      <>
        writer-gov-2's <b>writer-1</b> badge auto-suspended per
        badge/revoke-on-dispute@v1.
      </>
    ),
    target: "writer-1",
    hash: "0xdd33…4411",
    tone: "bad",
  },
  {
    id: "ev-20",
    at: "10:06:18",
    day: "2026-04-22",
    source: "operator",
    category: "dispute",
    action: "dispute.opened",
    actor: {
      handle: "gov-review-2",
      address: "0x9A130C…b2f1",
      initials: "G2",
      tone: "muted",
    },
    summary: (
      <>
        gov-review-2 opened dispute <b>d_4df10</b> on run-2711 — writer
        cited external link.
      </>
    ),
    target: "d_4df10",
    tone: "warn",
    link: { label: "Open dispute →", href: "/disputes" },
  },
];
