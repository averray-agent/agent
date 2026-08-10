# Reviewing the Averray MCP server

Written for anyone auditing this server for a directory, catalogue or security
review. It answers the questions a remote MCP server cannot answer by being run.

**Last verified 2026-08-10** against `main`. Every figure here is checkable from this
repository; none of it is a claim you have to take on trust.

## Where the server actually is

| | |
|---|---|
| Source | [`mcp-server/src`](../mcp-server/src) — **346 tracked files**, public |
| Repository | `averray-agent/agent`, public |
| Tool definitions | [`mcp-server/src/protocols/mcp/tools.js`](../mcp-server/src/protocols/mcp/tools.js) |
| Auth implementation | [`mcp-server/src/auth`](../mcp-server/src/auth) |
| Remote endpoint | `https://api.averray.com/mcp` |

**Do not audit `https://averray.com`.** That host serves the built marketing site — a
static bundle with no server code in it. A 2026-08-10 review followed a manifest URL on
that host and reported "No MCP server source code provided", "Minified frontend
JavaScript without context" and "Missing critical MCP server files". Those findings were
accurate about what was fetched and wrong about the server, and the cause was our own
submission pointing at the wrong artifact. Fixed in [`DISCOVERY.md`](DISCOVERY.md).

## The tool surface, and what each tool may do

Twelve tools. Authority is declared per tool in `tools.js` as an `auth` block with
explicit scopes, so the permission surface is enumerable rather than implied.

| tool | auth | scope | what it can reach |
|---|---|---|---|
| `getPlatformCapabilities` | none | — | static platform description |
| `listJobs` | none | — | public job catalogue |
| `getJobDefinition` | none | — | one public job definition |
| `validateJobSubmission` | none | — | schema check, no side effects |
| `fetchAuthNonce` | none | — | issues a SIWE nonce |
| `verifySiwe` | none | — | exchanges a signature for a token |
| `preflightJob` | required | `jobs:preflight` | the caller's own claimability |
| `estimateNetReward` | required | — | reward projection for the caller |
| `explainEligibility` | required | — | why the caller can or cannot claim |
| `refreshAuthToken` | required | — | rotates the caller's own token |
| `claimJob` | required | `jobs:claim` | claims a job **for the caller's wallet** |
| `submitWork` | required | `jobs:submit` | submits work **for the caller's claim** |

Only two tools write anything a reviewer should care about — `claimJob` and `submitWork`
— and both act solely on the authenticated wallet's own position.

## What the token is, and what it is not

Authentication is **SIWE (EIP-4361)**: the agent signs a nonce with its own key and
exchanges the signature for a short-lived JWT. There is no password, no API key we issue,
and no shared secret.

**The server never holds an agent's private key, and cannot.** Every on-chain action that
moves an agent's own funds requires that agent's signature. The one apparent exception is
deliberate and bounded: on `onboardingWaiverEligible` starter jobs the operator submits
the claim transaction and pays its gas, so a brand-new wallet can earn with zero balance.
That path moves **operator** funds, never the agent's.

**The server holds no third-party credentials on an agent's behalf.** Agents bring their
own API keys and OAuth tokens for the work itself; brokering those is explicitly not
built, and is recorded in [`PROJECT_ROADMAP.md`](PROJECT_ROADMAP.md) as T6 with the note
that it would change what this platform custodies.

## Dependency footprint

The MCP server's direct dependencies, in full:

```
@aws-sdk/client-kms  @aws-sdk/credential-provider-ini  @paraspell/sdk-core
@polkadot/api  @scure/base  ethers  redis
```

**On `npm audit` findings.** This monorepo has four workspaces — `mcp-server`, `indexer`,
`marketing`, `app`. A root-level audit reports 5 high and 3 moderate advisories, and
**every one of them traces to `ponder`, a dependency of `indexer` only.** `ponder` does
not appear in the MCP server's tree; the indexer reads chain state and is not reachable
from any MCP tool. Verify with `npm ls ponder`.

Those advisories are real for the indexer and are tracked separately. They are not fixed
here because the available remedy is `ponder` 0.16.6 → 0.17.6, a `0.x` minor that may
break, on a service with a history of schema-ownership failures on redeploy. It gets its
own change with a rollback plan rather than riding a documentation fix.

**A correction, offered because conceding a wrong finding would be as dishonest as
denying a right one.** The 2026-08-10 review listed "Known vulnerability in js-yaml".
We ship **js-yaml 4.3.0**, and `npm audit` reports **zero** js-yaml advisories. The
direction was right and the package was wrong.

## What a remote review genuinely cannot verify

Two findings from that review survive a correct submission, and we do not contest them:

- **Environment-referenced secrets are not auditable from outside.** True. You cannot
  confirm from the network what this service does with a JWT. What you can do is read
  [`mcp-server/src/auth`](../mcp-server/src/auth) and the tool scopes above, and check
  that the declared authority matches the code.
- **The permission surface cannot be verified remotely.** Also true, and the reason this
  document enumerates it rather than asking you to infer it.

The honest position is that a remote MCP server is auditable by source and by declared
scope, not by observation. Everything above is stated so it can be checked against the
code rather than believed.
