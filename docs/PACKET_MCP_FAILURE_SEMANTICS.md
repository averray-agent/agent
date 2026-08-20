# PACKET — `mcp-failure-semantics-v1` (Verify profile 2)

- **Status:** SPEC — one Pascal decision in §5, then ready for Codex.
- **Phase:** Verify profile 2 of [`PACKET_VERIFY_SHELF.md`](./PACKET_VERIFY_SHELF.md).
  Profile 1 (`git-patch-tests-v1`) is PROVEN PAID end to end (2026-08-19).
- **Why this one next:** the outreach segmentation leads its largest cohort — 8
  MCP/agent-tool operators — with this exact product. It is currently vapor.
- **Author:** Claude, 2026-08-20, grounded against the shipped runner isolation.

---

## 0. The tension that IS this packet

Profile 1 verifies a **self-contained artifact**: a git bundle + patch, fetched
and hashed by the runner, executed in a sandbox at `NetworkMode: none`. Nothing
the customer supplies gets to touch the network.

`mcp-failure-semantics-v1` verifies a **live endpoint's behaviour under a
failure profile** — which means the verification MUST reach the customer's MCP
server over the network. That directly contradicts the sandbox posture the
Docker admission proxy enforces (`policy.mjs:100` — `NetworkMode !== "none"` is
denied; `:143` — endpoint attachments forbidden).

**This is not a reason to loosen the sandbox.** The sandbox exists because
profile 1 executes customer-chosen *code*. An MCP probe executes OUR code
against the customer's *endpoint* — a different trust shape. The resolution is
to run the probe in the right place, not to weaken the wrong one.

## 1. Architecture: the probe is not the sandbox

Two distinct execution contexts, and keeping them distinct is the whole safety
argument:

- **The code sandbox** (existing, unchanged): `NetworkMode: none`, runs
  customer code. `mcp-failure-semantics-v1` does not use it at all.
- **The MCP probe** (new): runs OUR fixed prober against the customer's
  endpoint, from a context with **exactly one** network destination — the
  declared endpoint — and nothing else.

The prober is a pinned image like the Witness sandbox image, but its policy is
different by design: **egress to the single declared endpoint host, denied
everywhere else.** It executes no customer code — only the versioned probe
suite — so a network-reachable context is safe in a way it never is for
profile 1.

## 2. What the profile actually tests

Bounded, named, versioned failure semantics — never a blanket "safe" badge. The
v1 suite (each a pass/fail/inconclusive check the customer's endpoint either
satisfies or does not):

1. **auth-boundary** — an unauthenticated call to a tool that declares auth
   required is rejected, not served.
2. **timeout-recovery** — the server returns a well-formed error on a slow/hung
   tool rather than hanging the transport or corrupting the session.
3. **tool-schema-stability** — declared tool input schemas are honoured:
   malformed input is rejected with a structured error, not a 500 or a crash.
4. **destructive-action-safety** — a tool annotated destructive/irreversible
   requires the confirmation its own annotation declares before acting.
5. **error-shape-conformance** — errors are MCP-protocol-shaped, not raw stack
   traces or provider leakage.

The receipt states exactly: *"endpoint X passed profile
`mcp-failure-semantics-v1@1` checks A,B,C, failed D, inconclusive E against
evidence root R on <date>."* Truth-bound, timestamped, bounded — the
[[feedback-truth-boundary]] law. **Never "certified", never "secure".**

## 3. Inputs, verdict, receipt

- **Input:** `{ target: { endpoint (wss/https), transport, auth?: {scheme, credentialRef?} }, profile }`.
  Credentials, if the endpoint needs them, are a customer-supplied **scoped,
  ephemeral** token passed to the probe context and never logged, never in the
  receipt, never persisted past the run — the credential-brokering boundary
  ([[project-agent-credit-layer]] T6 posture) is NOT crossed: we hold it for the
  run only, we never store or reuse it.
- **Verdict vocabulary is the existing one.** A check that can't be evaluated
  (endpoint unreachable, TLS failure, auth we can't complete) is
  **`inconclusive`**, reason from the existing taxonomy (`target_unreachable`,
  etc.) — never billed, never "fail". "Your endpoint charged nothing because we
  couldn't reach it" is the honest outcome, identical to profile 1's law.
- **Receipt:** the same `buildVerifyReceipt` object, same canonicalisation,
  `specSource: "verify_request"`, execution block carries the endpoint identity
  and per-check evidence, **no settlement section**.

## 4. Egress enforcement (the security core — mutation-drilled)

- The probe context resolves and pins the declared endpoint host, and its
  network policy allows egress to **that host only**. A probe attempt to any
  other host is refused at the boundary and surfaces as `platform_fault`
  (our prober misbehaved), never billed.
- **The drill:** a test wires the prober to attempt a second host and asserts
  the egress boundary refuses it — same self-proving shape as profile 1's
  no-settlement mutation drill. If the deny can't be proven, it isn't shipped.
- The prober is offline-pinned: no dynamic dependency fetch at run time (the
  container-gap lesson — build it into the image, prove it in CI inside the
  built image).
- **The code sandbox's `NetworkMode: none` is UNTOUCHED.** A test asserts
  profile 1 still runs at zero-network after this lands.

## 5. Decision for Pascal

**How is the single-endpoint egress enforced?** Two viable shapes; I recommend
the first:

1. **Egress-proxy allowlist (recommended).** Mirror the Docker-socket-proxy
   pattern we already run and trust: the prober's only network path is through a
   tiny proxy that admits the one declared host and denies all else, default-
   deny, allowlist-of-one. Same mental model as the admission proxy, same
   audit story, and it composes with the runner we shipped.
2. **Per-run network namespace with a single route.** Tighter at the kernel
   level, but more moving parts on the VPS and a new thing to operate. Stronger
   isolation, higher operational surface.

Recommendation: **option 1** — reuse the proxy pattern the team has already
gated and operated, rather than introduce namespace plumbing for the first
network-touching profile.

## 6. Tests

1. Egress-deny mutation drill (§4) — self-proving.
2. Code sandbox still `NetworkMode: none` — profile 1 unaffected.
3. Each of the five checks against a fixture MCP server: a **known-good** server
   passes all five; a **known-bad** fixture fails the specific check it should
   and passes the rest (per-check isolation, like profile 1's differential).
4. Unreachable / TLS-fail / auth-fail → `inconclusive`, **not billed**, never
   `fail`.
5. Credential is never logged, never in the receipt, never persisted — asserted.
6. Receipt shares `buildVerifyReceipt` canonicalisation; no settlement section.
7. CI runs the real known-good + known-bad fixtures **inside the built prober
   image** (the container-gap law — host-green is not enough).

## 7. Out of scope

Profile 3, continuous monitoring, an MCP registry write, the credential-broker
*product* (we hold a customer token for one run; we do not become a custodian),
and any change to profile 1 or the code sandbox.

**Exit:** a known-good MCP endpoint pays 5 USDC and receives a receipt naming
the five checks and their per-check verdicts; a known-bad one is billed the same
and its receipt names the failure; an unreachable one is billed nothing.
