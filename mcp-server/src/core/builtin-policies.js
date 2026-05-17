/**
 * Built-in policy seed data — Package G (P2.5b).
 *
 * Previously these policies + their helper constructors lived inline in
 * `mcp-server/src/protocols/http/server.js` as route-local constants.
 * Package G's close output requires that built-in policies become seed
 * data loaded into a service at startup, so the seed set lives here
 * and `PolicyService` consumes it.
 *
 * Operator-proposed policies are NOT in this file — they land in
 * `PolicyService.cache` and are mirrored out to the state-store. See
 * `policy-service.js`.
 *
 * Re-exported helpers (`OPERATOR_SIGNERS`, `signerApproval`,
 * `makePolicy`) are public because `buildPolicyProposal` in `server.js`
 * still uses them to shape an HTTP-payload-driven proposal record. They
 * are intentionally pure functions of their inputs; the only impure
 * piece is the env-driven default addresses in `OPERATOR_SIGNERS`.
 */

export const OPERATOR_SIGNERS = {
  fd2e: {
    role: "primary operator",
    addr: process.env.DEFAULT_POSTER_ADDRESS ?? "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    initials: "FD",
    hue: 148
  },
  "9a13": {
    role: "co-signer",
    addr: process.env.DEFAULT_VERIFIER_ADDRESS ?? "0x9A13C20000000000000000000000000000000CB2",
    initials: "9A",
    hue: 214
  },
  "3e42": {
    role: "verifier",
    addr: process.env.DEFAULT_VERIFIER_ADDRESS ?? "0x3E420000000000000000000000000000000008D1",
    initials: "V2",
    hue: 196
  }
};

export function signerApproval(key, state = "signed", at = "2026-04-24 14:08 UTC") {
  const signer = OPERATOR_SIGNERS[key] ?? OPERATOR_SIGNERS.fd2e;
  return {
    key,
    ...signer,
    state,
    ...(state === "signed" ? { at, sig: `0x${key}...signed` } : {})
  };
}

export function makePolicy({
  id,
  tag,
  scope,
  scopeLabel,
  severity,
  state,
  revision,
  handler,
  gates,
  rooms,
  activeSince,
  lastChange,
  rule,
  attachedJobs = [],
  signerKeys = ["fd2e", "9a13", "3e42"],
  signersReq = 2
}) {
  return {
    id,
    tag,
    scope,
    scopeLabel,
    severity,
    signersReq,
    signersTotal: signerKeys.length,
    signerKeys,
    activeSince,
    lastChange,
    state,
    revision,
    rooms,
    handler,
    gates,
    attachedJobs,
    rule,
    approvals: signerKeys.map((key, index) => signerApproval(key, index < signersReq ? "signed" : "pending")),
    history: [
      {
        rev: revision,
        author: lastChange.author,
        at: String(lastChange.at ?? "").slice(0, 10),
        summary: lastChange.text,
        active: true
      }
    ]
  };
}

export const BUILTIN_POLICIES = [
  makePolicy({
    id: "p-claim-deps-sec-only",
    tag: "claim/deps-sec-only@v4",
    scope: "claim",
    scopeLabel: "Claim",
    severity: "gating",
    state: "Active",
    revision: 4,
    activeSince: "2026-03-11",
    handler: "verifier/deps_sec_only.ts",
    gates: "Auto-claim on dependency bumps where only security advisories changed.",
    rooms: ["runs/coding/*", "runs/deps-bump/*"],
    attachedJobs: [{ id: "starter-coding-001", title: "Starter coding verification", at: "live" }],
    lastChange: {
      text: "Raised max-cvss ceiling to 7.5 for staged dependency work.",
      author: "fd2e",
      at: "2026-04-24 14:08 UTC"
    },
    rule: {
      v4: JSON.stringify({
        kind: "claim.auto",
        scope: "deps-bump",
        require: { advisory_type: "security", semver_delta: ["patch", "minor"], max_cvss: 7.5 },
        deny: { lockfile_drift: true, transitive_majors: true },
        receipt: { co_sign: ["verifier_handler"], attach_cvss_trail: true }
      }, null, 2)
    }
  }),
  makePolicy({
    id: "p-settle-receipt-before-payout",
    tag: "settle/receipt-before-payout@v1",
    scope: "settle",
    scopeLabel: "Settle",
    severity: "hard-stop",
    state: "Active",
    revision: 1,
    activeSince: "2026-04-17",
    handler: "settlement/receipt_gate.ts",
    gates: "Release stake and reward only after verifier receipt exists.",
    rooms: ["sessions/*", "treasury/settlement/*"],
    lastChange: {
      text: "Initial settlement gate for operator launch.",
      author: "9a13",
      at: "2026-04-24 14:08 UTC"
    },
    rule: {
      v1: JSON.stringify({
        kind: "settle.gate",
        require: { receipt_signed: true, verifier_result: "approved" },
        deny: { open_dispute: true }
      }, null, 2)
    }
  }),
  makePolicy({
    id: "p-dispute-human-review",
    tag: "dispute/human-review-window@v1",
    scope: "co-sign",
    scopeLabel: "Co-sign",
    severity: "gating",
    state: "Active",
    revision: 1,
    activeSince: "2026-04-17",
    handler: "disputes/human_review.ts",
    gates: "Disputed sessions hold stake until a verifier verdict is recorded.",
    rooms: ["disputes/*"],
    lastChange: {
      text: "Set 72 hour review window before stake release.",
      author: "3e42",
      at: "2026-04-24 14:08 UTC"
    },
    rule: {
      v1: JSON.stringify({
        kind: "dispute.review",
        window_hours: 72,
        verdicts: ["upheld", "dismissed", "split"],
        release_requires: ["verdict", "operator"]
      }, null, 2)
    }
  })
];
