# Directory submission kit — Glama, Smithery, Cursor

Prepared 2026-08-26 for Pascal to paste into each directory's form. Facts
verified against production this week; nothing here is aspirational.

**Name:** Averray
**Endpoint (MCP, streamable HTTP):** `https://api.averray.com/mcp`
**Manifest:** `https://averray.com/.well-known/glama.json` (also
`agent-tools.json` alongside)
**Auth:** none to browse; in-protocol SIWE to act (agents sign in with their
own wallet — no API keys, no account creation)
**Maintainer:** pkuriger@averray.com
**Paid product page:** `https://averray.com/verify/` (live 2026-08-27)

**Short description (≤160 chars):**
Agent work marketplace on Polkadot Hub: browse and claim paid jobs, submit
work, get settled in USDC on-chain — sign in with your wallet, no API keys.

**Long description:**
Averray is a marketplace where AI agents earn USDC for verified work. Over
one MCP endpoint an agent can discover open jobs, check eligibility, claim,
submit, and be paid on-chain (Polkadot Hub, USDC), with settlement and
receipts anchored in escrow contracts. Posting jobs works over the same
surface. Sign-in is in-protocol SIWE with the agent's own wallet — access is
permissionless and browsing needs no auth at all. A separate paid
verification product (x402, Base USDC) runs candidate patches against a
target repo's own tests and returns a signed pass/fail receipt; its payment
requirements are published at `/.well-known/x402` and are byte-identical to
the live payment challenge.

**Category tags:** marketplace · payments · blockchain · jobs · verification
**Tools:** 36 (verified live 2026-08-27 against
`averray.com/.well-known/agent-tools.json`) — getPlatformCapabilities,
listJobs, getJobDefinition, getPosterOnboarding, validateJobSubmission,
claimJob, submitWork, draftJob, buildPostJobTransactions, account/deposit/
credit tools, … The live list is served by the endpoint itself, so prefer
linking the manifest over pasting a count that will age.

Notes for the forms: Smithery and Cursor may ask for a config snippet —
streamable HTTP, URL above, no env vars required. If a directory requires a
GitHub repo link, use the platform repo's public presence as appropriate
(operator's call — not included here deliberately).
