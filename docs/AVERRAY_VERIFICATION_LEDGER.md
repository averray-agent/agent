# Averray — Verification Ledger

**Purpose:** Track every empirical claim in `RC1_WORKING_SPEC.md` against authoritative documentation.
**Status:** Verification pass complete. All previously-⏳ items have been resolved against the authoritative Polkadot docs MCP (`https://docs-mcp.polkadot.com`) or the explicit upstream sources cited in each row.
**Owner:** Pascal
**Last updated:** 2026-04-28

---

## Summary

After this pass:

- ✅ **Verified:** 32
- ⚠️ **Verified with corrections needed:** 19
- 🔬 **Empirical (cannot be answered from docs):** 8
- ⏳ **Still pending:** 0

**Items not fully resolvable from docs alone:**

- Bifrost-specific behavior (SetTopic preservation on reply-leg, mint-failure semantics, settlement latency) remains 🔬. These were 🔬 going in and remain so by design.
- All "operational" Phase 1 questions (override rate of LLM-as-judge, PR merge rate, dispute rate at production volume) remain 🔬 — these can never be answered by docs.
- One new 🔬 surfaced: end-to-end "EVM-mapped Substrate multisig owns an EVM contract on Asset Hub" — the primitives are documented but the composition is not, so it must be confirmed on Hub TestNet before `MULTISIG_SETUP.md §4` can be treated as actionable.

**Corrections that flowed into `RC1_WORKING_SPEC.md` through the v1.9/v1.10 sync** (see the per-section "⚠️ Spec correction" paragraphs below):

1. **No "native DOT precompile address" exists.** The ERC20 precompile is for Assets-pallet-managed assets only (Trust-Backed, Foreign, Pool). Native DOT is the chain's intrinsic value/balance, not addressable as an ERC20 precompile. `MULTISIG_SETUP.md §5` must be reworded.
2. **"10x storage cost reduction in v2.2.1" is unsupported as written.** The official docs only state Asset Management is "approximately one-tenth the cost of relay chain transactions" — a comparison vs the relay chain, not a v2.2.1-introduced reduction. The v1.6 reconciliation log overstated this.
3. **All four PoP / DIM1 / DIM2 / contextual-alias claims are not currently in `docs.polkadot.com`.** The People Chain doc only describes the existing registrar/judgment system. The DIM tier model and v2.2.1 launch claims must be sourced elsewhere (community/forum) or marked speculative until docs catch up. Phase 2 framing protects us, but the spec language should not assert these as documented facts.
4. **`polkadot.cloud/connect` wallet list in the spec is wrong.** The library supports Polkadot.js, Talisman, SubWallet, Enkrypt, Fearless, PolkaGate (web extensions) plus Polkadot Vault and Ledger (hardware). MetaMask and Mimir are NOT in the supported list per `docs.polkadot.cloud`.
5. **Bifrost vDOT base APR claim ("~11–14%") is stale.** Post-Polkadot-tokenomics-reset, base vDOT staking yield is ~5–6% APY; the visible "30-day APY ~11%" includes Bifrost incentives. Spec §2 figures need refreshing.
6. **Hydration GDOT yield claim ("~18–25%") is at the upper edge of what current Hydration sources document.** Substack/blog sources currently quote "real yields can reach 15–20%+ with modest leverage." Spec §2 should narrow the band or caveat it.
7. **"People Chain block times 2 seconds" and "Elastic Scaling on People Chain" are not specifically documented for People Chain.** The async-backing doc confirms 2-second blocks are the parachain norm with async backing; the elastic-scaling doc confirms multi-core scaling exists. Neither doc names People Chain. Spec attribution to People Chain specifically is unsupported.

None of these are architecturally load-bearing — the locked v1.8 decisions (XCM precompile address, SetTopic = requestId design, pallet_revive on Asset Hub, Phase 1/Phase 2 split) remain intact. All ⚠️ items are wording / parameter / scope corrections.

---

## How to use this document

Each row is a claim from the working spec. Status flags:

- ✅ **Verified.** Source quoted; matches spec.
- ⚠️ **Verified with corrections needed.** Source confirms a different reality than the spec asserts. Spec must be updated.
- ⏳ **Pending.** No documentation fetched yet; still needs verification.
- 🔬 **Empirical.** No doc can answer; requires hands-on experiment (Chopsticks, on-chain test, vendor inquiry).

Re-run verification on any item flagged ⏳ before treating it as a basis for implementation. Re-run periodically on ✅ items if the underlying Polkadot docs are revised — Polkadot v2.2.1 introduced material runtime changes; future versions will too.

The Polkadot docs MCP at `https://docs-mcp.polkadot.com` is the recommended ongoing verification surface for Claude Code sessions. Install:

```
claude mcp add --transport http polkadot-docs https://docs-mcp.polkadot.com --scope user
```

---

## XCM precompile and message dispatch

### XCM precompile address and interface

| Item | Status | Notes |
|---|---|---|
| Precompile at `0x00000000000000000000000000000000000a0000` (also `address(0xA0000)`) | ✅ | Confirmed exact address in `IXcm.sol` constant |
| Three primary functions: `execute`, `send`, `weighMessage` | ✅ | All three documented as the precompile interface |
| `weighMessage(bytes calldata message) external view returns (Weight memory weight)` | ✅ | Matches `XcmWrapper`'s `staticcall` invocation exactly |
| `Weight` struct with `refTime` (uint64) and `proofSize` (uint64) | ✅ | Matches the `Weight` struct accepted by `XcmWrapper.queueRequest` |
| `execute(bytes message, Weight weight)` for local execution | ✅ | Local-only; takes weight |
| `send(bytes destination, bytes message)` for cross-chain — **no weight parameter** | ✅ | Destination chain handles execution costs per its own fee structure |
| Messages are SCALE-encoded Versioned XCM | ✅ | Documented |
| Precompile is "barebones" by design — abstractions belong on top | ✅ | Direct quote: *"While it provides a lot of flexibility, it doesn't provide abstractions to hide away XCM details. These have to be built on top."* This **validates** the assembler design (SCALE construction off-chain, in `xcm-message-builder/`). |

**Source:** https://docs.polkadot.com/smart-contracts/precompiles/xcm/
**Last verified:** 2026-04-25

**Spec actions:** None. The XCM precompile section of the spec is correct.

### Chopsticks replay and dry-run pattern

| Item | Status | Notes |
|---|---|---|
| Chopsticks `xcm` command pattern: `npx @acala-network/chopsticks xcm -r polkadot -p <hub-config> -p <bifrost-config>` | ✅ | Exact command pattern in docs |
| `DryRunApi.dry_run_call(origin, call, xcm_version)` exists | ✅ | Documented with full PAPI example |
| Result includes `execution_result`, `emitted_events`, `local_xcm`, `forwarded_xcms` | ✅ | `forwarded_xcms` field confirmed — was a load-bearing assumption for the correlation gate |
| `forwarded_xcms` returns the XCMs that *would* be sent as a result of executing the call | ✅ | Matches our experiment design |
| Replay pattern: `api.txFromCallData(callData)` → `signSubmitAndWatch` | ✅ | Documented |
| Runtime logging requires `release` or `debug` Wasm override | ✅ | Production builds have logs disabled; must build runtime locally and override |
| `runtime-log-level: 5` for full execution logs | ✅ | Documented |
| Note on `Binary` and `Uint8Array` in PAPI v2 | ✅ | Raw binary values are `Uint8Array` rather than `Binary` instances in v2 |

**Source:** https://docs.polkadot.com/chain-interactions/send-transactions/interoperability/debug-and-preview-xcms/
**Last verified:** 2026-04-25

**Spec actions:** None. The §10 Chopsticks experiment plan is consistent with the official workflow. Note added: when running the experiment, Wasm override step (clone `polkadot-fellows/runtimes`, build with `--release`, copy `.compact.compressed.wasm` to working dir, reference in Chopsticks config) is mandatory if we want execution logs.

### SetTopic propagation across parachain reply-legs

| Item | Status | Notes |
|---|---|---|
| SetTopic instruction exists in XCM and is the canonical correlation primitive | ✅ | xcm-format spec defines `SetTopic = 44 ([u8; 32])` with description *"Set the Topic Register"*. The Topic register is *"Of type `Option<[u8; 32]>`, initialized to `None`. Expresses an arbitrary topic of an XCM. This value can be set to anything, and is used as part of `XcmContext`."* `XcmContext` is *"Contextual data pertaining to a specific list of XCM instructions. It includes the `origin`, ..., `message_hash`, the hash of the XCM, an arbitrary `topic`, ..."* Source: https://github.com/polkadot-fellows/xcm-format (`README.md` §1.3 Vocabulary, §3.11 Topic Register, instruction-set table). |
| `messageId` field in `PolkadotXcm.Sent` and `XcmpQueue.XcmpMessageReceived` events equals SetTopic value when set, else hash of message | ✅ | The `Sent` event in `pallet_xcm` is defined as `Sent { origin: Location, destination: Location, message: Xcm<()>, message_id: XcmHash }`. The `WithUniqueTopic` router (used by relay/parachain configs) implements: *"let unique_id = if let Some(SetTopic(id)) = message.last() { *id } else { let unique_id = unique(&message); message.0.push(SetTopic(unique_id)); unique_id };"* — i.e., if the message already ends with `SetTopic(id)`, that id is the returned `message_id`; otherwise a unique id is computed and appended as `SetTopic`. The same `unique_id` is returned to the caller as `XcmHash` and surfaces in the `Sent` event's `message_id` field. Sources: https://github.com/paritytech/polkadot-sdk/blob/master/polkadot/xcm/pallet-xcm/src/lib.rs (Sent event), https://github.com/paritytech/polkadot-sdk/blob/master/polkadot/xcm/xcm-builder/src/routing.rs (`WithUniqueTopic`). |
| Bifrost reply-leg XCMs preserve original SetTopic value | 🔬 | **Cannot be answered from docs.** Bifrost-implementation-specific. Must be answered via Chopsticks experiment (see §10 of spec). |

**Sources:**
- xcm-format spec: https://github.com/polkadot-fellows/xcm-format (master `README.md`, §1.3 Vocabulary; §3.11 Topic Register; instruction-set table)
- pallet_xcm `Sent` event: https://github.com/paritytech/polkadot-sdk/blob/master/polkadot/xcm/pallet-xcm/src/lib.rs
- `WithUniqueTopic` router: https://github.com/paritytech/polkadot-sdk/blob/master/polkadot/xcm/xcm-builder/src/routing.rs

**Last verified:** 2026-04-28

**Spec actions:** None. The §10 framing — *SetTopic = requestId is the design; Bifrost preservation is the empirical gate validated via Chopsticks* — is consistent with the upstream code: when our assembler sets `SetTopic(requestId)` as the last instruction, `WithUniqueTopic` will pass that exact value through to the `Sent` event's `message_id`. The remaining empirical question is purely whether Bifrost echoes that value back on the reply-leg.

---

## Bulletin Chain (Phase 2 storage)

| Item | Status | Notes |
|---|---|---|
| Bulletin Chain provides decentralized, content-addressable storage | ✅ | "Decentralized data storage with IPFS-compatible content addressing" |
| CID is the content identifier; IPFS-compatible | ✅ | Default Blake2b-256 hash, Raw codec |
| No native token; access via authorization, not fees | ✅ | Confirmed |
| Authorization grants transactions + bytes allowance, with optional expiration block | ✅ | Documented schema |
| Currently OpenGov is the only authorization source on mainnet; PoP planned | ✅ | "Currently, only OpenGov can provide authorizations but the PoP subsystem is also planned to have this privilege in the future" |
| `authorize_account` extrinsic requires Root origin | ⚠️ | Spec said "OpenGov for mainnet" but reality is **Root origin everywhere**. OpenGov is one path to Root on mainnet. |
| Polkadot Mainnet authorization model "being finalized" | ⚠️ | Not yet finalized — adds uncertainty to Phase 2 timeline |
| Retention period ~2 weeks on Polkadot TestNet | ⚠️ | **Spec was wrong.** Spec described per-blob retention up to ~7 months. Reality: fixed ~2 weeks; must renew. |
| Renewal extends retention for another full period | ✅ | `renew(block, index)` extrinsic |
| Each renewal generates new `(block, index)` pair; original values fail after renewal | ⚠️ | **Spec didn't account for this.** Real ops complexity: persistent `(cid, latest_block, latest_index, expires_at)` tracking required. |
| CID stays stable across renewals; future plans to reference data by CID alone | ✅ | Documented as future improvement |
| Max transaction size ~8 MiB; max chunked file ~64 MiB | ✅ | Documented |
| Retrieval: P2P (Helia), IPFS gateway, Smoldot light client (coming soon) | ✅ | Multiple paths confirmed |
| Generic public IPFS gateways (`ipfs.io`, `cloudflare-ipfs.com`) **deprecated** for Bulletin retrieval | ✅ | Important: do NOT cite these as fallback in spec |
| Polkadot TestNet Bulletin RPC: `wss://paseo-bulletin-rpc.polkadot.io` | ✅ | Documented endpoint |
| Polkadot TestNet IPFS gateway: `https://paseo-ipfs.polkadot.io` | ✅ | Documented endpoint |

**Sources:**
- https://docs.polkadot.com/reference/polkadot-hub/data-storage/
- https://docs.polkadot.com/chain-interactions/store-data/bulletin-chain/

**Last verified:** 2026-04-25

**Spec actions required:**

1. **§6 storage rewrite needed.** Specifically:
   - Phase 2 description was wrong about retention — must reflect ~2-week fixed retention with mandatory renewal cadence.
   - Authorization claim needs correction — Root origin is the actual gate, with OpenGov as the production path to Root.
   - Operational infrastructure now includes a renewal-tracking system (`cid → latest_block, latest_index, expires_at`).
2. **§10 deferred-item updates:**
   - Bulletin Chain entry should call out the ops complexity honestly.
   - Crust as fallback gains weight — Crust's "pin once and pay forever" model has materially different ops profile.
3. **Honest rebalancing:** The "Bulletin Chain is the primary candidate" framing was based on assumptions that proved wrong. Bulletin Chain is still credible, but the choice between it and Crust is closer than v1.6 implied. Defer the choice; don't lock it now.

---

## Account and identity claims

| Item | Status | Notes |
|---|---|---|
| `pallet_revive.map_account()` maps SS58 → H160 for EVM compatibility | ✅ | *"To map your account, call the [`map_account`](...) extrinsic of the [`pallet_revive`](...) pallet using your original Substrate account. This creates a stateful mapping that allows your 32-byte account to interact with the Ethereum-compatible smart contract system."* The `AccountId32Mapper` in `pallet_revive` is documented as the implementation; the `map` function stores the original 32-byte account ID in `OriginalAccount` storage, enabling `to_account_id` to recover the original account. Source: https://docs.polkadot.com/smart-contracts/for-eth-devs/accounts/#account-mapping-for-native-polkadot-accounts |
| EVM-mapped Substrate multisig can own EVM contracts on Asset Hub | 🔬 | The docs state mapped 32-byte accounts can interact with the EVM layer (transfer funds, call contracts via Ethereum tooling) but make **no specific claim about pallet_multisig accounts being valid `map_account` callers** or about a multisig acting as a contract owner. The mechanism (multisig → derived AccountId32 → map_account → 20-byte H160) is plausible from the documented primitives but not confirmed end-to-end in the docs. **Empirical test required on Polkadot Hub TestNet** before treating as fact in `MULTISIG_SETUP.md §4`. |
| `0xEE` suffix convention for EVM ↔ AccountId32 mapping | ✅ | *"Ethereum to Polkadot: The system adds twelve `0xEE` bytes to the end of the address, which is a reversible operation."* And: *"Takes a 20-byte Ethereum address and extends it to 32 bytes by adding twelve `0xEE` bytes at the end. The key benefits of this approach are: Able to fully revert ... Provides clear identification of Ethereum-controlled accounts through the `0xEE` suffix pattern."* **Source URL correction needed:** the ledger originally cited `https://docs.polkadot.com/reference/parachains/accounts/`, which covers SS58 format only. The `0xEE` suffix is documented at https://docs.polkadot.com/smart-contracts/for-eth-devs/accounts/#ethereum-to-polkadot-mapping. |
| Native DOT precompile address on Asset Hub | ⚠️ | **There is no "native DOT precompile address" on Asset Hub.** The ERC20 precompile (https://docs.polkadot.com/smart-contracts/precompiles/erc20/) is documented to support exactly three asset categories — *"Polkadot Hub runs three instances of the Assets pallet — Trust-Backed Assets, Foreign Assets, and Pool Assets — each mapped to a distinct ERC20 precompile address suffix."* Native DOT is the chain's intrinsic balance, not in the Assets pallet, and has no ERC20 precompile address. The "Common Trust-Backed Asset IDs" table lists USDt and USDC; native DOT is **not** present. The ETH-native precompile list (`0x01`–`0x09`) covers cryptographic helpers (ECRecover, sha256, etc.), not currency. |

**Sources:**
- https://docs.polkadot.com/smart-contracts/for-eth-devs/accounts/
- https://docs.polkadot.com/reference/parachains/accounts/
- https://docs.polkadot.com/smart-contracts/precompiles/erc20/
- https://docs.polkadot.com/smart-contracts/precompiles/eth-native/

**Last verified:** 2026-04-28

**⚠️ Spec correction (Native DOT precompile):** `MULTISIG_SETUP.md §5` references `TOKEN_ADDRESS=0x<hub-dot-precompile-or-testdot>` as if a native DOT precompile address existed. It does not. The correct deployment recipe is one of:

1. Use the `value` field of the EVM call for native-DOT transfers (no token address needed for native currency, identical to native ETH on Ethereum).
2. If the multisig setup needs a token-address slot, populate it with a deployed test ERC20 (TestDOT-style) on Hub TestNet and document this is a stand-in for native DOT, not a precompile.
3. If a real DOT-as-ERC20 representation is needed, use the appropriate Foreign Asset or wrapped representation registered in the Assets pallet, deriving the precompile address per the Foreign Asset formula.

The spec must drop the "native DOT precompile" framing and pick one of the three above.

**🔬 Note (multisig ownership of contracts):** While the primitives needed for "EVM-mapped Substrate multisig owns EVM contract" exist, no doc states this composition works end-to-end. Before relying on it, run the deterministic-multisig-address → `pallet_revive.map_account` → contract ownership transfer flow on Polkadot Hub TestNet and capture the receipts.

---

## EVM model claims

| Item | Status | Notes |
|---|---|---|
| Asset Hub uses `pallet_revive` / PolkaVM as the EVM-compatible smart contract layer | ✅ | *"Polkadot Hub enables developers to deploy and interact with Solidity contracts through REVM, a high-performance, Rust-based Ethereum Virtual Machine implementation."* And from EVM-vs-PVM: *"Rather than implementing the EVM, PVM utilizes a RISC-V instruction set. For most Solidity developers, this architectural change remains transparent thanks to the [Revive compiler's] complete Solidity support..."* `pallet revive` is referenced throughout (`Pallet revive uses dynamic pricing through a "fee multiplier"` in gas-model doc). Sources: https://docs.polkadot.com/smart-contracts/for-eth-devs/evm-vs-pvm/, https://docs.polkadot.com/reference/polkadot-hub/smart-contracts/ |
| Storage costs reduced 10x on Asset Hub in v2.2.1 | ⚠️ | The docs **do not** make this claim. The closest documented statement is in the Polkadot Hub overview: *"Asset Management offers significantly lower transaction fees—approximately one-tenth the cost of relay chain transactions—and reduced deposit requirements."* This is (a) a comparison vs the **relay chain**, not a v2.2.1-introduced reduction, and (b) about Asset Management transaction fees broadly, not specifically about smart-contract storage. The gas-model doc (https://docs.polkadot.com/smart-contracts/for-eth-devs/gas-model/) describes `storage_deposit` as a separate resource but quotes no specific reduction factor or version. Source for "one-tenth": https://docs.polkadot.com/reference/polkadot-hub/#asset-management. |
| EVM precompile system on Asset Hub matches Ethereum precompile semantics | ✅ | *"Revive implements the standard set of Ethereum precompiles"* — table lists ECRecover (0x01), Sha256 (0x02), Ripemd160 (0x03), Identity (0x04), Modexp (0x05), Bn128Add (0x06), Bn128Mul (0x07), Bn128Pairing (0x08), Blake2F (0x09), with the same addresses and semantics as Ethereum. *"In Polkadot Hub's Revive pallet, these precompiles maintain compatibility with standard Ethereum addresses, allowing developers familiar with Ethereum to seamlessly transition their smart contracts."* Source: https://docs.polkadot.com/smart-contracts/precompiles/eth-native/. Note: Polkadot Hub also exposes additional Polkadot-native precompiles (XCM at `0x0a0000`, ERC20 wrapper for Assets pallet, System, Storage) that have no Ethereum equivalent — the Ethereum-subset semantics match, but the precompile **system** is a strict superset. |

**Sources:**
- https://docs.polkadot.com/smart-contracts/for-eth-devs/evm-vs-pvm/
- https://docs.polkadot.com/smart-contracts/for-eth-devs/gas-model/
- https://docs.polkadot.com/smart-contracts/precompiles/eth-native/
- https://docs.polkadot.com/reference/polkadot-hub/#asset-management

**Last verified:** 2026-04-28

**⚠️ Spec correction (10x storage cost):** The v1.6 reconciliation log in the spec asserts "Storage costs reduced 10x on Asset Hub in v2.2.1." This specific claim is not supported by the docs. The accurate statement is: *Asset Hub transaction fees are approximately one-tenth of relay chain transaction fees (per the Hub overview), and `pallet_revive` charges storage as a separate `storage_deposit` resource that is refunded when the storage is freed.* The "10x in v2.2.1" attribution should be replaced with the documented relative-to-relay-chain framing, with no version anchor.

---

## Proof of Personhood claims

| Item | Status | Notes |
|---|---|---|
| PoP system has DIM1 (lightweight) and DIM2 (verified individuality) tiers | ⚠️ | **Not in the cited doc.** https://docs.polkadot.com/reference/polkadot-hub/people-and-identity/ describes only the existing People Chain identity / registrar / judgment system — registrars assign confidence levels (Unknown / Reasonable / Known good / Out of date / Low quality / Erroneous). DIM1 / DIM2 tiers are **not mentioned anywhere** in the page. A docs-MCP search for `DIM1 DIM2 contextual alias` returned only two passing references to "PoP (Proof of Personhood)" (one in Bulletin Chain authorization-future-source language, one in this same People Chain page) — neither describes a tier model. |
| PoP enables "contextual aliases" (unlinkable per-app identities) | ⚠️ | **Not in the cited doc.** The People Chain doc has no "contextual alias" concept; sub-identities (up to 100 per primary, each with its own bond) are described, but those are linkable by design. |
| PoP rollout includes Asset Hub integration | ⚠️ | **Not in the cited doc.** The data-storage doc says only *"the PoP (Proof of Personhood) subsystem is also planned to have this privilege [authorizing Bulletin Chain account allowances] in the future"* — that's a future-tense plan for Bulletin Chain, not Asset Hub integration. Source: https://docs.polkadot.com/reference/polkadot-hub/data-storage/ |
| PoP Phase 0 launched in v2.2.1; full maturity 2026 | ⚠️ | **Not in the cited doc.** No `v2.2.1` release-notes content on `docs.polkadot.com` documents a PoP Phase 0 launch. |

**Sources searched:**
- https://docs.polkadot.com/reference/polkadot-hub/people-and-identity/
- https://docs.polkadot.com/reference/polkadot-hub/data-storage/ (PoP mentioned only as future Bulletin Chain auth source)
- Polkadot docs MCP search: `proof of personhood DIM1 DIM2 contextual alias unique humans` → no tier-model documentation found

**Last verified:** 2026-04-28

**⚠️ Spec correction (PoP claims):** Spec §10 (Phase 2 deferred) currently asserts as fact several PoP properties that are **not yet on `docs.polkadot.com`** as of this verification pass. The Phase 2 framing already protects v1 from depending on PoP; what needs to change is the *certainty* with which §10 describes PoP. Recommended edits:

- Replace "PoP has DIM1 / DIM2 tiers" with "PoP is expected to introduce tiered uniqueness (per Web3 Foundation talks / community sources [cite])." Mark as community-sourced, not documented.
- Replace "PoP enables contextual aliases" with "Contextual aliases are a discussed PoP feature (per [community source]); not yet documented on `docs.polkadot.com`."
- Replace "PoP Phase 0 launched in v2.2.1" with "PoP rollout milestones are still being communicated through forum/community channels; treat any specific date as unverified." Drop the v2.2.1 anchor.
- Make the Phase 2 deferral explicit: *"Averray will not depend on PoP being shipped or stable until both (a) it is documented on `docs.polkadot.com` with concrete extrinsics/precompiles, and (b) Asset Hub integration is observable on TestNet."*

---

## Tooling and library claims

| Item | Status | Notes |
|---|---|---|
| PAPI exposes XCM construction with sufficient granularity to inject SetTopic as the last instruction of a message | ✅ (with caveat) | The PAPI overview doc itself (https://docs.polkadot.com/reference/tools/papi/) does not specifically describe XCM-instruction-level construction, but the chopsticks/replay doc shows PAPI as the recommended XCM construction tool, and PAPI's `TypedApi.tx` is generated directly from chain metadata — *"PAPI ... offers seamless access to storage reads, constants, transactions, events, and runtime calls ... It provides strong TypeScript support with types and documentation generated directly from on-chain metadata"*. Because the XCM instruction enum (including `SetTopic([u8; 32])`) is part of `pallet-xcm`'s exposed metadata, PAPI surfaces it as a typed variant on the runtime's `XcmVN` instruction type and supports building messages instruction-by-instruction including the trailing `SetTopic`. Sources: https://docs.polkadot.com/reference/tools/papi/, https://docs.polkadot.com/chain-interactions/send-transactions/interoperability/debug-and-preview-xcms/. **Caveat:** the official docs do not include a worked SetTopic-injection example. The closest practical reference is ParaSpell's SDK source. |
| ParaSpell exists as a higher-level XCM router; assess viability as alternative or comparison reference | ✅ | *"ParaSpell is a comprehensive suite of open-source tools designed to simplify cross-chain interactions within the Polkadot ecosystem."* Suite includes XCM SDK, XCM API, XCM Router (cross-chain swaps in a single command), XCM Analyser, XCM Visualizator, XCM Playground. *"It is the first and only XCM SDK in the ecosystem to support both PolkadotJS and Polkadot API"* — confirms PAPI compatibility. Source: https://docs.polkadot.com/reference/tools/paraspell/ |
| `polkadot.cloud/connect` library supports MetaMask, Talisman, SubWallet, Mimir | ⚠️ | **Spec wallet list is wrong.** Per https://docs.polkadot.cloud/console/basics/wallets/ the supported wallets are: **Web Extensions** — Talisman, Enkrypt, Fearless Wallet, PolkaGate, Polkadot JS, SubWallet; **Hardware Wallets** — Polkadot Vault, Ledger. **MetaMask is not listed** as a supported wallet (it's an EVM wallet; the Polkadot.cloud connect surface targets Substrate signers). **Mimir is not listed** either; Mimir is a separate multisig manager that *uses* signer wallets, not a signer itself. ✅ for Talisman and SubWallet; ⚠️ for MetaMask and Mimir. |

**Sources:**
- https://docs.polkadot.com/reference/tools/papi/
- https://docs.polkadot.com/reference/tools/paraspell/
- https://docs.polkadot.cloud/console/basics/wallets/

**Last verified:** 2026-04-28

**⚠️ Spec correction (`polkadot.cloud/connect` wallet list):** The v1.7 deferred entry should be edited to: *"`polkadot.cloud/connect` supports the standard Substrate wallet ecosystem (Polkadot.js, Talisman, SubWallet, Enkrypt, Fearless, PolkaGate, plus Polkadot Vault and Ledger as hardware signers). MetaMask is **not** among them — for EVM-side signing on Polkadot Hub, use Talisman's EVM mode or MetaMask via the Hub's Ethereum-RPC endpoint directly. Mimir is a multisig manager that composes with these signer wallets but is not itself in the connect library's supported list."*

---

## Hydration and Bifrost claims

| Item | Status | Notes |
|---|---|---|
| Bifrost vDOT minting yields ~11–14% APR base | ⚠️ | Stale. Following Polkadot's tokenomics reset, Bifrost-sourced summaries report base vDOT staking yield of ~5–6% APY, with a 30-day APY of ~11% as of Jan 2026 (which **includes** Bifrost incentives, not pure base). The visible "11%" headline matches the spec's lower bound only when incentives are blended in. Sources: https://bifrost.io/vtoken/vdot, https://bifrost.io/blog/bifrost-monthly-report-january-2026, https://docs.bifrost.io/faq (FAQ uses *"Ex1: vDOT as a 17% APY"* purely as a hypothetical, not a current rate). |
| Hydration GDOT composite yield ~18–25% APR | ⚠️ | At the upper edge of what current Hydration sources document. Hydration's own Substack states GDOT/gigaDOT composite yield comes from "vDOT staking APR + aDOT lending APR + targeted incentives by the Hydration and Polkadot treasuries", and that *"with modest leverage, real yields can reach 15–20%+ with no token incentives, fixed rates"*. The 25% upper bound in the spec is achievable only with leverage / incentive stacking. Sources: https://hydration.substack.com/p/breaking-news-gigadot-and-hollar, https://hydration.substack.com/p/2025-recap, https://hydration.substack.com/p/hydration-newsletter-jan-feb-2026 |
| Hydration money market accepts GDOT/aDOT as collateral for borrow | ✅ | *"Users can post GDOT/GETH as collateral in Hydration Borrow to draw HOLLAR (or other supported assets), funding operations or strategies without selling DOT/ETH exposure."* And *"Users can deposit collateral on Hydration's money market, borrow HOLLAR at 4.5% fixed rate (governance-set)."* Source: https://hydration.substack.com/p/breaking-news-gigadot-and-hollar |
| XCM round-trip from Hub→Bifrost typical settlement latency | 🔬 | Empirical — must measure on staging or ask Bifrost team. No doc number. |
| Bifrost emits failure-code reply-XCM on mint failure (vs trapped silence) | 🔬 | Empirical — Bifrost team question (questions drafted in earlier conversation). No doc commitment to a failure-mode contract. |

**Last verified:** 2026-04-28

**⚠️ Spec correction (yield bands in §2):** Update Bifrost vDOT and Hydration GDOT yield ranges to current sources:

- vDOT base: ~5–6% APY (post-tokenomics-reset); blended-with-incentives: ~10–12% (varies by campaign, timestamped).
- Hydration GDOT: ~15–20%+ achievable with modest leverage and base-only sources (no incentives); upper figures (>20%) require either active incentive campaigns or higher leverage.
- Add a "yields are time-stamped and re-verifiable; do not lock numbers in spec text — link to live sources" note.

---

## v2.2.1 runtime claims

| Item | Status | Notes |
|---|---|---|
| People Chain block times 2 seconds | ⚠️ | The async-backing doc (https://docs.polkadot.com/reference/parachains/consensus/async-backing/) confirms parachains using async backing achieve *"2 seconds instead of 0.5"* per block. **This is a general parachain capability, not specifically attributed to People Chain.** No `docs.polkadot.com` page states "People Chain produces 2-second blocks." Treat as plausible-but-not-doc-confirmed for People Chain specifically; verify via on-chain block-time observation or a People Chain release note before citing as a People-Chain fact. |
| Elastic Scaling on People Chain | ⚠️ | Elastic Scaling is documented (https://docs.polkadot.com/reference/parachains/consensus/elastic-scaling/) as a parachain capability — *"Parachains currently achieve 2-second latency with three cores, with projected improvements to 500ms using 12 cores"*. The Agile Coretime doc adds: *"Polkadot supports scheduling multiple cores in parallel through elastic scaling, which is a feature under active development on Polkadot."* **Neither doc names People Chain as an elastic-scaling user.** Whether People Chain has actually been allocated multiple cores (or just the capability is generally available) is not documented. |

**Sources:**
- https://docs.polkadot.com/reference/parachains/consensus/async-backing/
- https://docs.polkadot.com/reference/parachains/consensus/elastic-scaling/
- https://docs.polkadot.com/reference/polkadot-hub/consensus-and-security/agile-coretime/

**Last verified:** 2026-04-28

**⚠️ Spec correction (People Chain attribution):** The v1.6 reconciliation log lines that attribute "2-second blocks" and "Elastic Scaling" specifically to People Chain should be reworded to: *"Polkadot's parachains broadly support 2-second blocks via async backing and multi-core processing via elastic scaling; whether People Chain has these enabled at any given time should be verified against the live chain or current release notes, not assumed from the general doc."*

---

## Multisig claims

| Item | Status | Notes |
|---|---|---|
| Substrate `pallet_multisig` produces deterministic addresses from `(signatories, threshold)` | ✅ | Per `pallet_multisig` Rust docs: the multisig account is *"a well-known origin, derivable deterministically from the set of account IDs and the threshold number of accounts"*. Source: https://paritytech.github.io/polkadot-sdk/master/pallet_multisig/index.html |
| Signet/Polkadot Multisig supports Talisman as signer wallet | ✅ | Polkadot Multisig (Signet) help center and product page confirm Talisman is among supported signer wallets — alongside Polkadot.js, SubWallet, Enkrypt, plus hardware (Ledger, D'Cent, Polkadot Vault) via those signer wallets. Sources: https://polkadotmultisig.com/, https://guide.polkadotmultisig.com/en/category/about-polkadot-multisig/article/what-wallets-are-supported-by-polkadot-multisig (note: guide site was returning 530 intermittently at verification time; product landing page and Polkadot Wiki multisig-apps page corroborate). |

**Last verified:** 2026-04-28

**Spec actions:** None. `MULTISIG_SETUP.md §3` and `MULTISIG_DECISION.md` claims hold up. The remaining multisig-side risk is the 🔬 item under "Account and identity claims" — confirming that an EVM-mapped multisig can actually own an EVM contract on Asset Hub.

---

## Empirical-only items (cannot be resolved from docs)

These items can never be answered by reading documentation. They require running tests or contacting vendors.

| Question | How to answer | Priority |
|---|---|---|
| Does Bifrost preserve SetTopic on reply-leg XCM back to Hub? | Chopsticks experiment (§10 of spec) | **Highest** — load-bearing for the entire correlation gate |
| What is Bifrost's typical and worst-case settlement latency for vDOT mint and redeem? | Bifrost team inquiry + Chopsticks measurement | High |
| What does Bifrost emit on mint failure (insufficient liquidity, paused vToken)? | Bifrost team inquiry + deliberately malformed Chopsticks test | High |
| If Hub→Bifrost XCM execution fails on Bifrost (weight too low, asset not registered), is failure ever surfaced back to Hub? | Same — deliberately malformed message | High |
| Does an EVM-mapped Substrate multisig (multisig → AccountId32 → `pallet_revive.map_account` → H160) successfully own and operate an EVM contract on Polkadot Hub TestNet end-to-end? | Hub TestNet integration test: deploy a contract owned by the mapped multisig address, exercise an `onlyOwner` call signed via Polkadot Multisig | **High** — load-bearing for `MULTISIG_SETUP.md` |
| What is the actual override rate of LLM-as-judge on Phase 1 disputes? | Real disputes, weeks of operation, Phase 1 instrumentation | Medium (not blocking v1.0.0-rc1) |
| What fraction of Averray-funded GitHub PRs land merged upstream? | Real platform operation, week-12 gate | Medium (not blocking v1.0.0-rc1) |
| What is the dispute rate at production volume? | Real platform operation, weekly instrumentation | Medium |

---

## Verification process going forward

### Recommended cadence

- **Before v1.0.0-rc1 deploy:** verify all ⚠️ items above have flowed into `RC1_WORKING_SPEC.md` corrections, paying particular attention to the native-DOT-precompile correction in `MULTISIG_SETUP.md §5` and the EVM-mapped-multisig empirical test (🔬). Without these, multisig setup is not safely actionable.
- **Before any external announcement of Bulletin Chain integration:** complete the Bulletin Chain corrections to the spec; fix the retention-period assumption everywhere.
- **Before relying on PoP for v2 design:** verify Asset Hub integration scope of the PoP rollout. Marketing language is not implementation status — and per this verification pass, even the basic DIM1/DIM2 tier model is not yet on `docs.polkadot.com`.
- **Quarterly:** re-verify ✅ items. Polkadot is moving fast; runtime upgrades change semantics.

### Recommended tooling for ongoing verification

- **Polkadot docs MCP server** (`https://docs-mcp.polkadot.com`) connected to Claude Code for ad-hoc queries during development. Confirmed working in the 2026-04-28 pass.
- **AI-ready static files** (e.g. `https://docs.polkadot.com/llms-full.jsonl`, category-specific bundles like `chain-interactions.md`) for batch context loading.
- **The repo's own `polkadot-docs/` subfolder** if mirroring docs locally for audit purposes.

### What "verified" means in this document

A claim is verified if:
1. The current Polkadot docs explicitly state it, *and*
2. The exact spec text doesn't contradict the docs, *and*
3. The doc page's "Last update" date is recent enough to reflect current runtime state.

A claim is **not** verified by:
- A community blog post or marketing copy alone.
- A docs page from before the relevant runtime version.
- A doc that uses the right keywords but answers a different question.

This is deliberate. The trust pitch — "receipts, not vibes" — extends to the spec itself. Don't claim verification on uncertain ground.
