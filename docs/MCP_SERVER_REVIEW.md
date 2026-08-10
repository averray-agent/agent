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
`marketing`, `app`. A root-level audit reports 10 advisories — 5 high, 3 moderate and 2
low, the last two being `eslint`/`@eslint/plugin-kit` in the root devDependencies. **Not
one of them is in the MCP server's dependency closure** — not `ponder`, and not any
individual advisory package. The indexer reads chain state and is not reachable from any
MCP tool.

Check that with the contrast rather than a bare absence. `npm ls` prints `(empty)` when
`node_modules` is merely uninstalled, which is indistinguishable from a clean result — so
run the negative and the positive together and require both:

```sh
npm ci
npm ls ponder --workspace mcp-server   # (empty)
npm ls ponder --workspace indexer      # ponder@0.16.x
```

**Two corrections to the previous version of this section.** Both were found by checking
it rather than re-reading it, and both were wrong in our own favour, which is the
direction that deserves the least benefit of the doubt.

- It claimed every advisory traces to `ponder`. Four do: `kysely`, `drizzle-orm`,
  `@hono/node-server`, and the `ponder` entry itself — which is only the aggregate of
  those three, not a defect in ponder's own code. The other four do not. `vite` is shared
  with `astro` (`marketing`), `nanoid` arrives via `postcss`, and `tar` and `typeorm` come
  from `@acala-network/chopsticks-db`, a **root devDependency** that never ships.
- It claimed the remedy is `ponder` 0.16.6 → 0.17.6. **That upgrade fixes nothing.** Every
  0.17.x pins the same vulnerable versions as 0.16.6 — `kysely@^0.26.3`,
  `drizzle-orm@0.41.0`, `@hono/node-server@1.19.5` — and resolving each tree in isolation
  produces byte-identical advisory sets. `kysely@^0.26.3` cannot reach the patched 0.28.17
  from inside its own range, which is why `npm audit` nominates `ponder@0.0.1` as the
  "fix". The bump would have bought a forced schema re-sync on the one service with a
  history of schema-ownership failures, in exchange for zero advisories closed.

**Reachability in the indexer.** All eight high and moderate advisories are unreachable as
deployed — as are the two low `eslint` ones, which are lint tooling that never runs in any
image. Each reason can be checked against the source:

| advisory | why it does not reach us |
|---|---|
| `kysely` (×3) | Ponder drives kysely through `PostgresDialect` only, so the MySQL `sql.lit` advisory cannot apply. The two JSON-path advisories require `.key()`/`.at()` on a JSON path builder; neither ponder nor `indexer/src` calls one. |
| `drizzle-orm` | Affects dynamic **identifier/alias** construction (`sql.identifier()`, `.as()`). Every identifier in `indexer/src` is a literal and every interpolation is a bound value. |
| `@hono/node-server` | `serve-static` path traversal on **Windows**. We deploy Linux, and the indexer serves no static files. |
| `vite`, `vite-node`, `esbuild` | Dev-server issues, two of them additionally Windows-only. Production runs `ponder start`, which starts no vite dev server. |
| `nanoid` | Reached through `postcss`, a build-time dependency of the marketing site. Not present in the indexer image. |
| `tar`, `typeorm` | `@acala-network/chopsticks-db`, a root **devDependency**. `typeorm`'s defect is in `migration:generate`, a command this repository never runs. |

**What that analysis surfaced, stated plainly because it cuts against us.** A root-level
audit does not describe what the indexer actually runs. [`indexer/Dockerfile`](../indexer/Dockerfile)
copies `indexer/package.json` and runs `npm install --omit=dev`, so the image resolves its
own tree — without the root lockfile, and without the root `overrides` that patch `vite`,
`ws`, `tar` and `esbuild` in a developer's checkout. Reproducing that install yields **9
advisories rather than 8**, including `viem`/`ws` findings the root audit masks, and
`ponder` floats on `^0.16.6` (today 0.16.10). Every one remains unreachable for the reasons
above, so this is a reproducibility gap and not an exposure. It is tracked as its own
indexer change because pinning the tree edits `indexer/`, whose tree hash is what
[`INDEXER_SCHEMA_RECOVERY.md`](INDEXER_SCHEMA_RECOVERY.md) keys schema ownership on — so
the fix itself forces a fresh schema and a historical re-sync.

**A correction, offered because conceding a wrong finding would be as dishonest as
denying a right one.** The 2026-08-10 review listed "Known vulnerability in js-yaml".
We ship **js-yaml 4.3.1**, and `npm audit` reports **zero** js-yaml advisories. The
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
