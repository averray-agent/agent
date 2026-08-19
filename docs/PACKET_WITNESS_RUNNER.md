# PACKET — Witness runner service (V4 completion)

- **Status:** SPEC — RATIFIED 2026-08-19 (Pascal). Ready for Codex.
- **Supersedes:** the "ship the runtime in the backend image" instruction from
  the smoke dispatch — that instruction was WRONG, and Codex was right to stop
  and ask instead of following it.
- **Decision of record:** mounting `/var/run/docker.sock` into
  `agent-mainnet-backend` is **REFUSED, permanently** — not deferred. The
  internet-facing backend on the host that vends KMS credentials must never
  hold Docker control. Verify executes customer-chosen code *by design* (a
  patch may rewrite `package.json`'s test script — the sandbox is the boundary
  that makes that safe); the process orchestrating that sandbox cannot be the
  public listener.

---

## 0. Evidence this design is needed (first live paid run, 2026-08-19)

Run `verify-174ecced-d82f-4a48-b74a-3b1068b1f2d2`: authorize passed with a real
5 USDC EIP-3009 authorization, the runner died at materialization
(`spawn git ENOENT`), and the billing rule held perfectly — `not_billed`,
buyer's 6.0 USDC untouched, capture never submitted, auth nonce unused
on-chain (all verified independently on Base). After `git`, the executor
drives `docker image inspect/build/create/start` — the backend container has
none of it, and must not be given it. `git-patch-tests-v1` has therefore never
been executable in production; the door is disarmed (#1170) until this packet's
exit condition passes.

## 1. Shape

A separate compose service, `agent-mainnet-witness-runner`, on the internal
network. The backend keeps exactly its current API surface; execution moves
out of process.

```
customer ── x402 ──> backend (public)          witness-runner (no listener)
                      │  authorize offline        │
                      │  create run: queued       │
                      │  write to state store ──> │ claim queued run
                      │                           │ fetch + sha256-verify artifacts
                      │  poll GET /verify/runs    │ execute in Docker sandbox
                      │                           │ write verdict + evidence
                      │  capture/release per      │
                      │  verdict, build receipt   │
```

The run service's API contract is **already async** (`queued → running →
complete`, poll endpoint, durable store) — #1161 simply executed synchronously
in-process. This packet restores the intended shape; **the public API does not
change.**

## 2. Hard constraints (each is a gate item)

1. **No public listener.** The runner binds nothing. It polls the state store.
2. **Queue = the existing state store.** No new transport, no message broker.
   Claim must be atomic (the store already has claim-lock primitives) so two
   runners never execute one run.
3. **Runner env is minimal:** state-store access + Docker endpoint. **No admin
   tokens, no KMS, no op:// beyond its own needs, no payment config.** The
   payment gate stays in the backend untouched — capture fires only when the
   backend reads a decisive verdict written by the runner.
4. **Docker via a socket proxy** (e.g. a tecnativa/docker-socket-proxy-class
   allowlist), exposing ONLY the endpoints `witness/src/docker.mjs` actually
   calls. The raw socket is never mounted into the runner. If the proxy cannot
   express an allowlist tight enough to be meaningful, say so in the PR rather
   than silently widening it.
5. **The runner fetches artifacts itself** and re-verifies sha256 + byte
   length before execution. It never trusts backend-fetched content.
6. **Fail-degrade, never fail-take-down:** if the runner is absent or wedged,
   the backend keeps serving; queued runs age into
   `inconclusive(runner_fault)` after the profile timeout + margin, and are
   never billed. The optional-product law from #1163 applies end to end.
7. **Classification fix rides along:** `attribution: infrastructure` /
   `host_failure` must surface as public reason **`runner_fault`** — never
   `ambiguous_evidence`, never text implying the customer's evidence was at
   fault. (Observed on verify-174ecced; the internal report was honest, the
   public mapping was not.)

## 3. Sandbox posture (v1)

The Witness's existing container execution (`witness/src/docker.mjs`) is the
sandbox: resource-enforced, offline-verified inputs, integrity-forbid rules.
The runner adds isolation *around* the orchestrator, not a new sandbox. Do not
redesign the Witness in this packet.

## 4. Tests / exit condition

- CI must run the REAL fixture end-to-end **inside the built images** (compose
  up backend + runner + proxy in the workflow): release
  `verify-smoke-fixtures-v1` bundle `f33bf850…` + patch `a3b85b3d…`,
  `["npm","test"]`, expect verdict **approved**, billing captured against a
  test gate double. Host-green-only CI has now missed two container gaps
  (#1163's boot crash, this one); container-level proof is the requirement.
- Runner-absent test: with the runner down, a paid run ages to
  `inconclusive(runner_fault)`, bills nothing, backend stays healthy.
- Claim-atomicity test: two runners, one queued run, exactly one execution.
- Proxy test: the runner's Docker client works through the allowlist; a
  disallowed endpoint (e.g. container exec on an arbitrary container) is
  refused.

**Exit:** the paid smoke (RUNSHEET_VERIFY_PAID_DOOR_SMOKE §4–§6) passes end to
end in production — decisive verdict, capture on Base, receipt public, and the
inconclusive rehearsal still never bills. Rearm (`X402_VERIFY_MODE=enabled`)
rides the same PR as the passing smoke evidence, not before.

## 5. Out of scope

New profiles, microVM/Firecracker isolation (a later hardening rung), any
change to the payment gate, any change to the public API.
