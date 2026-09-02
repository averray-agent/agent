# serviceOperators Role-Split — Design

**Status:** proposal for review. **Owners:** contracts = Codex · backend = Claude · key provisioning = Pascal/ops.
**Why now:** audit-2's top architectural finding is the single overloaded `serviceOperators` role. It is
also the **gate that must land before a finite `DAILY_OUTFLOW_CAP` can be armed** (audit-2 H-1) and it is
where the **Finding-2 slash-evasion** is resolved. None of this requires a redesign — it is a role
decomposition + a small metering tweak, landing in the same fresh redeploy the audit-2 fixes already need.

---

## 1. Problem — one role gates five unrelated concerns

`TreasuryPolicy.serviceOperators` (a single owner-settable `mapping(address=>bool)`) is currently checked by
**six contracts**. Grounded inventory of every `serviceOperators`-gated entrypoint on current `main`:

| Concern | Contract · function(s) | Current gate |
|---|---|---|
| **Escrow-loop brokering** | `EscrowCore`: `claimJobFor`, `submitWorkFor`, `openDisputeFor`, `createSinglePayoutJobFromRecurringReserve`, `setOnboardingWaiverEligible` | `onlyOperator` = `serviceOperators` |
| **Account brokering** | `AgentAccountCore` (operator leg of `onlyOwnerOrOperator`): `reserveForJob`, `reserveForRecurringTemplate`, `cancelRecurringTemplateReserve`, `allocateIdleFunds`, `deallocateIdleFunds` | account **or** `serviceOperators` |
| **Agent value transfer** | `AgentAccountCore`: `sendToAgentFor` | `onlyOperator` = `serviceOperators` |
| **Strategy / XCM settlement** | `AgentAccountCore`: `requestStrategyDeposit`, `requestStrategyWithdraw` (operator leg), `settleStrategyRequest`; `XcmWrapper`: `queueRequest`, `finalizeRequest`; `XcmVdotAdapter`: `settleRequest` | `serviceOperators` (or owner\|operator on XcmWrapper) |
| **Reputation writes** | `ReputationSBT`: `mintBadge`, `updateReputation`, `slashReputation` | `onlyOperator` = `serviceOperators` |
| **Outflow metering** | `TreasuryPolicy`: `recordOutflow` | `serviceOperators` (called **by AAC**, per L-2/C-03) |

**Consequence:** a single backend signer key spans escrow settlement + value transfer + the least-hardened
XCM path + reputation + the outflow breaker. A compromise of that one key is catastrophic, and — critically —
**any `serviceOperators` member can call `recordOutflow` directly** to inflate the meter and DoS all
settlement (audit-2 H-1). Arming a finite cap on top of this *widens* attack surface rather than adding
protection.

### Already separate (do NOT fold in — keep as-is)
`escrowOperators` (the `EscrowCore`↔`AAC` settlement path: `settleReservedTo`, `slashJobStake`,
`slashClaimFee`, `refundReserved`, `lockJobStake`, `releaseJobStake`, `consumeRecurringTemplateReserve`),
`verifiers`, `arbitrators`, `disclosurePublisher`, `owner`, `pauser`. These are already least-privilege and
out of scope for this split.

---

## 2. Proposed roles

Five owner-settable mappings on `TreasuryPolicy` replace the one `serviceOperators` mapping. Each has a
`set<Role>(address, bool) onlyOwner` setter and a public getter.

| New role | Held by (launch) | Gates (was `serviceOperators`) |
|---|---|---|
| **`settlementBroker`** | backend KMS signer | `EscrowCore.{claimJobFor, submitWorkFor, openDisputeFor, createSinglePayoutJobFromRecurringReserve, setOnboardingWaiverEligible}`; `AAC.{reserveForJob, reserveForRecurringTemplate, cancelRecurringTemplateReserve, allocateIdleFunds, deallocateIdleFunds}` (operator leg) |
| **`agentTransferBroker`** | backend KMS signer | `AAC.sendToAgentFor` — **isolated** because it moves value (MAIN-006 double-debit history) |
| **`strategySettler`** | XCM operator key — **empty at launch** (XCM vDOT disabled) | `AAC.{requestStrategyDeposit, requestStrategyWithdraw (operator leg), settleStrategyRequest}`; `XcmWrapper.{queueRequest, finalizeRequest}`; `XcmVdotAdapter.settleRequest` |
| **`reputationWriter`** | backend KMS signer | `ReputationSBT.{mintBadge, updateReputation, slashReputation}` |
| **`outflowRecorder`** | **`AgentAccountCore` contract — NEVER an EOA** | `TreasuryPolicy.recordOutflow` |

**Key least-privilege wins:**
- **`outflowRecorder` = the AAC contract only.** `recordOutflow` is invoked *internally* by AAC on `withdraw`
  / slash legs / external-recipient strategy withdrawal — never by a signer. Restricting it to AAC **closes
  the H-1 DoS vector**: no EOA can call `recordOutflow` to inflate the meter and brick settlement. This is the
  single most important change for making a finite cap safe.
- **`strategySettler` is isolated** — the least-hardened value path (operator-supplied settle amounts, M-4/M-5)
  can't reach escrow, reputation, or transfers. Empty at launch since XCM vDOT is disabled.
- **`agentTransferBroker` isolated** from the escrow loop so a settlement-broker compromise can't move agent
  value.
- `settlementBroker` (the normal claim→submit→settle loop) can't write reputation, settle strategy, move
  agent value, or record outflow.

**Ops choice (flag for Pascal):** at launch the same KMS signer may hold `settlementBroker` +
`agentTransferBroker` + `reputationWriter` (one backend identity) — but as **separate roles** so they can be
split onto distinct keys or rotated independently later without a redeploy. `strategySettler` is a distinct
key (or empty). `outflowRecorder` is the AAC address.

---

## 3. Finding-2 (slash-evasion) — bundled here

With per-account metering (shipped in #717), once a **finite** cap is armed a party could dodge its own slash
by first exhausting its daily meter via `withdraw`, making `slashJobStake`/`slashClaimFee` revert
`OutflowCapExceeded`. A penalty must not be blockable by the penalized party.

**Fix (lands with the split):** split `recordOutflow` into two `outflowRecorder`-gated entrypoints on
`TreasuryPolicy`:
- `recordOutflow(account, amount)` — **enforcing**: reverts on per-account cap breach. Called by
  `AAC.withdraw` and the external-recipient strategy-withdrawal egress (user-initiated egress).
- `recordProtocolOutflow(account, amount)` — **record-only**: updates the per-account + aggregate meter for
  observability but **never reverts**. Called by the transferred legs of `slashJobStake` / `slashClaimFee`
  (protocol-initiated penalties).

Both remain `outflowRecorder`-only (= AAC). Net: user egress is capped; penalties are metered but
un-dodgeable and un-blockable.

---

## 4. Why this unblocks the finite cap

Arming a finite `DAILY_OUTFLOW_CAP` is safe **only after all three of these hold** — this split delivers the
first and third:

1. **No EOA can inject outflow** → `outflowRecorder` = AAC only (this split).
2. **One account's breach can't brick others** → per-account meter (already shipped, #717).
3. **Slashes are cap-exempt** → `recordProtocolOutflow` (this split, §3).

Only then set finite values in `docs/MAINNET_PARAMETERS.md` (currently `250 USDC`, held at
`type(uint256).max` per the ⛔ DO-NOT-ARM note). **Sequence: this split → finite cap. Not before.**

---

## 5. Migration — hard cutover in the pending redeploy

The audit-2 contract fixes already require a fresh redeploy (and the testnet is halted anyway), so a **hard
cutover** is cleanest — no `serviceOperators` back-compat shim:

- **`TreasuryPolicy`:** remove `serviceOperators` mapping + `setServiceOperator`; add the five role mappings +
  setters + getters. Update every modifier to read its specific role (`EscrowCore._onlyOperator` →
  `settlementBroker`; `AAC._onlyOperator` → the relevant role per function; `XcmWrapper.onlyOwnerOrOperator`
  → owner\|`strategySettler`; `ReputationSBT.onlyOperator` → `reputationWriter`;
  `XcmVdotAdapter.onlyOperator` → `strategySettler`; `TreasuryPolicy.recordOutflow*` → `outflowRecorder`).
- **Deploy script** (`redeploy-agent-account-escrow-stack.mjs`) provisions, then **asserts at finalize**
  (mirror the existing `treasuryAccount()` / AAC-serviceOperator assertions):
  - `setOutflowRecorder(newAAC, true)` — **required** or every settlement/slash reverts (this is the C-03/L-2
    dependency, now role-specific).
  - `setSettlementBroker(signer, true)`, `setReputationWriter(signer, true)`,
    `setAgentTransferBroker(signer, true)`.
  - `setStrategySettler(xcmKey, true)` — only if XCM is enabled (skip at launch).
  - Fail-closed finalize checks for `outflowRecorder(newAAC)` and `settlementBroker(signer)`.

---

## 6. Backend correlate (Claude's lane)

`gateway.js` and `audit-launch-readiness.mjs` currently probe `serviceOperators(...)`. After the cutover:
- **Health/readiness checks** re-point to the new roles for the right principal:
  `serviceOperators(agentAccount)` → **`outflowRecorder(agentAccount)`**; `serviceOperators(signer)` →
  **`settlementBroker(signer)`** (+ `reputationWriter(signer)`, `agentTransferBroker(signer)` if checked).
- **`abis.js`:** add the new role getters; `recordOutflow`'s ABI is unchanged externally (backend never calls
  it — AAC does), but if `recordProtocolOutflow` is added it needs no backend entry (internal to AAC).
- The KMS signer's `serviceOperators` assumption in any readiness gate is replaced by the role checks above.

This is a small, mechanical follow-on once Codex fixes the role names — I'll land it in the same window as the
contract PR, gated on the final role names.

## 7. Ops / Pascal
- Provision role members via the **owner (→ multisig)**: AAC→`outflowRecorder`; backend signer→
  `settlementBroker`+`reputationWriter`+`agentTransferBroker`; XCM key→`strategySettler` (if/when XCM on).
- This is also the natural moment to complete **owner → multisig** so role membership is multisig-gated.

---

## 8. Test plan (Foundry + backend)
- **Role isolation:** a holder of role A cannot call role B's entrypoints (e.g., a `settlementBroker` cannot
  `settleStrategyRequest`, `updateReputation`, `sendToAgentFor`, or `recordOutflow`).
- **`outflowRecorder` = AAC only:** any EOA (even `settlementBroker`) calling `recordOutflow` /
  `recordProtocolOutflow` reverts `Unauthorized`.
- **Finding-2:** an account that has exhausted its daily meter via `withdraw` is **still slashable** (slash
  legs use `recordProtocolOutflow`, never revert); a user `withdraw` past the cap still reverts.
- **Cap end-to-end:** with a finite cap set, one account's egress cap does not block another account's
  settlement, and settlement volume (book-moves) never trips it.
- **Backend:** readiness checks pass with the new role wiring; fail-closed if AAC lacks `outflowRecorder`.

---

## 9. Ownership & sequencing
1. **Codex (contracts):** the five roles + modifier rewrites + `recordProtocolOutflow` + deploy-script
   provisioning/assertions + Foundry tests. One PR (or two: roles+modifiers, then Finding-2 metering).
2. **Claude (backend):** re-point `gateway.js` / `audit-launch-readiness.mjs` health checks + `abis.js` role
   getters. Gated on Codex's final role names.
3. **Pascal/ops:** provision role keys via multisig; complete owner→multisig.
4. **Then, and only then:** arm a finite `DAILY_OUTFLOW_CAP` (`MAINNET_PARAMETERS.md`).

All of it is writable + Foundry/unit-testable now; only the on-chain redeploy waits on the Paseo halt.
