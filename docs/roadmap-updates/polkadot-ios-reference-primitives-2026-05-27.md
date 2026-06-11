# Reference primitives from polkadot-ios-community — 2026-05-27

**Type:** Research note / reference bookmark — NOT a planning decision
**Source:** Direct code review of `github.com/paritytech/polkadot-ios-community` (cloned, read the actual Swift package sources — not just the README)
**Polkadot-specific claims herein:** require ledger verification before binding into spec or roadmap
**Status:** Open for review — research only

**[VERIFICATION COMPLETE 2026-05-27]** All three flagged Polkadot claims verified against docs MCP + source. Verdict: note is mostly accurate; three wording corrections applied inline (marked `[VERIFIED 2026-05-27]`): (1) IPFS retrieval should use Bulletin gateway / P2P-Helia, not generic public gateways; (2) "~2 weeks" retention is TestNet-specific, not a protocol constant; (3) People Chain allowance conclusion softened to "no evidence it solves Asset Hub escrow onboarding" rather than categorical impossibility. Sources: docs MCP `reference/polkadot-hub/data-storage.md`, `chain-interactions/store-data/bulletin-chain.md`, `reference/polkadot-hub/people-and-identity.md`. Verified-negative results should be recorded in `AVERRAY_VERIFICATION_LEDGER.md`.

---

## Why this matters and what it is NOT

The Polkadot iOS community repo is Parity's prototype self-custodial superapp (messaging, identity, payments, dApp hosting). **The superapp itself is not relevant to Averray** and is explicitly out of scope.

What IS relevant: the repo contains working reference implementations of three Polkadot primitives that map onto Averray's deferred or open architecture decisions. This fragment captures what the *actual code* (not the README marketing copy) shows about each, with honest assessment of availability and applicability.

Critical caveat: this is a **prototype exercised against the Paseo testnet contour**, not mainnet, and explicitly unaudited. Everything below is "reference for how it could work," not "production-ready dependency." Parity is in roughly the same not-yet-production position with these primitives that Averray would be.

Three primitives reviewed: Bulletin Chain storage, People Chain identity/allowance/score, and the device-handoff/remote-signing transport.

---

## 1. Bulletin Chain storage — direct reference for our deferred Phase 2 storage decision

**Package:** `Packages/BulletinChain/` (7 Swift files)

**What the code actually shows:**

The storage mechanism is the `TransactionStorage` pallet. The relevant call is dead simple:

- `store(data: Data)` — a single runtime call that writes bytes to the chain's temporary storage. That's the whole write path.

Content addressing works via blake2b-256 hashing → IPFS CID conversion:

- `HexToCIDConverter` takes a blake2b-256 hash and builds a CIDv1 with a fixed multihash prefix (`0xA0 0xE4 0x02 0x20` = blake2b-256 codec), supporting `json`, `raw`, and `dag-pb` (directory) codecs.
- `IpfsFetcher.lookupBy(rawHash:)` converts the on-chain hash to an IPFS gateway URL and fetches the content over HTTPS.

So the model is: **write bytes on-chain via `store`, address them by blake2b-256 hash, retrieve via IPFS CID through a gateway.** The chain holds the authorization + commitment; IPFS-compatible retrieval serves the content.

**[VERIFIED 2026-05-27 — correction]** The iOS code fetches via an IPFS gateway URL, but Polkadot docs (`chain-interactions/store-data/bulletin-chain.md`) **recommend the Bulletin Chain gateway or direct P2P/Helia, and explicitly discourage generic public IPFS gateways.** If Averray implements Phase 2 retrieval, build against the Bulletin gateway or P2P/Helia path, not a generic public gateway. The iOS app's gateway URL is configurable (`ipfsBaseURL` is injected), so this is a config choice, not a hardcoded constraint — but the discouraged-public-gateway guidance is the operative rule.

**The authorization/allowance model (important detail the README glosses):**

`TransactionStoragePallet.Authorization` and `AuthorizationExtent` reveal the real mechanics:
- An account is granted an authorization with `transactionsAllowance` (count) and `bytesAllowance` (size).
- Usage is tracked: `transactions` consumed, `bytes` consumed, with `remainedTransactions` / `remainedBytes` computed.
- Every authorization has an `expiration` block number — **"block number starting from which submission is not allowed anymore."**
- There's an `AuthorizationPeriod` constant and a `MaxTransactionSize` constant.

This **confirms our spec's v1.8 corrections from code**: Bulletin Chain storage is authorization-gated (per-account allowances) AND has an expiration model requiring renewal. Our spec said "~2-week retention requiring renewals, Root-origin authorization." The code confirms the *shape* (authorization + expiration + renewal) though the exact period is a runtime constant (`AuthorizationPeriod`) not hardcoded — so the "~2 weeks" figure is a runtime parameter, not a protocol constant.

**[VERIFIED 2026-05-27]** Polkadot docs confirm "~2 weeks" is correct **for Polkadot TestNet specifically** — it is network/runtime-specific, NOT a universal protocol constant. Mainnet (when finalized) may differ. Always treat retention as a per-network runtime value; verify against the target network's `AuthorizationPeriod` before quoting a figure.

**How it maps to Averray:**

This is *exactly* our deferred Phase 2 storage backend (the Bulletin Chain vs. Crust decision). Our Phase 1 is VPS hot storage + S3 recovery log + hash verification. The iOS code shows Phase 2 Bulletin Chain working in prototype:
- Their `store(data:)` ≈ our content-write path
- Their blake2b-256 → CID addressing ≈ our `sha256(canonicalJSON)` content addressing (different hash function — they use blake2b-256, we use sha256 — but same content-addressing discipline)
- Their `IpfsFetcher` ≈ our `GET /content/:hash` retrieval
- Their authorization/expiration model ≈ the renewal-tracking burden our spec flagged as Bulletin Chain's operational cost

**Honest assessment:**
- **Availability: testnet only, same boat as us.** Not production-ready for either party. But this is a concrete code reference for when we make the Phase 2 call.
- **One real divergence to note:** they hash with blake2b-256, we committed to sha256. If we ever adopt Bulletin Chain storage, we'd either switch hash functions or build a sha256→CID path. Not blocking, but a real detail.
- **Phase 2 stays deferred.** This doesn't change the deferral; it gives us a reference for when the deferral lifts.

**Recommended action:** bookmark `Packages/BulletinChain/` as the reference implementation for the Phase 2 Bulletin Chain option. Re-examine when volume/operations justify the Phase 1→Phase 2 migration. Do NOT adopt now. Verify the `AuthorizationPeriod` runtime value against the ledger if we ever quote retention figures.

---

## 2. People Chain identity + allowance + score — onboarding-friction research, with a surprise reputation parallel

**Package:** `Packages/Individuality/` (128 Swift files — much larger than README implied)

Three sub-systems here, all relevant in different ways.

### 2a. The Allowance subsystem — the "free transactions" mechanism

**What the code shows:** there are *three* allowance backends, not one:
- `Allowance/Bulletin/` — `BulletInAllowanceManager` allocates storage slots on Bulletin Chain
- `Allowance/StatementStore/` — allowance for the statement store (the chat-without-server backend)
- `Allowance/PGAS/` — "PGAS" allowance (likely People-chain gas abstraction)

The `BulletInAllowanceManager.allocate(accountId:policy:)` flow: check current allowance → if available and policy is `.ignore`, return → otherwise `assignSlot` → wait for on-chain authorization. The allowance is **per-account, slot-based, and tied to specific resources** (Bulletin storage slots, statement-store slots, PGAS).

**This is the critical finding for Averray's onboarding-friction question, and it cuts against the easy interpretation:** the "free transactions allowance" is NOT a general free-transaction mechanism. It's **resource-specific slot allocation** — you get an allowance for Bulletin storage, or for statement-store messaging, or for PGAS-scoped operations. It is not "do any transaction free."

**Honest implication:** my earlier framing (that this might solve Averray's "agents need funded wallets before doing anything" problem) is **probably too optimistic**. The allowance model is scoped to specific People Chain / Bulletin / statement-store resources, not arbitrary Asset Hub escrow operations. An Averray agent doing USDC escrow on Asset Hub would NOT obviously benefit from a People Chain proof-of-personhood allowance.

**[VERIFIED 2026-05-27 — wording corrected]** The honest claim is **"no evidence the allowance solves Asset Hub escrow onboarding directly"** — NOT absolute proof of impossibility. The source strongly suggests scoped allowances (separate Bulletin/StatementStore/PGAS managers, no path to Asset Hub found), and docs (`reference/polkadot-hub/people-and-identity.md`) support resource-scoping, but not every runtime path was verified on-chain. Treat as: absence of evidence it works for our case, strong enough to keep onboarding-friction on Path A, not strong enough to claim categorical impossibility.

### 2b. ProofOfInk — the personhood mechanism

`Packages/Individuality/Sources/ProofOfInk/` implements the proof-of-personhood verification (the "DIM2 gesture game" from the README is the UX; ProofOfInk is the on-chain mechanism). Includes design families, person records, participant origins. Relevant only if Averray ever wanted human-personhood verification for operators — which is NOT our current model (we're wallet + soulbound reputation, deliberately not requiring human identity). **Out of scope for Averray's current direction.**

### 2c. Score pallet — an unexpected reputation parallel worth noting

**This is a genuine surprise.** `Packages/Individuality/Sources/Score/` is an on-chain reputation/scoring pallet on People Chain. The code shows:
- `Recognition` enum: `recognized(PersonalId)`, `notRecognized`, `suspended(PersonalId)`, `externallyRecognized`
- `Streak` enum: `attended(UInt32)` / `absent(UInt32)` with `makeIntegerStreak()` producing positive for attended, negative for absent
- Participant, recognition, and streak storage paths

**How it maps to Averray:** this is conceptually adjacent to our reputation primitive. Their `Recognition` (recognized/suspended/not-recognized) parallels our tier/slash model. Their `Streak` (attended/absent) parallels the streak-bonus mechanism in our spec §10 reputation-engagement subsection. The *concepts* are similar — on-chain reputation with recognition states and streak tracking.

**Honest assessment:** interesting parallel, but **not adoptable**. Their Score pallet lives on People Chain and is tied to proof-of-personhood (human participants). Averray's reputation is soulbound-token-based on Asset Hub EVM, tied to wallets-doing-work, deliberately not requiring personhood. Different substrate, different identity model, different purpose. Worth knowing it exists as prior art / conceptual validation that "on-chain reputation with streaks and recognition states" is a pattern others are building — but not something we integrate.

**Recommended action:** note the Score pallet as conceptual prior art for our reputation model (validates the streak + recognition-state design). No integration. The allowance subsystem is a **research item that probably does NOT solve our onboarding friction** — verify against ledger, but set expectations low.

---

## 3. Device handoff / remote signing — narrower than the README implied

**Package:** `Packages/HandoffService/` (17 files) + `Packages/MessageExchangeKit/`

**What the code actually shows:** `HandoffService` is NOT a transaction co-signing service. It's an **encrypted data-handoff service** — `submitData(_:from:recipients:)` and `claimData(by:recipient:)`. It moves encrypted blobs between paired devices via an RPC pool, with blake2b hashing, sender/recipient proofs, and `MultiSigner` recipient addressing. It's the transport for syncing contacts/chats/account-data between paired devices (Mobile ↔ Desktop ↔ Web).

The actual peer/session transport is `MessageExchangeKit/PeerSession`, which runs over the **StatementStore** (People Chain statement store) with encryption — the same mechanism that powers serverless chat.

**The "use Mobile as a signer" feature from the README** is built ON TOP of these primitives (encrypted handoff + statement-store peer sessions) but isn't a single dedicated "remote signing" module. It's a composition: pair devices → establish encrypted peer session → desktop sends a signing request as an encrypted message → mobile (holding keys in secure enclave) signs → returns signature over the same channel.

**How it maps to Averray:** loosely. Averray's operator control-room needs a signer story for sensitive actions (treasury moves, policy changes, capability grants, multisig). A mobile-signer pattern is one option. But:
- The iOS implementation is deeply tied to their device-pairing + statement-store + secure-enclave stack — not portable as a drop-in.
- Averray's v1 signer story (SIWE web auth + multisig via Signet/Talisman) is already specced and doesn't need this.
- This is a **pattern to be aware of**, not a dependency or even a clear reference. If Averray ever wants native mobile signing, the building blocks (encrypted peer channel + secure-enclave signing) are standard; we'd build our own, not lift theirs.

**Honest assessment:** lowest priority of the three. Not gated, not blocked, but also not a clean reference — it's woven into their whole-app architecture. v2 operator-experience consideration at most.

**[VERIFIED 2026-05-27 — scope caveat]** Verification confirmed the *transport primitives* (encrypted data handoff via `HandoffService`, peer sessions via `MessageExchangeKit` over StatementStore) but did NOT verify a complete end-to-end transaction-signing flow. The "mobile as signer" composition is plausible from the README plus these primitives, but no single module implements full remote transaction signing — it's an inferred composition, not a verified working flow. If Averray ever pursues this, treat the signing flow as unproven and design it ourselves.

**Recommended action:** note as a v2-or-later operator-experience pattern (mobile-as-signer for sensitive control-room actions). No action now. Our v1 signer story is sufficient.

---

## Summary table

| Primitive | Package | Maps to Averray | Availability | Recommended action |
|---|---|---|---|---|
| Bulletin Chain storage | `BulletinChain/` | Deferred Phase 2 storage backend | Testnet only — same boat as Parity | Bookmark as Phase 2 reference; retention is per-network (TestNet ~2wk verified); use Bulletin gateway / P2P-Helia not public gateways; stays deferred |
| Allowance subsystem | `Individuality/Allowance/` | Onboarding friction (Path A) | Resource-scoped, NOT general | No evidence it solves Asset Hub escrow onboarding (verified); onboarding stays Path A |
| ProofOfInk personhood | `Individuality/ProofOfInk/` | Nothing — we don't do personhood | N/A | Out of scope |
| Score pallet | `Individuality/Score/` | Conceptual parallel to our reputation | People Chain, personhood-tied | Note as prior art; no integration |
| Handoff / remote signing | `HandoffService/`, `MessageExchangeKit/` | Operator signer story (loosely) | Not gated, but not portable; only transport primitives verified, not full signing flow | v2 operator-experience pattern; no action now |

---

## Routing recommendation

This is research, not a decision. It touches:
- **Deferred Phase 2 storage** (Bulletin Chain) — when reviewed, update the Phase 2 storage row in `PROJECT_ROADMAP.md` to reference this code as the Bulletin Chain implementation reference. Do not un-defer Phase 2.
- **Onboarding friction** (allowance) — a research sub-item; the honest finding is that it probably doesn't apply to Asset Hub escrow. Verify against ledger before recording any conclusion. If verified-negative, record that so we don't re-investigate.
- **Reputation prior-art** (Score pallet) — conceptual validation only; no doc change needed beyond optionally noting prior art in the spec's reputation section.

**Polkadot-specific claims requiring ledger verification before binding:**
1. Bulletin Chain `AuthorizationPeriod` actual value (the "~2 week retention" figure)
2. Whether People Chain allowance can extend to non-People-Chain (e.g. Asset Hub escrow) operations — code strongly suggests NO
3. Bulletin Chain mainnet authorization model maturity (still "being finalized" per our spec v1.8)

None of these should become locked decisions from this code read. The repo is a prototype on testnet; treat it as reference, not authority.

---

## One honest limitation

I read the package sources but not exhaustively — 28 packages, 128 files in `Individuality` alone. I read the files most relevant to the three primitives you asked about (storage, identity/allowance, signing). I did not read the full dependency graph, the runtime-config delivery, or the test suites in depth. If Averray decides to actually use any of this as a reference for implementation, someone should read the relevant package's full source — this fragment tells you *which packages matter and what they do at the interface level*, not every implementation detail.

*— Drafted 2026-05-27 from direct source review (cloned repo, read Swift package sources).*
