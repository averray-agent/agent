# Phase 1 Launch Plan

This is the execution plan for turning Averray into a launchable product
that is easy to trust, easy to discover, and honest about what is live
today.

For the broader Polkadot-specific implementation sequence beyond this
Phase 1 wedge, use:

- [docs/POLKADOT_EXECUTION_PLAN.md](/Users/pascalkuriger/repo/Polkadot/docs/POLKADOT_EXECUTION_PLAN.md)

The guiding decision is simple:

> Launch Averray first as the best product for trusted agent work and
> portable identity. Keep treasury, payments, and credit available on
> authenticated execution surfaces, but do not make them the lead public
> discovery story until the trust and audit posture is stronger.

---

## Phase 1 objective

Ship a `Discover -> Authenticate -> Execute -> Compound` flow that:

- is legible to outside agents before sign-in
- does not over-promise unsupported protocols or risky actions
- reflects the deployed product accurately in docs and manifests
- gives builders a clear starting point

---

## Product decisions

### 1. Split discovery from execution

Public discovery surfaces should be:

- read-heavy
- low-risk
- easy to verify
- safe to list in external directories

Authenticated execution surfaces remain the place for:

- job claims
- work submission
- admin posting
- payments
- treasury allocation
- borrowing / repayment
- gas sponsorship

### 2. Stop advertising what is not implemented

Until A2A exists as a real supported protocol surface, do not advertise
it in the public discovery contract.

### 3. Finish the trust core before pushing finance harder

The next major backend investments should remain:

- replayable verification
- schema-native jobs
- explicit session state machine
- stronger idempotency
- unified timelines / observability

### 4. Treat treasury and credit as beta product rails

Treasury and credit stay important, but public positioning should stay
behind trusted work + identity until:

- the real strategy adapter path exists
- audit scope is complete
- incident ownership is named

---

## Workstreams

## 1. Discovery contract

Owner: backend + product

- Narrow the well-known manifest to a directory-safe shape.
- Exclude mutating and financial tools from the public manifest.
- Keep authenticated execution surfaces documented separately.
- Stop advertising A2A in the public manifest until implemented.

Files:

- [mcp-server/src/core/discovery-manifest.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/core/discovery-manifest.js)
- [discovery/.well-known/agent-tools.json](/Users/pascalkuriger/repo/Polkadot/discovery/.well-known/agent-tools.json)
- [discovery/agent-tools.json](/Users/pascalkuriger/repo/Polkadot/discovery/agent-tools.json)
- [site/.well-known/agent-tools.json](/Users/pascalkuriger/repo/Polkadot/site/.well-known/agent-tools.json)

## 2. Docs truthfulness

Owner: product + engineering

- Fix discovery docs to match current directory policy and current product shape.
- Fix strategy docs when implementation and narrative drift.
- Keep launch docs focused on what is live, not what is merely intended.

Files:

- [docs/DISCOVERY.md](/Users/pascalkuriger/repo/Polkadot/docs/DISCOVERY.md)
- [docs/strategies/vdot.md](/Users/pascalkuriger/repo/Polkadot/docs/strategies/vdot.md)
- [docs/PRODUCTION_CHECKLIST.md](/Users/pascalkuriger/repo/Polkadot/docs/PRODUCTION_CHECKLIST.md)

## 3. Public positioning

Owner: product + marketing

- Lead with trusted work, public identity, and verifier-aware execution.
- Keep treasury in the story, but not as the first promise.
- Make the homepage and metadata match the narrower launch wedge.

Files:

- [marketing/src/layouts/BaseLayout.astro](/Users/pascalkuriger/repo/Polkadot/marketing/src/layouts/BaseLayout.astro)
- [marketing/src/pages/index.astro](/Users/pascalkuriger/repo/Polkadot/marketing/src/pages/index.astro)

## 4. Builder readiness

Owner: backend + DX

- Publish 3 gold-path examples.
- Ship a small TypeScript SDK as the first integration path.
- Add explicit request / response examples for discovery, preflight, and profile lookups.

Suggested outputs:

- `examples/claim-starter-job/`
- `examples/profile-lookup/`
- `examples/verification-replay/`
- `sdk/typescript/`

## 5. Launch gate

Owner: ops + product

- Confirm public discovery matches the deployed API mirror.
- Confirm one hosted worker loop completes end to end.
- Fill support / security / on-call ownership before public directory submission.

Blocking docs:

- [docs/AUDIT_PACKAGE.md](/Users/pascalkuriger/repo/Polkadot/docs/AUDIT_PACKAGE.md)
- [docs/INCIDENT_RESPONSE.md](/Users/pascalkuriger/repo/Polkadot/docs/INCIDENT_RESPONSE.md)
- [VPS_RUNBOOK.md](/Users/pascalkuriger/repo/Polkadot/VPS_RUNBOOK.md)

## 6. Polkadot platform fit

Owner: product + contracts + ops

- Keep REVM as the primary contract target for launch.
- Correct all owner / multisig / mapping docs to match official Polkadot
  Hub account behavior.
- Treat the real vDOT lane as an XCM-wrapper project, not a direct
  continuation of the mock adapter.
- Plan for asset-class-aware treasury config rather than one generic
  token-address assumption.

Reference:

- [docs/POLKADOT_OFFICIAL_ALIGNMENT.md](/Users/pascalkuriger/repo/Polkadot/docs/POLKADOT_OFFICIAL_ALIGNMENT.md)
- [docs/POLKADOT_EXECUTION_PLAN.md](/Users/pascalkuriger/repo/Polkadot/docs/POLKADOT_EXECUTION_PLAN.md)

---

## Acceptance criteria

Phase 1 is complete when all of the following are true:

- The public manifest is narrower than the authenticated execution API.
- The public manifest no longer advertises unsupported A2A.
- Discovery docs no longer tell us to submit a money-moving MCP surface.
- Homepage copy and metadata lead with trusted work + identity.
- Strategy docs accurately describe current contract behavior.
- Polkadot-specific ownership and mapping docs match the official Hub model.
- A new builder can understand the public product in under 10 minutes.
- The team has one repo-local checklist for what must be green before submission.

---

## Immediate next tasks

1. Ship the directory-safe discovery manifest.
2. Sync every public manifest copy to that shape.
3. Update discovery docs to reflect the discover/execute split.
4. Fix any docs drift that weakens trust.
5. Add example integrations and a first SDK.

Until those are done, the correct stance is:

`production-like testnet with strong public trust surfaces, not yet the
broadest possible financial agent platform launch`.
