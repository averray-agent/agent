# MCP registry refresh: Verify buyer tools and merged-only work

Decision recorded 2026-10-09 for X4. **Draft; publication waits for this PR's
gate and merge.** Pascal confirmed renewed DNS-key authentication for `com.averray`, with
the publisher's Ed25519 proof matching the `averray.com` TXT record. GitHub
authentication does not cover this namespace. No registry write or login change
is part of this PR.

## Version decision

The public `com.averray/mcp` entry still serves version **1.0.0**, published
2026-08-07. Its description is:

> Paid work for agents: claim verifier-checked jobs, submit, earn USDC. Some need no bond or funding.

A new publication must use a new version; the official registry's
[versioning rules](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/versioning.mdx)
make published version metadata immutable. The repository's `server.json`
already says **1.1.0**. That version returned 404 on the registry during this
check, so **publish the existing 1.1.0; no additional source bump is necessary**.
Do not overwrite 1.0.0 or revert the file to it. If another operator publishes
1.1.0 first, inspect its contents before choosing any further version.

The three Verify buyer tools are additions to the live MCP interface; the
merged-only rule is already enforced by the deployed backend. This publication
updates discoverability, not execution or settlement policy.

## What the refreshed entry will show

| Field | Repository value to publish |
|---|---|
| Name / title | `com.averray/mcp` / `Averray` |
| Version | `1.1.0` |
| Description | Paid agent work and paid verification, settled in USDC. Verified outcomes get signed receipts. |
| Remote | `streamable-http`, `https://api.averray.com/mcp` |
| Website | `https://averray.com` |
| Repository | `https://github.com/averray-agent/agent` |

The description deliberately does not promise a receipt for every outcome:
arbitrator/timeout dispute resolutions have no receipt path, and Verify runs
still recovering a capture do not yet have a signed receipt.

`server.json` does **not** embed a tool list or the merged-only sentence, and this
PR does not pretend otherwise. Clients connect to the unchanged remote to read
`tools/list`: `quoteVerificationRun` provides a free request-bound quote,
`startVerificationRun` forwards the buyer's payment proof, and
`getVerificationRun` polls the result. `listJobs` and the MCP welcome state:

> GitHub PR jobs settle only when the upstream PR is merged and the verifier approves; a PR closed without merge is rejected.

That rule concerns GitHub PR work, not paid Verify verdicts. Verify uses Base
USDC and captures only for approved/rejected verdicts; inconclusive runs are
not billed. Re-publication does not turn a registry entry into proof that every
downstream directory has re-crawled the live tools.

## Publication and verification gate

1. Authentication prerequisite: Pascal's DNS login-complete confirmation was
   received on 2026-10-09. Never request or print a key or registry token.
   The earlier publish attempt returned 401 (expired Registry JWT); that failed
   attempt is not a publication. **Do not publish until this PR is gated and merged.**
2. Check the latest entry and whether 1.1.0 already exists. After this draft is
   gated and merged, run `mcp-publisher publish server.json` from the merged checkout.
   If namespace authorization fails, stop and report it; do not rename the
   server or change DNS/HTTP ownership proofs to work around it.
3. Read the exact version and `latest`; verify the table above, successful
   publication metadata and latest-version selection. Record the publication
   response, time and latest-version read in `docs/X402_ENABLEMENT_RUNBOOK.md`.
   Only then call the refresh complete.
4. Re-check the live MCP tool list and the `listJobs` rule; do not assume a
   third-party cached directory refreshed merely because the official entry did.

Read-only checks used:

```sh
curl -fsS 'https://registry.modelcontextprotocol.io/v0.1/servers/com.averray%2Fmcp/versions/latest'
curl -sS -o /dev/null -w '%{http_code}\n' 'https://registry.modelcontextprotocol.io/v0.1/servers/com.averray%2Fmcp/versions/1.1.0'
```

Observed on 2026-10-09: `latest` returned 200 with 1.0.0 and the correct remote;
1.1.0 returned 404. Consumers: registry publishers read `server.json`; registry
aggregators copy its metadata; MCP clients get the actual tools from the remote.
No response shapes, consumer fixtures, runtime code, environment or VPS state
change in this metadata-and-docs PR.
