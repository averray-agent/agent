# PACKET — Rulings before the deadline: drafted rulings, one Sign all, deadline pushes, a weekly dry run, and outages that page

**Status:** ready for Codex, 2026-09-29. Author: Claude (architect + gate). Eleven PRs across two repos (platform `averray-agent/agent` and `averray-reference-agent`). No contract changes. No indexer changes. **Deadline:** PR 1 and PR 2 (phone channel and deadline reminders) must be live before **2026-10-03T18:00Z** (the reason is in the operator's private note). This packet contains no remedy for any open dispute.

**Public-repo rule (Codex, every PR).** This repo is public. PR titles and bodies say what changed and nothing more. PR titles, bodies, commit messages, code comments and fixture names never name live dispute ids, job ids, SLA status, balances or monitoring gaps. Fixtures use synthetic ids.

## Why (verified 2026-09-29 on origin/main 403a00f1, packets 1cec4b68, reference-agent 9c8e29b)

The incident timeline, open-dispute status, chain reads and on-box monitor detail are in the operator's private note. What follows is the code-level case for the design.

- **A ruling decided on the day a dispute opens exists only as Markdown.** The verdict convention (dismissed, full payout) is in `docs/ARBITRATION_FROM_APP_RUNBOOK.md:57-77`, and rationale texts are in runsheets on the packets branch. The system stores only `operatorOverturn.rationale` (`mcp-server/src/services/operator-overturn-service.js:48-56`). The app adapter reads `rationale` only for resolved disputes (`app/lib/api/dispute-adapters.ts:96-111`). It recomputes `origin` by substring over the JSON (`:94`, `:189-198`), so because every record contains `windowEndsAt`, unmatched records become `timeout`. It never reads `live`. The drawer therefore opens every dispute with an empty rationale (`app/components/disputes/DisputeDrawerBody.tsx:36`).
- **Signing from the app (#1380, 936aed53) is a per-dispute form.** Each dispute costs about 6 desktop clicks, a typed rationale of at least 20 characters, a checkbox that resets per dispute, Prepare and then Sign (`app/components/disputes/DecisionPanel.tsx:65-68`, `DisputeDrawerBody.tsx:48-60`). There is no batch mode, and the prepared call lives only in React state (`DisputeDrawerBody.tsx:43,59`).
- **The in-app path has never produced a signable call in production.** On 09-22 Prepare refused with 409 `arbitration_public_content_unavailable` because `PUBLIC_BASE_URL` was missing from the mainnet env template (`mcp-server/src/services/dispute-arbitration-service.js:64`). That was my gate miss: the tests injected the value and never read the rendered template. #1399 (af2a0905) fixed the template, and the deployed SHA contains it. Whether the rendered production env carries the value is unverified; D29 will show it.
- **`prepare` publishes before any signature.** It writes a public `arbitrator_reasoning` record with `decidedBy` = the preparer and `decidedAt` (`mcp-server/src/core/dispute-resolution.js:274-281`, `dispute-arbitration-service.js:72,75-76`). It returns an existing preparation early whenever `inputHash` matches (`:59-60`), and that happens after the claim lock (`:37-40`).
- **No surface counts down to the arbitrator deadline.**
  - The only dispute alert, `/alerts` "Dispute awaiting verdict", has no deadline, says "DOT" and "verifier verdict", and is also emitted for resolved disputes (`mcp-server/src/protocols/http/operator-activity-feed.js:192-202`).
  - `/health` carries no deadline signal (`mcp-server/src/protocols/http/operational-routes.js:157-171`).
  - Hermes treats Disputed as nothing to raise (`services/slack-operator/src/external-funnel.ts:259-266,306-308`). Its ops skill calls a disputed job fine (`hermes/skills/ops/averray-ops/SKILL.md:152-153`).
  - The app countdown turns amber only at ≤10% remaining, about 33.6 h (`app/components/disputes/WindowCountdown.tsx:46-49`). It counts from the local `session.disputedAt`, not from the chain (`mcp-server/src/protocols/http/dispute-routes.js:144-145`).
- **An outage does not reach a phone.** The off-box watchdog's only output is a public issue with no assignee and no page (`.github/workflows/external-uptime-watchdog.yml:75-111`). GitHub cron is best-effort, not 15-minute detection. Prior art `scripts/ops/check-hosted-stack-and-alert.sh` (`ALERT_WEBHOOK_URL`, `deploy/secrets-inventory.md:126`) runs on the VPS and posts to Slack, so it cannot page when the host is down.
- **The primary RPC loses logs.** Verified 2026-09-29: the primary manifest RPC (`deployments/mainnet.json:3`, also `RPC_URL`) omitted a v3 `DisputeOpened` log that the backup returns, even for a one-block range. Any enumeration from one provider is unsafe.
- **Structural defects the fix must remove:**
  - `GET /disputes` sees only the 100 most recently written sessions, and `findDispute`, which `prepare` also uses, sees only 250 (`dispute-routes.js:245-248,279-282,286-296`). The index is scored by last write (`mcp-server/src/core/state-store.js:1599-1602`), so an untouched dispute drops out of view, and out of prepare, as its deadline nears.
  - Worker-opened on-chain disputes never become local `disputed` (`mcp-server/src/core/session-state-machine.js:110-116`).
  - The 08-20 platform-fault remediation queue cannot be signed from the app and is hidden from `/disputes` (`dispute-routes.js:257-262`). Its status stays `awaiting_hardware_arbitrator` after an on-chain resolution: `converge()` never touches it, and only a re-run of remediate on a Closed escrow sets `resolved_on_chain` (`platform-fault-remediation-service.js:75-81`).
  - `converge()` records the verdict by payout ratio, so an `autoResolveOnTimeout` would appear as a "split" decided by whoever called it (`dispute-arbitration-service.js:102,110`).
  - `test:app` is not a CI gate, so the #1380 pins do not gate merges (`package.json:13`, `.github/workflows/ci.yml:202-222`).
  - The chain side has no batch path: EscrowCore has no multicall, and `onlyArbitrator` checks `msg.sender` (`contracts/EscrowCore.sol:244-247,285-287`, applied to `resolveDispute` at `:894-906`). "Sign all" is therefore N sequential transactions with N phone confirmations.

## Current open disputes

Open-dispute status, chain reads, the arbitrator's gas runway, the fallback for any dispute due before Sign all is live, and the incident detail are all in the operator's private note, not in this repo. Nothing in this packet depends on them. Before acting on any dispute, read `jobs(jobId).state` once; 6 means it is already closed.

## The fix

### 1. One list, one button: drafted rulings, "Rulings to sign (N)", "Sign all"

**Decision on drafting.** A draft is **not** a preparation. Drafts are stored unpublished. `prepare` runs only when Pascal taps Sign all, under his own admin session. Each ruling's text becomes public at that tap, one ruling at a time, immediately before its phone prompt, and it is published as a *proposed* ruling (D12b).

**Who drafts:**
- **Operator overturn.** Derived on read, with no backfill. Verdict is `dismissed`. Payout is the live `reward − released` as a concrete raw integer. The text is `operatorOverturn.ruling`, which is required on new overturns (D7) and is supplied by the overturn runsheet Claude writes. Legacy sessions without `ruling` fall back to `operatorOverturn.rationale` (`source: "overturn_rationale_legacy"`), and the row shows the badge "Internal overturn note reused as public text: review before signing".
- **Platform-fault remediation (08-20 queue).** The stored pre-computed resolution is the draft (`platform-fault-remediation-service.js:272-351`). Items marked `executable:false` are listed as "manual compensation, not signable".
- **Worker-opened disputes (none so far on v3).** A human judgment call. Claude writes the text on request, and Pascal stores it through the row's "Edit draft text" control (D20). `draftedBy` is kept internal. Hermes never drafts rulings. These items are listed and reminded, but not signable in the app in this packet.

**Auth rule for every new mutating path (D6a).** `PUT /admin/arbitration/:disputeId/draft`, `POST …/submitted`, `POST …/submitted/clear`, `POST …/prepare-remediation`, `POST /admin/arbitration/rehearsals`, and `POST /disputes/:id/prepare` (narrowed in 3b; update the #1380 tests) all check `hasRole(auth.claims, "admin")` in the handler. This follows the `dispute-routes.js:287` pattern with admin only and no verifier. They add **no** entry to `ROUTE_CAPABILITY_RULES` and **no** new capability string, so a capability grant cannot delegate them (the existing prepare route is not in that table either). Service tokens, viewers, verifiers and workers get 403.

**Env discipline.** 3a-0/3a/3b/3c read no new env var. They use `PUBLIC_BASE_URL` (`deploy/backend.mainnet.env.template:258`), `RPC_URL`/`RPC_BACKUP_URLS` (`:389-390`) and the manifest arbitrator (`mcp-server/src/blockchain/config.js:309`). If one becomes necessary, edit `deploy/backend.env.template` plus the generator and run `node scripts/ops/render-mainnet-backend-env.mjs --check`. Never hand-edit the generated mainnet template.

**Backend PR 3a-0 (clock, chain deadline, timeout label; lands within a day):**
- D1. New `mcp-server/src/core/arbitration-deadlines.js`, pure: `arbitrationClock({ chainDisputedAt, now })` → `{ targetRuleBy: D+3d, slaEndsAt: D+ARBITRATOR_SLA_SECONDS, secondsRemaining, stage }`. `stage` is one of `within_target | past_target | sla_7d | sla_3d | sla_1d | sla_lapsed`.
- D8. `DisputeArbitrationService.liveState` (`dispute-arbitration-service.js:21-31`) returns `chainDisputedAt` and `slaEndsAt` from the `getJob` it already reads. `dispute-routes.js:144-145` uses the chain value when live, and otherwise the local value labelled `windowSource: "local_estimate"`.
- D9. `converge()` (`dispute-arbitration-service.js:83-115`): for reason code `ARB_TIMEOUT`, record verdict `timeout` with `decidedBy: null` and `timeoutCaller: <caller>`. Never `split`, and never attributed to an arbitrator.

**Backend PR 3a (queue, drafts):**
- D2. New `mcp-server/src/core/arbitration-draft.js`:
  - `deriveOverturnDraft(session, liveJob)` always emits `dismissed` with `workerPayoutRaw` = live `reward − released`. It never emits `split` or `timeout`.
  - `validateDraft(draft, liveJob)`: verdict is `dismissed` or `upheld`; `split` only with an explicit payout in an admin draft; `timeout` never. Payout ≤ `reward − released`. Rationale 20–2000 characters.
  - `draftHash` = keccak of the canonical draft `{disputeId, chainJobId, escrow, verdict, reasonCode, workerPayoutRaw, rationale}`. `workerPayoutRaw` is always a concrete integer string, never `"full_remaining"`.
- D3. Admin drafts are stored as a mutation receipt in bucket `dispute_draft` (key disputeId): `{verdict, workerPayoutRaw, rationale, source, draftedBy, draftedAt, draftHash}`. This writes no content and has no `publishedAt`. Overturn drafts are derived on read and are not stored.
- D4. Index, in both `MemoryStateStore` (`state-store.js:335`) and `RedisStateStore` (`:1498`):
  - zset `this.key("arbitration","open")`, member sessionId, score chain `disputedAt`;
  - hash `this.key("arbitration","by-dispute")`, disputeId → sessionId.

  Both are added in `operator-overturn-service.js` after the transition (`:63-69`) and removed in `mcp-server/src/core/dispute-convergence.js` after a receipt is written. They are seeded once at boot by a full-session page scan, following `GithubPrReviewService.pending` including its seen-set (`mcp-server/src/services/github-pr-review-service.js:18-50`).
- D5. New `mcp-server/src/services/arbitration-queue-service.js`, merging three sources:
  - (i) the D4 index;
  - (ii) `stateStore.listPlatformFaultRemediations({status:'awaiting_hardware_arbitrator'})`;
  - (iii) the **union of `DisputeOpened` logs across every configured provider** (`RPC_URL` plus `RPC_BACKUP_URLS`), through a new gateway method that queries each provider. The scan runs from `deploymentBlocks.escrowCoreV3` (19414957) and `escrowCoreV2` (18809168) at boot, then incrementally from the last scanned block.

  Every item is confirmed with `gateway.getJobs` (`mcp-server/src/blockchain/gateway.js:3284`) against v3 and legacy v2. Only state 5 counts as "to sign". State 6 shows as "closed on chain" with its convergence status. Local `disputed` sessions on escrow state 3 (human_fallback) are excluded. The list is cached 60 s. `chainListStatus` is `complete`, `partial` (one provider failed) or `unreadable`, never "none open" on failure. In 3a, `platform_fault` items carry `signable:false, unsignableReason:"remediation_prepare_not_live"`, and 3c flips them.
- D6. New `mcp-server/src/protocols/http/admin-arbitration-routes.js`:
  - `GET /admin/arbitration/queue` and `GET /admin/arbitration/queue/:disputeId` (uncached, one item). Both are registered in `ROUTE_CAPABILITY_RULES` on `ops:view`, added to `roleGatedRoutes` "operator observability" (`mcp-server/src/core/agent-surface-parity.js:166-179`), and given a `/admin/arbitration/:id` collapse in `metricPathLabel` (`http-helpers.js:230+`). Run `npm run check:discovery-manifest` and `npm run check:openapi`.
  - `PUT /admin/arbitration/:disputeId/draft` (admin, D6a).
  - Response, pinned:
    ```
    { arbitrator, chainId, generatedAt, cacheAgeSeconds,
      chainListStatus: "complete"|"partial"|"unreadable",
      note, rehearsal: {at, outcome, connector}|null, signAll: {lastConfirmedAt}|null,
      items: [{ disputeId, sessionId|null, chainJobId, escrow,
        origin: "operator_overturn"|"platform_fault"|"worker",
        claimant, asset, remainingPayout /*decimal*/, remainingPayoutRaw /*integer string*/,
        chainDisputedAt, targetRuleBy, slaEndsAt, stage,
        live: <exact DisputeArbitrationService.liveState() output>,
        draft: { verdict, workerPayoutRaw, rationale /*admin only*/, source, draftedAt, draftHash,
                 status: "draft_unsigned" }|null,
        currentPreparation: { preparedAt, stale }|null,
        submitted: { preparationId, txHash|null, at,
                     receipt: "pending"|"success"|"reverted"|"not_found"|"uncertain" }|null,
        closedBy: "arbitrator"|"timeout"|"other"|"unknown"|null,
        signable, unsignableReason|null }] }
    ```
  - `note` is the literal "Drafts are proposals. Nothing is paid until the arbitrator phone signs and the chain confirms."
  - Viewers (non-admin) get `draft: {draftHash, status}` without `rationale`. `draftedBy` is never returned.
  - `stale` means the stored preparation's `inputHash` no longer matches draft + live remaining + authority.
  - A rationale under 20 characters gives `unsignableReason: "draft_rationale_too_short"`; the item is not hidden.
  - Drafts never enter `GET /disputes`, because `disputes:list/read` are base capabilities (`mcp-server/src/auth/capabilities.js:15-16`).
- D7. `POST /admin/sessions/overturn` (`admin-sessions-routes.js:20-26`, `operator-overturn-service.js:12-14`): `rationale` must be ≥20 characters and `ruling` is **required** (20–2000 characters), stored as `operatorOverturn.ruling`. There is no fallback on new overturns.
- D10. `/alerts` (`operator-activity-feed.js:192-202`) is built from the queue: chain state 5 only, ignoring submission records. Title "Arbitrator ruling due". The body names the asset from the record, the chain deadline and whether a draft exists, and links `/disputes`.
- D11. `/admin/status.arbitration` (next to `mcp-server/src/core/platform-service.js:1120`) gives per-item warnings computed from chain state 5, ignoring submission records.
  - `arbitration_ruling_past_target`, `arbitration_deadline_7d`, `arbitration_deadline_3d`: warning.
  - `arbitration_deadline_1d`, `arbitration_sla_lapsed_half_payout_callable`: critical.

  Critical at T-1d departs deliberately from the github_pr "warning only" precedent, because payout halves at the deadline. These codes stay out of public `/health`.

**Backend PR 3b (signing support):**
- D12. Route resolution: `POST /disputes/:id/prepare`, `GET /disputes/:id` and D14 resolve disputeId → sessionId through the `by-dispute` index first, and fall back to `findDispute` only on a miss. A miss on both returns 404 `arbitration_dispute_not_found`.
- D12a. Binding. `prepare` accepts `draftHash`. When it is present, prepare **ignores** the body's `verdict`, `rationale` and `workerPayout`. It loads the stored or derived draft, recomputes `draftHash` server-side, and returns 409 `arbitration_draft_changed` on any mismatch, including live `reward − released` ≠ the draft's `workerPayoutRaw`. The response carries `draftHash`.
- D12b. Proposed, not decided. `DisputeArbitrationService.prepare` writes the public reasoning payload as `{disputeId, sessionId, status:"proposed_ruling", verdict, rationale, preparedAt, binding:"Binding only if a DisputeResolved event on chain carries this metadataURI."}`. There is no `decidedBy` and no `decidedAt`; the arbitrator's identity comes from the chain event (`dispute-arbitration-service.js:110`). `preparedAt` takes `decidedAt`'s place in the URI. Other callers of `buildDisputeReasoningReceipt` are unchanged.
- D13. `POST /admin/arbitration/:disputeId/submitted` (admin) `{preparationId, txHash|null}` stores a `dispute_submission` receipt. `txHash: null` means uncertain. The backend reads that transaction's receipt through the gateway's configured providers (`RPC_URL` plus `RPC_BACKUP_URLS`).
  - `POST /admin/arbitration/:disputeId/submitted/clear` (admin) `{preparationId, reason ≥10 chars}` writes `dispute_submission_cleared`. It is refused with 409 while `receipt === "pending"`.
  - A state-5 item with an uncleared submission is not re-offered for signing, until its receipt reads `reverted` on the providers or it is cleared.
- D13a. A submitted item stays **counted**. The panel shows "Rulings to sign (N)" plus "Submitted, not confirmed on chain (M)" in warning tone. `deriveOperatorRoomVerdict` is never green while M>0. D10 and D11 ignore submission records. After 30 min with no mined receipt on any provider, the row shows "Not mined after 30 min: check MetaMask activity, then Clear or wait."
- D29. `capabilityHealth.arbitration`, one of `configured | arbitrator_not_registered | wrong_chain | public_content_unavailable | unreadable`.
  - Computed inside `buildProductHealthSnapshot` (`mcp-server/src/core/health-capability.js:641`), which is cached 60 s by `createProductHealthSnapshotProvider` (`:373-432`, `DEFAULT_PRODUCT_HEALTH_CACHE_MS` `:79`; wired in `operational-routes.js:94`, awaited today at `:156`) from `gateway.getArbitrationAuthority()` (`gateway.js:2813-2823`) and a shape check that `PUBLIC_BASE_URL` matches `^https://` (no fetch).
  - `operational-routes.js` awaits the snapshot before `resolveCapabilityHealth` (`:147-155`) and passes it in as a new input.
  - A value other than `configured` emits `arbitration_not_ready` (warning) through `buildCapabilityWarnings` (`health-capability.js:310`), which also records a capability-warning transition.
  - It never changes the 200/503 status and carries no ids. "configured" means configuration only, not that signing works.
- D30. `prepare` with `dryRun: true` (admin) branches **before** the claim lock (`:37-40`) and before the existing-preparation lookup (`:59-60`). It runs the same validation reads plus an `eth_call` simulation from the arbitrator address, using calldata it builds internally and then discards. It returns only `{dryRun:true, persisted:false, decoded:{jobId, workerPayout, reasonCode}, rationale, calldataHash, simulation:{ok, revert}}`. The response has no `to`, `data`, `value`, `args`, `transaction` or `preparationId`. It writes no lock, content or receipt. `sendPreparedArbitration` throws on any object with `dryRun: true` or without `preparationId`.
- D31. `POST /admin/arbitration/rehearsals` (admin) `{outcome, account, chainId, connector, peerName}`. The server sets `at`. The body has no signature field. Outcomes:
  - `prompt_reached_phone_rejected` and `prompt_reached_phone_approved`, allowed only for `connector: "walletconnect"`;
  - `arbitrator_key_in_browser_wallet` (injected connector + arbitrator account), shown red in `/admin/status.arbitration` with "The arbitrator key must live only on the phone (F6).";
  - `wrong_account`, `failed`.

  The latest rehearsal appears in the queue and in `/admin/status.arbitration` as "phone path last rehearsed <server time> (reported by the operator app)", or "never". Never "verified".

**Backend PR 3c (remediation parity):**
- D14. `POST /admin/arbitration/:disputeId/prepare-remediation` (admin):
  - Re-validates live state 5 and payout ≤ `reward − released`.
  - Returns the stored transaction in `PreparedArbitration` shape, with a `draftHash` computed over the transaction's decoded args plus the content at its `metadataURI`.
  - Writes the matching `dispute_preparation` receipt so the app guard's preparationId check can pass.
  - Remediation queue items carry `live` from `getJob`, and 3c sets them `signable`.
- D15. `converge()` marks the matching remediation record `resolved_on_chain`.
- D16. Remediation reasoning content is written through the arbitration content writer with the recovery log (`platform-fault-remediation-service.js:223,307` → `mcp-server/src/services/bootstrap.js:943-948`).

**App PR 4 (Sign all):**
- D17. `app/lib/chain/arbitration.js`: `arbitrationSigningState` returns a stable `code` next to `reason`: `ok | wrong_account | wrong_chain | not_disputed | preparation_mismatch | payout_exceeds_remaining | escrow_mismatch | calldata_mismatch | nonzero_value`. Update `.d.ts`.
- D18. New `app/lib/chain/wallet-errors.js` (+ `.d.ts`, `.test.mjs`): `classifyWalletError(err)` → `rejected_on_phone` (EIP-1193 4001), `request_expired`, `wallet_session_expired` (disconnect or session_delete), or `uncertain`. Build it from recorded error fixtures of `@walletconnect/ethereum-provider` 2.19.1 (`app/package.json:25`), classifying by SDK error code and not by a hard-coded TTL or message text.
- D19. New `app/lib/chain/arbitration-batch.js` (+ `.d.ts`, `.test.mjs`). It is a pure state machine with injected `prepare`, `getItem`, `fetchContent`, `send`, `recordSubmitted`, `disconnect` and `now`.
  - **D19a snapshot.** At the tap, the batch freezes the rendered rows `{disputeId, draftHash, chainJobId, escrow, workerPayoutRaw, reasonCode, rationale}`, excluding rows marked "Leave out". Polling never mutates the snapshot, and rows that appear later are excluded. Before the tap, if a poll shows a different `draftHash` for a row, that row shows "Changed since you opened this page" and Sign all stays disabled until the row is re-acknowledged.
  - **Per ruling, in order:**
    1. `prepare` (by origin: `operator_overturn` → `POST /disputes/:id/prepare` with `draftHash`; `platform_fault` → D14).
    2. `getItem`, a fresh live read.
    3. Assert that `prepared.draftHash`, `decoded.jobId`, `decoded.workerPayout`, `decoded.reasonCode`, `prepared.to` and `prepared.rationale` (byte-for-byte) equal the snapshot.
    4. `fetchContent(decoded.metadataURI)` and assert its `disputeId`, `verdict` and `rationale` equal the snapshot. Any failure in step 3 or 4 → `display_mismatch`, no prompt.
    5. `arbitrationSigningState` must return `ok`.
    6. `send` → hash → `recordSubmitted`.
    7. Wait for the **chain result**. Proceed only when the backend reports our receipt `success` with `from` = the arbitrator, a `DisputeResolved` for this job whose reason code is not `ARB_TIMEOUT`, and live state 6 (`confirmed_on_chain`), or our receipt `reverted`.
  - `converged` is a trailing per-row status and never gates the batch. A slow convergence shows "Confirmed on chain, app catching up."
  - **D19b.** State 6 reached by any other transaction shows red and never shows `confirmed_on_chain`, `converged` or "resolved": "Closed on chain by timeout (half pay). Your ruling did not land." (`timeout_closed`), or "Closed on chain by another transaction." (`closed_by_other`). `already_closed_on_chain` carries `closedBy`.
  - Exactly one request is in flight at a time. No nonce is set (the wallet assigns it). A send is never retried. Receipt truth comes from the backend chain read, never from the wallet provider's RPC (`app/lib/auth/wallet-provider.js:260-275` has no `rpcMap`).
  - Per-ruling states: `draft_unsigned`, `preparing`, `prepared`, `awaiting_phone`, `submitted`, `confirmed_on_chain`, `converged`, plus the failures below.

    | Failure | Batch action |
    |---|---|
    | `rejected_on_phone` | PAUSE: desktop prompt "You rejected ruling k. Continue with the next ruling?" The next `prepare` is not called until he confirms |
    | `already_closed_on_chain` | no prompt, continue |
    | `reverted`, `timeout_closed`, `closed_by_other` | red row, continue |
    | `draft_changed`, `display_mismatch`, `preparation_mismatch`, `payout_exceeds_remaining`, `not_found` | skip, no prompt, continue |
    | `request_expired` | record submission `{txHash:null}` (uncertain), STOP |
    | `uncertain_send` (error with no hash) | record uncertain submission, STOP; the row says to check MetaMask activity and never to sign again blindly |
    | `wrong_account`, `wrong_chain`, `wallet_session_expired`, `api_unavailable` | STOP |

  - A missing chain result is bounded at 10 minutes. After that the row shows `submitted_unconfirmed` and the batch STOPs.
  - After any STOP, the button relabels to "Sign remaining (M)" and resumes at the first row that has no submission.
  - **D19c.** The batch ends with a WalletConnect `disconnect()` exactly once, on completion, STOP or page unload.
- D20. New `app/components/disputes/RulingsToSignPanel.tsx` on `app/app/(authed)/disputes/page.tsx`, between `DisputesAggregateStrip` and `DisputesFilterRail` (`:99-100`).
  - All user-visible strings live in a new pure module `app/lib/ui/arbitration-copy.js` (+ `.d.ts`), and the `.tsx` imports only from it.
  - Each row shows: payout in USDC (not the verdict word, which avoids the "Dismiss = pay the worker" inversion), reason code, the full text under the label "Public text (published at the tap)", the chain deadline and "rule by" target, the legacy badge where it applies, and per-ruling state with an explorer link.
  - Each row has a one-tap "Leave out" toggle (included by default), and a collapsed "Edit draft text" disclosure, admin only, that calls `PUT …/draft`. That disclosure is the only edit path, and editing changes `draftHash`.
  - Header: "Rulings to sign (N)", plus "Submitted, not confirmed on chain (M)" when M>0.
  - Button: "Sign all (N confirmations on your phone)", with N counting included rows only.
  - Fixed copy: "Draft, unsigned. Nothing is paid until you approve each ruling on the arbitrator phone and the chain confirms." and "Tapping Sign all publishes each ruling's text at api.averray.com/content, marked as a proposed ruling, just before its phone prompt."
  - While a ruling waits for the chain: "Ruling k of N sent. Waiting for the chain (usually under a minute). Keep MetaMask open; the next ruling will appear there."
  - **Pairing.** WalletConnect only; the injected connector is not offered in this panel. The panel always shows the paired account. If it is not the queue's `arbitrator`, Sign all is replaced by one button: "Disconnect 0xabcd…1234 and pair the arbitrator phone" (`disconnectWallet()` then `connectWallet('walletconnect')`). Above the QR: "In MetaMask on your phone, select account <arbitrator, short> before scanning." If no arbitrator session exists, one tap on Sign all shows the QR, and the first prompt goes out as soon as pairing completes, with no second click.
  - Worker-opened rows: "Worker-opened: not signable from the app yet. Ask Claude for a drafted ruling and a signing runsheet."
  - The list is polled at most every 10 s; during a batch only the active item is polled.
  - Desktop only, as today (`app/lib/ui/mobile-operator.js:9-16`). Phone taps are approvals only.
- D21. `/overview` gets a dedicated "Rulings to sign (N)" row that is not derived from `/alerts`, because endpoint alerts displace client alerts (`app/app/(authed)/overview/page.tsx:241`).
  - The same N and M go into `deriveOperatorRoomVerdict` (`app/lib/ui/operator-room-verdict.js:3-24`).
  - The count renders "≥N" when `chainListStatus ≠ "complete"`, and "unreadable" when the feed is blocked (`app/lib/api/feed-presence.js`), never 0.
  - Below 768 px the row reads "Sign on your Mac at app.averray.com/disputes. Your phone only approves."
  - "Sign all: never used in production" shows while `signAll.lastConfirmedAt` is null.
- D22. `WindowCountdown.tsx:46-49`: tone steps at 7d, 3d and 1d from the chain `slaEndsAt`, plus a "rule by <D+3d>" line. `dispute-adapters.ts:189-198` reads an explicit `origin` field instead of substring-matching the JSON.

### 2. Reminders on his phone, from the day a dispute opens, and the 3-day target

These run off-box and from the chain only, so they survive the VPS dying and need no platform credential.

- D23 (PR 2). New `scripts/ops/escrow-chain-lib.mjs`: plain JSON-RPC over Node 22 `fetch` at runtime, with no install and no new dependency.
  - `eth_getLogs` for `DisputeOpened` on v3 from 19414957 and on legacy v2 from 18809168, in 50,000-block chunks that halve on a range error, on **both** manifest RPCs.
  - `jobs(bytes32)` decoded by word: disputedAt = word 18, state = word 20. This is the calibration in reference-agent `external-funnel.ts:15-33`, and the v2 layout is identical (`deployments/interfaces/mainnet-escrow-core-v2.json`).
  - `ARBITRATOR_SLA()`, read on both contracts and asserted equal to 1209600.
  - Selectors and topics are literals, pinned in `test:ops` by recomputing them with `ethers` (test-only).
- D24 (PR 2). New `scripts/ops/arbitration-deadlines.mjs`, `scripts/ops/arbitration-push-text.mjs` (the only home of phone text), `scripts/ops/arbitration-deadlines.test.mjs`, and `.github/workflows/arbitration-deadline-reminders.yml`.
  - Cron `7 */2 * * *`, `timeout-minutes: 15`, `concurrency: {group: arbitration-deadline-reminders, cancel-in-progress: false}`. Permissions `contents: read, actions: read`. There is no `issues: write`, no `gh issue` call and no `environment:` key. The inputs `simulate_now` and `drill` exist only under `workflow_dispatch`.
  - Tiers from chain `disputedAt` D:

    | Tier | Time | ntfy priority | Quiet hours |
    |---|---|---|---|
    | `opened` | D+0 (first sight of state 5) | 3 | held |
    | `target` ("target missed") | D+3d | 3 | held |
    | `sla_7d` | D+7d | 3 | held |
    | `sla_3d` | D+11d | 4 | ignored |
    | `sla_1d` | D+13d | 5 | ignored |
    | `sla_lapsed` | D+14d | 5 | ignored |
    | chain read failed on both RPCs | any | 5 | ignored |
    | daily alive digest | once a day while ≥1 dispute is state 5 and nothing else went out that day | 2 | held |

    "Held" means delivered at the first run inside 08:00–21:00 Europe/Zurich.
  - **Catch-up.** Per dispute, only the newest crossed tier not yet sent counts. Each run sends **one** push listing every dispute with a new tier ("3 rulings to sign; nearest deadline <UTC> (job 0x…); 1 past target"), at the highest priority among them.
  - **Enumeration.** The union of both RPCs' logs, then `jobs().state` on both RPCs; state 5 on either counts as open. A log seen on only one RPC adds a named parity warning to the push. If both RPCs fail, it sends "Deadline status unknown: chain read failed", never silence.
  - **Dedupe state (not public issues).** Each run downloads the newest `arbitration-reminder-state` artifact from earlier runs of this workflow (`gh run download`) and uploads the updated state with `actions/upload-artifact` (`if: always()`, 90-day retention). The state holds only `sha256(escrow:jobId)`, tier and `sentAt`. Per run, the push goes out first, and the state is marked only after the push succeeds. Every dispute is processed before the run exits non-zero on any failure. Delivery is at-least-once. A missing artifact means empty state, and catch-up then sends only the newest tier. A disputed job whose chain state is no longer 5 is dropped from state and gets nothing further.
  - **Public output.** The job log and summary print counts and pass/fail only: no job ids, deadlines or tier names per job.
  - **Drill.** `drill=true` with `simulate_now` prefixes "[DRILL]", reads nothing from and writes nothing to the state artifact, and makes no issue calls.
  - After merge, Pascal dispatches the workflow once, because a new scheduled workflow's first run can be delayed.
- D25. Push text: chain facts only, built only in `arbitration-push-text.mjs`.
  - Every reminder starts "On your Mac:".
  - The `Click` header is `https://app.averray.com/overview`, never a bare `/disputes` link.
  - The text shows hours remaining (not the tier label), in UTC plus Europe/Zurich time.
  - It ends with the run URL and "A push is a pointer; check the app."
  - Example `opened`: "On your Mac: new arbitration ruling to sign, job 0xabcd…1234 (from chain). Sign by <D+3d> (target); hard deadline <D+14d>. You approve each ruling on the arbitrator phone. Nothing is paid until you approve and the chain confirms."
  - Until PR 4 is live (`SIGN_ALL_LIVE = false`), the action line reads "open app.averray.com/disputes, select the dispute and rule it in the drawer (Prepare, then Sign)". PR 4 sets `SIGN_ALL_LIVE = true`, and the action line then reads "app.averray.com/disputes → Rulings to sign → Sign all".
  - Lapsed: "Deadline passed <time>. A full ruling is still possible while the escrow stays Disputed; from now anyone can close it at half pay."
  - The text never offers the timeout as an action, never says "ready" or "signed", and never implies the platform can resolve anything.
- The 3-day target appears in the UI through D1, D20 and D22, in `/admin/status` through D11, and on the phone through `opened` and `target`.

### 3. The weekly production dry run of the signing path

**Automated part (PR 6, no human, no admin credential).** New `.github/workflows/arbitration-signing-dry-run.yml`, cron `23 7 * * 1`, modelled on `hosted-receipt-binding-proof.yml:4-9`. Permissions `contents: read, actions: read`. There is no `environment:` key, and the only secret is `PHONE_PUSH_URL`. The script is `scripts/ops/arbitration-dry-run.mjs`, sharing `escrow-chain-lib.mjs`. PR 6 merges only after production `/health` shows `capabilityHealth.arbitration == "configured"`.

- D26. Checks, all public reads:
  - (a) `/health` returns 200, `auth.chainId` is 420420419, and `capabilityHealth.arbitration` is `"configured"`.
  - (b) Crawl `app.averray.com/disputes/` and its chunks: the WalletConnect project id `21fd0a11…` and "Connect phone with WalletConnect" must be present. Chunk names are never fixed in the check.
  - (c) On both RPCs: `eth_chainId` is 0x190f1b43, and on `TreasuryPolicy` at the escrow's `policy()` address (`EscrowCore.sol:33`; the escrow's own checks are `policy.arbitrators(msg.sender)` at `:285-287` and `policy.paused()` at `:302-303`; getters `TreasuryPolicy.sol:12,41`), `arbitrators(<manifest arbitrator>)` is true and `paused()` is false.
  - (d) An `eth_call` of `resolveDispute(bytes32(1),0,0x0,"")` from the arbitrator must revert with exactly the `InvalidState()` selector (0xbaf3f0f7), and from a non-arbitrator with `Unauthorized()` (0x82b42900). If an RPC returns no revert data, the check fails with the distinct code `rpc_revert_data_missing`. Recorded responses from both RPCs are committed as fixtures. A control that does not fail makes the run red.
  - (e) For each open dispute: an `eth_call` with the full remaining payout from the arbitrator succeeds, and payout+1 reverts `Error("EXCESS_PAYOUT")`.
  - (f) Arbitrator balance, with a fixed 0.05 DOT per-ruling budget (observed receipts 0.039–0.044; estimateGas about 0.035 at gasPrice 8e11). Warn below `max(0.3, (open+3) × 0.05)` DOT. Fail below `max(0.12, open × 0.05)`.
  - (g) `GET /content/<zero-hash>` returns the backend's 404 JSON. Once a v3 `DisputeResolved` with an http(s) `metadataURI` exists, that URI must return 200.
  - (h) The `DisputeOpened` sets from both RPCs are compared. A mismatch is a named warning in the push ("log parity: job 0x… missing on primary"), not red, as long as the union plus a `jobs().state` read on both RPCs agree.
  - (i) Reminder liveness: `gh run list --workflow arbitration-deadline-reminders.yml --status success -L 1`. A last success more than 12 h old is red: "Deadline reminders not running since <time>."
- D27. The run always pushes. Green goes out at priority 2 with no imperative: "Weekly read-only arbitration checks green (nothing was signed; your phone was not tested)." Red goes out at priority 4, naming the failed check ids. It opens **no** issue. The public job log and summary print check ids with pass/fail only: no balances, revert reasons or "cannot sign".
- D28 (PR 6). The bundle check (D26b) also runs in `scripts/ops/check-hosted-stack.sh` after each deploy.

**Operator part (PR 5, about 1 minute, required once, then only when stale).**
- D32. New `app/components/disputes/SigningRehearsalCard.tsx` on `/disputes`, always rendered, including when no dispute is open. Add `signMessage` to the wallet-provider controller and export `signWalletMessage` (today only `sendWalletTransaction` is exported, `app/lib/auth/wallet-provider.js:490-498`; `personal_sign` is already in `REQUIRED_METHODS`, `:12`). The flow:
  1. Connect phone (QR, WalletConnect only).
  2. The app checks that the account is the queue's `arbitrator` and the chain is 420420419.
  3. `personal_sign` of fixed plain text: `Averray arbitration rehearsal <UTC date>. Not a transaction. Press Reject.` The text is not EIP-4361-shaped and carries no nonce.
  4. Pascal taps Reject, and 4001 → `prompt_reached_phone_rejected`. An approval → `prompt_reached_phone_approved`; the signature is dropped in the browser and never sent.
  5. POST the D31 record (connector and peer name included), then disconnect.

  Card copy: "This proves pairing, the arbitrator account, the chain, and that a prompt reaches your phone. It does not sign or prove any ruling or transaction." The rehearsal never sends a transaction. Re-pairing about every 7 days (WalletConnect session expiry) is expected and is not shown as broken.
- Cadence: one rehearsal is required after PR 5 (exit item 5). After that, the card and the `/overview` Rulings row show "Phone path last proven <date>", from the last confirmed Sign all or rehearsal. The card is highlighted when that date is more than 30 days old. There is no weekly chore; ruling within the 3-day target is itself the rehearsal, with 11 days of slack.
- When a dispute is open, the card also shows the D30 dry-run result for the first queued ruling: exact payout, reason, public text and simulation outcome, marked "Dry run: nothing published, nothing signable".

### 4. An off-box outage alert that reaches the phone

- D33 (PR 1). New `scripts/ops/phone-push.sh` (+ `scripts/ops/phone-push.test.mjs`).
  - ntfy only, curl only, no marketplace action. It reads `PHONE_PUSH_URL`, the full ntfy topic URL; a write token, if used, goes in the URL as `?auth=`. It sets the `Priority`, `Title`, `Tags` and `Click` headers.
  - It exits non-zero when the secret is unset or delivery fails, and never echoes the URL.
  - Add a `PHONE_PUSH_URL` row to `deploy/secrets-inventory.md`.
- D34 (PR 1). `.github/workflows/external-uptime-watchdog.yml`:
  - The existing issue open, comment and close steps run first and unchanged, and contain no push call.
  - Paging is a separate later step with `if: always() && <condition>`:
    - on open: priority 5;
    - re-pages at priority 4 on the first failing run at or after +1 h, +4 h and +12 h, then once every 12 h, derived from the issue's creation time and hidden `<!-- page:n -->` markers in the watchdog's own comments;
    - on close: priority 3, "Public surfaces answering HTTP 200 again (not a health verdict)."
  - Outage pages start "On your Mac:", and their `Click` is the issue URL.
  - A final step named "Phone push (config)" fails the job with "phone push not configured or undeliverable" when a push failed. It never opens or edits an issue.
  - Assignment is a separate `gh issue edit --add-assignee depre-dev || echo "::warning::assign failed"`.
  - A `workflow_dispatch` input `drill` sends "[DRILL] page" and then "[DRILL] all-clear" in the same run, and never reads or writes issues. Scheduled runs cannot set it. PR 1 notes give the one-liner `gh workflow run external-uptime-watchdog.yml --repo averray-agent/agent -f drill=true`.
  - The workflow text states that the cron is best-effort and is not 15-minute detection. The job has no `environment:` key.
- D35 (operator item, optional). A second off-box probe outside GitHub on `api.averray.com/health`, `app.averray.com` and `averray.com`, every 5 minutes, to the same ntfy topic. Before recommending a provider, Claude verifies that its free tier can deliver to ntfy (webhook, or ntfy email-to-topic). If none can, this item is dropped.
- D36 (PR 7, reference-agent, secondary because it dies with the host):
  - `product-health.ts:3414-3418`: call `setAlertState(state)` only after dispatch returns true. On false, keep the previous state so the next tick retries, and record "alerted" only on true.
  - `hermes/skills/ops/averray-ops/SKILL.md:152-153`: replace the "genuinely fine" wording for disputed jobs with "disputed: the arbitrator's 14-day clock is running; see Rulings to sign".
  - No phone adapter and no new env var in this PR (see Later).

## Non-negotiables (each pinned by a test; I run the drills)

Each drill: apply the mutation and the named test goes red; revert it and the test goes green. The handback shows both. Component pins live in `app/lib/ui/*.test.mjs` or `app/lib/chain/*.test.mjs` and read the `.tsx` source with `fs`, because `test:app` globs only `app/lib/...`. Ops tests live at top level in `scripts/ops/*.test.mjs`.

**Part 1**
1. A draft never publishes. After `PUT …/draft`, the content store and recovery log are unchanged. *Mutation: call `persistContentRecord` in the draft path.*
2. Drafts are never in `GET /disputes`: a base worker session sees no `draft` or preparation body. *Mutation: add `draft` to `buildDisputeFromSession`.*
3. An auto-draft is `dismissed` with a concrete `workerPayoutRaw` equal to live remaining. *Mutation: emit `split`, `timeout` or `"full_remaining"`.*
4. A draft payout above `reward − released` is refused at `PUT` and at prepare. *Mutation: remove either check.*
5. Overturn: a rationale under 20 characters → 400; a missing or short `ruling` → 400. *Mutation: fall back to `rationale`.*
6. After 600 later session writes, the queue lists the dispute **and** `POST /disputes/:id/prepare` returns 200 for it. *Mutation: `listRecentSessions(100)` or `findDispute` first.*
7. `slaEndsAt` = chain `disputedAt` + 1209600 when the local timestamp is 90 s later. *Mutation: use `session.disputedAt`.*
8. Live state 6 is never "to sign"; a state-3 human_fallback session is never listed. *Mutation: drop either filter.*
9. An `ARB_TIMEOUT` `DisputeResolved` converges as `timeout` with `decidedBy: null`. *Mutation: back to `split`.*
10. The primary provider omits a `DisputeOpened` log that the backup has: the queue still lists the dispute, and `chainListStatus` is `complete`. *Mutation: single-provider scan.*
11. `prepare` with `draftHash` and a different body rationale publishes the stored text, never the body. A stale `draftHash`, or live remaining ≠ draft payout → 409 `arbitration_draft_changed`. *Mutation: read the body fields.*
12. The published reasoning payload of a preparation has `status: "proposed_ruling"` and no `decidedBy` or `decidedAt`. *Mutation: restore `decidedBy`.*
13. `prepared.rationale` differing by one character from the snapshot, or `/content` differing from it → `display_mismatch`, and `send` is never called. *Mutation: drop either assertion.*
14. A draft edited between render and tap → Sign all is disabled until the row is re-acknowledged. *Mutation: let the poll mutate the snapshot.*
15. Ruling 2 is not prepared or prompted until ruling 1 has a chain result (confirmed or reverted). Ruling 2 **is** prompted while ruling 1 is `confirmed_on_chain` with convergence pending. *Mutation: gate on `converged`, or drop the wait.*
16. State 6 reached by an `ARB_TIMEOUT` transaction while ours is pending → `timeout_closed`, never `confirmed_on_chain` or `converged`. *Mutation: accept state 6 alone.*
17. 4001 → PAUSE, and `prepare` is not called for the next item until the desktop confirm. Request expiry → uncertain submission recorded, then STOP. A send error with no hash → `uncertain_send`, STOP, `send` called exactly once. *Mutation: continue on reject, or retry on error.*
18. An item already at state 6 before its prompt → `send` is never called. *Mutation: skip the fresh `getItem`.*
19. A recorded submission on a state-5 item → not re-offered, still counted in the overview and `/admin/status`, and `arbitration_deadline_*` is still emitted. After a clear it is re-offered. A clear is refused while `pending`. *Mutation: drop the counted-while-submitted rule.*
20. Every D6a route and `prepare` return 403 for a worker, a viewer, a verifier, a service token, and a wallet that holds every capability through grants but has no admin role. A viewer's queue response has no `rationale`. *Mutation: gate on `ops:view`.*
21. Copy pins in `app/lib/ui/arbitration-copy.test.mjs`: "Draft, unsigned", "confirmations on your phone", "proposed ruling" and "publishes" are present. `RulingsToSignPanel.tsx` contains no string literal matching `/queued|scheduled|ready to pay|resolved/i`. *Mutation: delete the draft label.*
22. A connected account that is not the arbitrator → the switch button renders and Sign all is not enabled; the injected connector is not offered in the panel. *Mutation: render Sign all.*
23. The batch calls `disconnect` exactly once on completion, on STOP and on unload. *Mutation: drop it on STOP.*
24. (3a/3c) `platform_fault` items are not signable before 3c. After 3c, convergence marks the remediation `resolved_on_chain`, and an `executable:false` item is never `signable`. *Mutation: drop either rule.*
25. An operator-overturn record yields origin `operator_overturn`, not `timeout`. *Mutation: back to substring matching.*

**Part 2**

26. A fixture at D+0h+5m, inside the window, sends exactly one `opened` push. *Mutation: drop the tier.*
27. A fixture at D+13d+1h sends the `sla_1d` push. *Mutation: drop the T-1d tier.*
28. A first run at D+12d with empty state sends exactly one push naming `sla_3d`; a second run sends none. *Mutation: send every crossed tier.*
29. Chain state 6 → nothing is sent and the state entry is dropped. *Mutation: ignore chain state.*
30. The primary RPC is missing a log → the dispute is still listed, with a parity warning. Both RPCs failing → an "unknown" push, never "no open disputes". *Mutation: single-provider scan.*
31. The SLA is read from the chain and asserted to be 1209600. *Mutation: 7 days.*
32. `PHONE_PUSH_URL` unset → the run exits non-zero. *Mutation: exit 0.*
33. Push text never contains "autoResolveOnTimeout", "ready" or "signed" for an open dispute. It starts "On your Mac:", its `Click` is `/overview`, and it names "Rulings to sign" only when `SIGN_ALL_LIVE`. *Mutation: any of these.*
34. An `sla_7d` crossing at 02:00 Zurich is held until the 08:00 window; an `sla_1d` crossing at 02:00 is pushed. *Mutation: no quiet hours, or quiet hours for all tiers.*
35. `drill=true` leaves the state artifact untouched. No step in `arbitration-*.yml` runs `gh issue`. "half pay" and "anyone can close" appear only in `arbitration-push-text.mjs`. *Mutation: write state in a drill.*
36. At least one open dispute and nothing else sent that day → exactly one alive digest. *Mutation: drop the digest.*

**Part 3**

37. Dry run, with a real preparation of identical inputs persisted first: `prepare({dryRun:true})` returns `persisted:false` and none of the keys `to|data|value|args|transaction|preparationId`. The lock is never acquired. The Redis, content-store and recovery-log snapshots are unchanged. `sendPreparedArbitration({prepared: dryRunResponse})` rejects before `provider.request` is called. *Mutation: move the branch after `:59-60`.*
38. The dry-run job goes red when the non-arbitrator control does not revert `Unauthorized`. Missing revert data → `rpc_revert_data_missing`. *Mutation: swap the addresses.*
39. Balance below the floor → red. A bundle without the project id → red. *Mutation: skip either check.*
40. `capabilityHealth.arbitration` is `public_content_unavailable` when `PUBLIC_BASE_URL` is unset, and `configured` under the parsed `deploy/backend.mainnet.env.template` (the #1399 pattern, `scripts/ops/render-mainnet-backend-env.test.mjs:439-453`). `/health` stays 200 in both cases. Two `/health` calls within 60 s make exactly one `arbitrators()` call. Every `process.env` key read by the new backend files appears in the parsed mainnet template. *Mutation: compute per request.*
41. The rehearsal text is not EIP-4361-shaped. `SigningRehearsalCard.tsx` contains no `eth_sendTransaction`, `sendWalletTransaction` or `getActiveWalletProvider`. The rehearsal POST has no `signature` key. An injected connector never yields `prompt_reached_phone_*`. *Mutation: any of these.*
42. The three new workflows and the watchdog reference no secret other than `PHONE_PUSH_URL`, contain no `environment:` key, and contain no `op://`, `ADMIN` or `REFRESH`. *Mutation: add any one.*
43. A last reminder success 13 h ago → dry run red. *Mutation: drop check (i).*
44. The green push text contains no imperative ("Rehearse", "Open", "Do") and goes out at priority 2. *Mutation: restore the nag.*

**Part 4**

45. Watchdog pins (test:ops regex over the YAML plus a cadence fixture): 8 consecutive failing runs 15 min apart send exactly 2 pages (open, +1 h). The page step has `if: always()`. The issue steps contain no push call. `drill` exists only under `workflow_dispatch`. An unset secret fails only "Phone push (config)", with no issue API call from it. *Mutation: page on every failing run.*
46. Reference-agent: dispatch returning false → the next tick dispatches again. *Mutation: commit the alert state before dispatch.*

**Local checks per AGENTS.md** (run the set that matches each PR):
- Backend: `npm --workspace mcp-server test`, plus `npm run check:discovery-manifest` and `npm run check:openapi` for 3a.
- App: `npm run typecheck:app`, `npm run build:frontend`, `npm run test:app`.
- Ops and workflows: `npm run test:ops`.
- Reference-agent: `npx tsc -b packages/averray-mcp && npm run typecheck && npx vitest run services/slack-operator`.
- No indexer or contract changes, so no `forge test`. Do not commit generated `frontend/` or `site/` output.

## PR split (order and dependencies)

| # | Repo / area | Content | Depends on |
|---|---|---|---|
| 0 | platform ops/CI | Run `npm run test:app` in the CI frontend job (`ci.yml:202-222`); add `app/lib/events` to the glob. Run it against main first and fix failures in this PR (no skips); report before/after | — (land first) |
| 1 | platform ops-workflow | D33–D34 ntfy push, watchdog paging, drill, secrets-inventory row | operator item 1 |
| 2 | platform ops-workflow | D23–D25 chain-only reminders (`SIGN_ALL_LIVE = false`) | 1; **live before 2026-10-03T18:00Z** |
| 3a-0 | platform backend | D1, D8, D9 clock, chain deadline, timeout label | — |
| 3a | platform backend | D2–D7, D10–D11 index, queue, drafts, overturn `ruling`, `/alerts`, `/admin/status` | 3a-0 |
| 3b | platform backend | D12–D13a, D29–D31 binding, proposed-ruling payload, admin-only prepare, submitted/clear, dry run, capabilityHealth, rehearsal record | 3a |
| 3c | platform backend | D14–D16 remediation parity | 3a |
| 4 | platform app | D17–D22 Sign all; flips `SIGN_ALL_LIVE` in the reminder text | 0, 3a, 3b, 3c |
| 5 | platform app | D32 rehearsal card, `signWalletMessage` | 0, 3b |
| 6 | platform ops-workflow | D26–D28 weekly dry run + post-deploy bundle check | 1, 2, 3b deployed (`configured` in prod) |
| 7 | reference-agent | D36 dispatch-order fix, SKILL wording | — |

No PR adds an npm, PyPI or Cargo dependency (`ethers` is already used by `scripts/ops` tests). ntfy is a third-party service, not a package. PR 1 still lists it in its notes: the service URL, what it does, and where the secret lives.

## Operator items (Pascal)

1. **Phone channel (required, before PR 1 merges).** Install the ntfy app and subscribe to a long random topic. Then run `gh secret set PHONE_PUSH_URL --repo averray-agent/agent`: repository scope, **no `--env`**; it prompts for the value. Save the same value in 1Password prod-ci. Confirm that the PR 1 test page arrived.
2. **Open disputes (required).** See the private note. One chain read first; whether to rule is your call.
3. **After PR 2 merges,** run `gh workflow run arbitration-deadline-reminders.yml --repo averray-agent/agent` once.
4. **First phone rehearsal** after PR 5 (1 minute). After that, only when the card says the phone path is more than 30 days stale.
5. **Second off-box probe (optional, D35),** only if Claude confirms a free tier can deliver to ntfy.
6. **Diagnostic (optional).** Are `PRODUCT_HEALTH_ENABLED=1` and `SLACK_WEBHOOK_URL` set in the reference-agent `.env.prod`? Does any scheduler run `check-hosted-stack-and-alert.sh`? The answers say whether the missing on-box page was never sent or was sent and missed.

## Exit condition (observable in production)

1. A real ruling signed through **Sign all**: our receipt from the arbitrator, a `DisputeResolved` for that job whose reason code is not `ARB_TIMEOUT`, state 6, and converged in the app. If Sign all is not live before the next due dispute, that dispute is ruled through the drawer path (private note). This item then stays open until the next real dispute, and the UI shows "Sign all: never used in production" until then.
2. A deadline push received on the phone: the first real `opened` or tier push, or a `workflow_dispatch` drill at a simulated time, prefixed "[DRILL]".
3. A scheduled Monday dry run green, with its low-priority push received. Plus one deliberate red: the control-swap drill, run on a branch.
4. An outage drill: watchdog `drill` dispatch → "[DRILL] page" and "[DRILL] all-clear" received on the phone. Plus the external probe's test alert if item 5 was done.
5. One phone rehearsal recorded, with `/admin/status.arbitration` showing its date "(reported by the operator app)".

Nothing is marked Done or Proofed in the roadmap without these, the merged PRs and green CI. Roadmap text goes in a `docs/roadmap-updates/` fragment, and it names no live dispute.

## Out of scope

- Moving the arbitrator key to any server, KMS, hot wallet or always-online signer (`docs/MAINNET_CREDENTIALS_PLAN.md` F6). A backend arbitrator signer is refused for good.
- `autoResolveOnTimeout` keepers or any automation that calls it. It pays half and slashes claim economics (`EscrowCore.sol:908-919`).
- Contract changes, batcher or forwarder contracts, and EIP-7702/5792 batching. Any of these would move authority off the arbitrator EOA or needs unverified chain support.
- HumanVerdictService (`human_fallback`) sessions. They are backend-signed, not arbitration.

## Later, not now

- Making worker-opened disputes signable in the app: a state-machine transition on `DisputeOpened` for a rejected session.
- Signing without the API: chain reads plus a cached preparation. Prior art: `docs/evidence/arbitration-page-2026-09-15.html` on the packets branch. Operator-local only.
- A reconcile sweep for rulings that land while the backend is down (the listener starts at head, `mcp-server/src/blockchain/event-listener.js:39-40`).
- Phone-only Sign all: a responsive `/disputes` and the MetaMask deep link from `WalletSignInFlow.tsx:211-224`.
- A reference-agent phone adapter, and an on-box Hermes `arbitrator_sla` probe, once the off-box paths have proven themselves.
- An advisory indexer source for disputed jobs (the Ponder `job` table, `indexer/ponder.schema.ts:14-50`).

## Handback

- PR numbers, CI links and merge SHAs.
- Each drill above shown red, then green, with test names.
- Local check output per PR, and PR 0's before/after `test:app` output.
- The PR 1 test page and the PR 2 drill push as received on the phone (screenshot or timestamp).

After deploy, I verify:
- `/health` `capabilityHealth.arbitration`;
- the queue lists every open dispute with chain deadlines and `chainListStatus: "complete"`;
- the first scheduled dry run and reminder runs;
- the exit items above.
