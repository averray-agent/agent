# PACKET — Publish the OpenAPI spec (real gap) and alias the discovery manifest (operator decision)

Status: ready for implementation. **Two PRs.** A is a must-ship discoverability
fix that stands on its own. B is gated on one operator decision stated below.
No contract, manifest, x402-rail or admin-surface change.

## What happened

A third-party crawler (AgentBoard, BrittonGarrett LLC — free scorecard,
$3.75 recrawl / $10 pin upsell; ignore both) graded averray.com **D · 34/100**
and DM'd the operator. I probed every path its published methodology checks
against what we actually serve:

| check | pts | verdict |
|---|---|---|
| HTTPS, `/llms.txt`, MCP endpoint | 29/29 | pass |
| `/.well-known/ai-agent.json` | 0/15 | **filename mismatch** — we ship the same content as `/.well-known/agent-tools.json` |
| `/.well-known/agent-card.json` (A2A) | 0/12 | absent; we never adopted A2A |
| machine-readable pricing | 0/8 | ours is live at `/.well-known/x402`; grader wants `/pricing.json` or a field in `ai-agent.json` |
| named capabilities + I/O schemas | 0/16 | derived from the two files above; fall with them |
| **OpenAPI at `/openapi.json` or `/swagger.json`** | 0/12 | **real gap** — see below |

Roughly 50 of the 66 lost points are the grader probing a filename we
deliberately did not use (`discoveryMode: "directory-safe"` was a decision).
That part is a choice, not a defect. The OpenAPI line is a defect.

## Defect A — the OpenAPI spec exists, is unpublished, and is already wrong

`docs/api/openapi.json` (OpenAPI 3.1.0, 19 paths, 33 schemas) is served
**nowhere**: `/openapi.json`, `/swagger.json` and `/docs/api/openapi.json` all
return 404 on both hosts. `agent-tools.json` mentions OpenAPI but points at
nothing that resolves. A buyer, an SDK generator, or any crawler looking for an
API contract finds none — independent of this grader.

Worse, it is not fit to publish as-is. Verified against `origin/main`:

- **Stale.** Last touched by #1233. It predates Verify: **no `/verify/runs`, no
  `/verify/profiles`**, no `/pool`, no `/mcp`. Publishing it would advertise an
  API that omits the only cash product.
- **Carries admin routes.** `/admin/status`, `/admin/jobs/lifecycle`,
  `/admin/jobs/ingest/openapi`. Operator surfaces do not belong in a public
  contract; the discovery manifest already excludes them on purpose.
- **Carries the testnet chain id** (`420420417`) alongside mainnet, and a
  `http://localhost:8787` server entry.
- **No drift guard.** `package.json` has `check:discovery-manifest` and
  `check:job-schemas`; nothing references the OpenAPI document. It drifted the
  moment Verify shipped and nothing noticed. Published without a guard, it will
  drift again.

## Decision B — the discovery aliases (operator's call, recommendation stated)

> **DECIDED 2026-09-09 by the operator: YES.** Build B under the three
> constraints below. A is #1354 (gated, one fixup pending).

Serving `/.well-known/ai-agent.json` and `/.well-known/agent-card.json` as
**projections of the same `buildDiscoveryManifest` output** costs almost
nothing and would likely lift the grade into the B range. It also creates two
more public surfaces that can drift and widens where our directory-safe slice
is discoverable.

**Recommendation: do it**, under three constraints that keep it honest:

1. Same slice. The aliases expose exactly the directory-safe tool set —
   `CONNECTED_ONLY_TOOLS` (`discovery-manifest.js:~620`: the SIWE-bound poster
   half, session creation/rotation, account mutations) stays excluded. The
   explicit-omission comment there exists precisely so nothing drifts into
   discovery; the aliases inherit it, they do not re-decide it.
2. One source. Generated from `buildDiscoveryManifest` at request time, never
   a checked-in copy. Pricing is read from the x402 document, never a literal —
   `llms.txt` already refuses to restate price ("read `resources[0].maxAmountRequired`
   … no price is restated here") and the aliases must hold the same line.
3. No A2A pretence. An `agent-card.json` implies an A2A server to some readers.
   We do not run one. The card carries name, url, description and capabilities
   and **declares no task/RPC endpoint**. A card that hints at A2A we can't serve
   is a truth-boundary problem dressed as SEO.

The "no" option is legitimate: skip B, keep the D, lose nothing functional.
Make it a decision either way.

## The fix

### A — publish a correct, guarded OpenAPI (own PR, must-ship)

- Regenerate or repair `docs/api/openapi.json` so it describes the **public,
  mainnet** contract: every unauthenticated GET in the public allowlist
  (`http-helpers.js` public route list) plus the documented authenticated buyer
  and worker routes (`/verify/runs`, `/verify/profiles`, `/verify/runs/{runId}`,
  `/jobs/*` worker door, `/pool`, `/onboarding`, `/receipts/:id`). **Remove**
  every `/admin/*` path, the testnet chain id, and the localhost server.
- Decide `/jobs/x402` explicitly. It is a real route (the poster ramp). It may
  stay in the spec, but the spec must not be confused with x402 *discovery*:
  `/.well-known/x402` keeps exactly one resource, `/verify/runs`, per
  P-VERIFY-REVENUE. Say so in a one-line description on that path.
- Serve it at **`https://api.averray.com/openapi.json`** with
  `content-type: application/json`, and add it to the public allowlist. Serve
  `/swagger.json` as an alias only if trivial; `/openapi.json` is the one that
  matters.
- Link it from `llms.txt` (the grader, and buyers, follow those links) and from
  the `openapi` pointer in `agent-tools.json` that currently resolves to nothing.
- **Add the drift guard**, in the idiom of `check:discovery-manifest`: every
  public-allowlisted route appears in the spec or in a named exclusion list with
  a reason. Wire it into CI next to the other two checks.

### B — discovery aliases (own PR, gated on the decision above)

- `/.well-known/ai-agent.json`: name, description, capabilities (directory-safe
  tools, from the manifest), contact, auth summary, rateLimit if we actually
  enforce one (omit rather than invent), and a `pricing` object that **embeds the
  live x402 terms at request time** or references `/.well-known/x402` — no
  literal.
- `/.well-known/agent-card.json`: name, url, description, skills/capabilities
  from the same slice; **no task endpoint, no A2A protocol claim**.
- Both served on the API host from the same route family as
  `public-metadata-routes.js:283`, and on the apex the same way
  `agent-tools.json` reaches it today (it returns 200 there; the marketing tree
  has no static well-known files, so confirm the mechanism — Caddy — and reuse
  it rather than committing static copies that drift).
- Add both to the public allowlist beside `agent-tools.json`.

## Non-negotiables (each pinned by a test)

1. **Published spec contains zero `/admin/*` paths, no `420420417`, no
   `localhost` server.** Mutation: add one admin path — the test must fail.
2. **Drift guard, red on `origin/main` first.** Every public-allowlisted GET route
   is in the spec or the exclusion list. Prove it fails against today's spec
   (`/verify/runs` is missing) before the fix, green after. Mutation: add a
   public route with no spec entry — must fail.
3. **`/openapi.json` is served** on the API host, 200, JSON, and passes the
   structural OpenAPI 3.1 check used by the tests (`openapi`, `info`, `paths`,
   `servers` = mainnet only).
4. **`llms.txt` and `agent-tools.json` both link the served URL**, and the URL
   resolves in the same test.
5. **Aliases equal the manifest** (B): `ai-agent.json` capabilities ==
   directory-safe tool set from `buildDiscoveryManifest`. Mutation: add a
   `CONNECTED_ONLY_TOOLS` entry to the alias — must fail.
6. **Pricing is live, not literal** (B): change the x402 price fixture and assert
   the alias follows. Mutation: hardcode `"5"` in the alias — must fail.
7. **No A2A pretence** (B): `agent-card.json` declares no task/RPC endpoint.
   Mutation: add one — must fail.
8. **Apex and API serve identical bytes** for each well-known file (B), as they
   do for `agent-tools.json` today.

## Out of scope

Paying AgentBoard for a recrawl or a pin (the grade recomputes free).
Implementing A2A. Adding any admin, verifier or mutating route to a public
document. Changing `/.well-known/x402` (stays exactly one resource).

## Handback

Two PR numbers; green CI; the eight test names; drift-guard evidence (test 2
red on `origin/main`, green after); live `curl` of `/openapi.json` on the API
host showing 200 + `application/json` and no `/admin` path; for B, the operator's
recorded yes/no, and if yes, a live read of both aliases from both hosts.
