# Wikipedia repeat-purchase guard evidence

Packet: `PACKET_REPLENISHER_PAYS_FOR_THE_SAME_ARTICLE_FOREVER.md` at
`e0e9b3cb`, branch `claude/packets-2026-08-12`.

## Public production observation

Observed 2026-09-10T19:42:25.459Z; scheduler finished at 19:42:31.788Z.
Command: `node mcp-server/src/jobs/dry-run-wikipedia-replenishment.js`.
Input: `https://api.averray.com/jobs?format=full`, plus live Wikipedia category
and revision reads. Nine publicly listed Wikipedia jobs; one active source;
six candidates. No credentials, SSH, persistent state, signer, job POST, or
event bus. No actual jobs were created or funded.

The real scheduler ran in memory with `enabled: true`, `dryRun: true`,
`minClaimableJobs: 0` to evaluate candidates regardless of the inventory floor.
These diagnostic overrides do not alter deployment configuration. Its existing
`createdCount: 2` field counts **would-create** jobs in this mode.

| Source | Decision |
| --- | --- |
| Aufschrei, page 53577157, revision 1370991727 | `completed_cooldown` |
| (+ +), page 58158792, revision 1355918793 | `completed_cooldown` |
| ? (2011 film), page 33653136, revision 1371439588 | Selected, generation 1 |
| ...in the suburbs of Moscow, page 80171159, revision 1369241182 | Selected, generation 1 |
| (Hash), page 62871101, revision 1351905908 | `run_capacity_reached` |
| + − (album), page 45188030, revision 1360581573 | `run_capacity_reached` |

Errors: none. Scope limitation: public listings are **not** an exhaustive
archived-host history audit. Their missing completion timestamps remain
unknown and fail closed; no terminal dates were inferred. Runtime on the host
also reads archived catalogue rows and paginated durable session pins.

## Six pinned tests and mutation drills

1. `completed Wikipedia sources stay seen inside the cooldown without occupying active inventory`
   — adding `exhausted` to `ACTIVE_SOURCE_STATES` failed (`true !== false`).
2. `a changed upstream Wikipedia revision bypasses the completed cooldown and starts a new cap`
   — ignoring revision in source identity failed (`0 !== 1`).
3. `Wikipedia reissues never exceed the per-revision cap and report reissue_cap_reached`
   — removing the cap failed; the prohibited candidate was admitted instead of skipped.
4. `a wallet paid for a Wikipedia source cannot claim any reissue and preflight agrees`
   — removing the claim-side guard failed (missing expected rejection);
   removing the preflight-side guard separately failed (`true !== false`).
5. `two identical Wikipedia category runs rotate the first candidate after a skip`
   — removing rotation failed (first candidate repeated).
6. `shared completed-source cooldown preserves active-source behavior for GitHub OSV and OpenData`
   — active/expired behavior and cooldown boundaries pinned for each source type.
   Their existing scheduler suites also pass unchanged. On the inspected main
   base these three schedulers do not actually call `buildInventorySnapshot`;
   only Wikipedia does. No scheduler refactor was needed for them.

All mutations were restored before validation. Additional tests cover category
continuation, category exit, concurrent scheduler calls, archived/deleted rows,
session timestamps, payment-history pagination, legacy payout receipts, and
unavailable/truncated history. No verifier, lane cap, retention, contract, or
proposal-only policy changes. #1361's pause remains; re-enable is an operator
decision after the fix deploys.
