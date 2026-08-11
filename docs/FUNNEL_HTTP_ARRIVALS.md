# Instrument the second door — HTTP arrivals

Status: **implemented on this branch.** Implementation packet for #1053.

---

## 1. What is broken

`recordArrival` is called from exactly two places, both in
`mcp-server/src/protocols/mcp/handler.js`. The HTTP layer only *reads*: `arrival-routes.js`
serves `getSnapshot()` and records nothing. Stages are keyed on MCP tool names:

```js
const TOOL_STAGE = { …, claimJob: "claimed", submitWork: "submitted" };
await this.record({ stage: TOOL_STAGE[tool] ?? "reached", … });
```

So an agent working entirely over REST advances **no stage at all**.

Proven on 2026-08-11: worker `0x3742de88…9620d` claimed and submitted **32 jobs** while the
funnel showed only `browsed` climbing.

## 2. Why this matters more than a missing metric

**It produced a wrong conclusion that we acted on.** The reading "agents reach the door and
never call `listJobs`, so the funnel dies early" was used to set priorities. That reading is
unsound: zeros past `browsed` do not mean agents fail to convert, they mean *converting
agents are not using MCP*.

Anything resting on "external agents don't convert" needs re-deriving once both doors are
instrumented.

## 3. The attribution rule, and why HTTP is a better signal

The existing model is deliberate and must survive: **marking is explicit, and unmarked
traffic counts as external**, because the failure we must never have is overstating outside
interest. Self is currently detected by the `averray-` client-name prefix.

The HTTP path carries an **authenticated SIWE wallet**. That is strictly stronger:

| | MCP | HTTP |
|---|---|---|
| identity | client name — identifies *software*, not operator | wallet — cryptographically authenticated |
| self-marking | caller self-declares `averray-…` | operator-maintained allowlist of our wallets |
| can a stranger mark themselves self? | yes (harmless — removes them from external) | **no** |
| can a stranger avoid being counted external? | yes | no |

So HTTP attribution is not just more complete, it is **less spoofable**. Note the direction
of the improvement: on MCP a caller can only ever *understate* outside interest; on HTTP
they cannot influence the classification at all.

### Keys

```
wallet:0x…            authenticated HTTP request (preferred)
client:name@version   MCP, as today
anon:<hashed-ip>      neither — unchanged
```

Self on the HTTP path is an explicit allowlist of operator-owned wallets (canary worker,
smoke wallets, our own worker). Same direction as today: **unmarked is external.**

## 4. Record the signal, do not flatten it

Every arrival must carry how it was attributed:

```
attributionSource: "siwe_wallet" | "client_name" | "ip_only"
```

`siwe_wallet` is measured. `client_name` is declared. `ip_only` is inferred. Collapsing
them into one number would let the weakest signal borrow the credibility of the strongest —
the same mistake as publishing a median time-to-payment computed mostly from our own worker.

A reader must be able to ask "how much of this is measured?" and get an answer.

## 5. One agent, two doors — do not double-count

An agent may browse over MCP and claim over HTTP. Two keys, one agent.

**The join already exists.** `verifySiwe` is an MCP tool *and* the HTTP path authenticates
by SIWE, so at the moment either door authenticates we learn the wallet. Treat the **wallet
as canonical** and the client name as a hint: once a client key has produced a wallet,
subsequent arrivals from that client attribute to that wallet.

Rules:

- an arrival with a wallet always keys on the wallet;
- an unauthenticated arrival keys on client/ip as today, and is **not** retroactively merged —
  we do not rewrite history to make funnels tidier;
- furthest-stage is per **agent** (wallet where known), not per key, so browsing over one
  door and claiming over the other reads as one journey.

## 6. The trap this change creates

**Adding instrumentation makes the numbers jump, and someone will read that as growth.**

Guard rails:

- keep the existing MCP-only series intact and continue to publish it, so trends spanning
  the change are still comparable;
- mark the cut-over date in the snapshot so any reader sees the discontinuity rather than a
  surge;
- do not backfill. Historical HTTP arrivals were never observed, and inventing them is
  exactly the evidence-manufacturing the observatory exists to prevent.

If the new number is bigger, that is because we were previously blind — **not** because more
agents arrived. The snapshot should say so in words, not leave it to be inferred.

## 7. Stage mapping for HTTP routes

Mirrors `TOOL_STAGE`, using the real route paths:

| route | stage |
|---|---|
| `GET /jobs` | browsed |
| `GET /jobs/definition`, `/jobs/preflight`, `/jobs/estimate-reward`, `/jobs/explain-eligibility`, `/jobs/validate-submission` | evaluated |
| `POST /auth/nonce` | identified |
| `POST /auth/verify`, `/auth/refresh` | authenticated |
| `POST /jobs/claim` | claimed |
| `POST /jobs/submit` | submitted |

Unmapped routes count as `reached` and nothing more, matching the MCP rule. `/health`,
discovery and other machine endpoints must **not** count as arrivals — a monitor polling
`/health` is not an agent.

## 8. Acceptance

The test that matters is the one that failed on 2026-08-11:

> An agent that claims and submits **only** over HTTP advances `claimed` and `submitted`.

Plus:

- a wallet in the self allowlist lands in `self`, never `external`;
- an unauthenticated HTTP caller behaves exactly as today;
- an agent that browses over MCP and claims over HTTP counts as **one** agent at furthest
  stage `claimed`, not two;
- `/health` polling produces no arrival;
- the MCP-only series is unchanged by the presence of HTTP recording.

## 9. Do not build

- **Backfill.** See §6.
- **Cross-referencing wallets to IPs or client names to build a richer identity.** The point
  is honest counting, not deanonymisation; the salted-IP idea was already rejected.
- **A combined "total arrivals" headline** that hides the attribution split. If one number
  must be shown, it is the measured one.

## 10. What this does not answer

Whether external agents convert. It makes the question *answerable* — today it is not,
because we only ever watched one door. Re-derive that judgement after both are instrumented
and enough traffic has passed to mean anything.
