/**
 * Hermes Handoff Monitor — shared card-type definitions.
 *
 * Mirrors the data shapes in the Claude Design handoff bundle's
 * `data.jsx`. Engineering source of truth for what a card looks like
 * across all six monitor card types. Kept as JSDoc-typed JS so node:test
 * can run against it directly (no TS loader required) and so
 * `app/lib/monitor/*.test.mjs` picks it up via the `test:app` glob.
 *
 * The data model is documented in §6 of
 *   docs/HERMES_MONITOR_REDESIGN_SPEC.md
 *
 * Lane derivation lives in lane-rules.js. Freshness math lives in
 * urgency.js. Both reference the @typedef from this file.
 */

/**
 * @typedef {"needs-attention"
 *   | "drafts"
 *   | "codex-needed"
 *   | "hermes-checking"
 *   | "operator-review"
 *   | "release-queue"
 *   | "deploying"
 *   | "done"} Lane
 */

/**
 * @typedef {"pr"
 *   | "mission"
 *   | "task"
 *   | "deploy"
 *   | "draft"
 *   | "done"} CardType
 */

/**
 * @typedef {"claude" | "codex" | "hermes" | "ext"} AgentType
 */

/**
 * @typedef {"workflow"
 *   | "config"
 *   | "review-gated"
 *   | "contracts"
 *   | "secrets"
 *   | "indexer"
 *   | "xcm"
 *   | "docs"
 *   | "testbed"
 *   | "ui-only"
 *   | "deps"
 *   | "quality"} RiskTag
 */

/**
 * @typedef {"fresh"
 *   | "stale"
 *   | "failed-fetch"
 *   | "source-offline"
 *   | "running"} CardState
 */

/**
 * @typedef {Object} WaitingOn
 * @property {"operator" | "author" | "agent" | "CI" | "relay" | "branch-protection"} actor
 * @property {"warn" | "info" | "neutral"} tone
 */

/**
 * @typedef {Object} CardChecks
 * @property {number} pass
 * @property {number} running
 * @property {number} fail
 * @property {number} pending
 * @property {number} total
 */

/**
 * @typedef {Object} CardFile
 * @property {string} path
 * @property {string} diff   — e.g. "+18 -4"
 * @property {boolean} critical
 */

/**
 * @typedef {Object} CardAction
 * @property {"operator-review" | "codex-approve" | "deploy-verify" | "mission-rerun"} kind
 * @property {string} primary
 * @property {string} [secondary]
 */

/**
 * Shared fields across every card type. Card-type-specific extensions
 * are below.
 *
 * @typedef {Object} CardBase
 * @property {string} id
 * @property {Lane} lane
 * @property {CardType} type
 * @property {AgentType} agentType
 * @property {string} title
 * @property {string} summary
 * @property {string} repo
 * @property {string} [branch]
 * @property {number} freshness   — minutes since entering current lane
 * @property {CardState} state
 * @property {RiskTag[]} risk
 * @property {CardChecks} [checks]
 * @property {WaitingOn} waitingOn
 * @property {boolean} [isAction]   — true ⇒ this card drives needs-attention
 * @property {boolean} [isDraft]    — true ⇒ render in drafts regardless of other state
 * @property {boolean} [archiveHint] — stale-card "want to archive?" prompt
 */

/**
 * PR card. Carries file changes, Hermes verdict, and the operator-review
 * action contract.
 *
 * @typedef {CardBase & {
 *   type: "pr",
 *   files: CardFile[],
 *   verdict?: string,
 *   action?: CardAction,
 * }} PRCard
 */

/**
 * Browser mission card (testbed). The interesting payload is `mission`,
 * the full agent report.
 *
 * @typedef {Object} MissionStep
 * @property {number} n
 * @property {"ok" | "warn" | "fail"} status
 * @property {string} desc
 * @property {string} lat   — latency string, e.g. "320ms" / "12.4s"
 */

/**
 * @typedef {Object} MissionBlocker
 * @property {string} head
 * @property {string} body
 */

/**
 * @typedef {Object} MissionEvidence
 * @property {"screenshot" | "trace" | "console" | "video"} kind
 * @property {string} label
 * @property {string} href
 */

/**
 * @typedef {Object} MissionReport
 * @property {"OK" | "PARTIAL" | "FAILED"} verdict
 * @property {"ok" | "warn" | "fail"} verdictTone
 * @property {number} confidence    — 0..1
 * @property {string} latency        — e.g. "2m 14s"
 * @property {string} target         — URL under test
 * @property {string} seed           — e.g. "fresh · no memory"
 * @property {number} runs
 * @property {number} successScore   — 0..10
 * @property {number} clarityScore   — 0..10
 * @property {number} latencyScore   — 0..10
 * @property {MissionStep[]} path
 * @property {MissionBlocker[]} blockers
 * @property {MissionEvidence[]} evidence
 * @property {string} mutationBoundary
 * @property {string[]} recommendations
 */

/**
 * @typedef {CardBase & {
 *   type: "mission",
 *   mission: MissionReport,
 * }} MissionCard
 */

/**
 * Codex task card. Lifecycle: proposed → approved → running → succeeded/failed.
 *
 * @typedef {CardBase & {
 *   type: "task",
 *   prompt: string,
 *   action?: CardAction,
 *   runnerHeartbeat?: { lastSeen: string, online: boolean },
 *   output?: string,
 *   failureReason?: string,
 * }} CodexTaskCard
 */

/**
 * Deploy verification card.
 *
 * @typedef {CardBase & {
 *   type: "deploy",
 *   deployId: string,
 *   verification: { current: number, total: number, label: string },
 * }} DeployCard
 */

/**
 * Draft card — author hasn't marked ready yet.
 *
 * @typedef {CardBase & {
 *   type: "draft",
 *   isDraft: true,
 * }} DraftCard
 */

/**
 * Closed card — release history.
 *
 * @typedef {CardBase & {
 *   type: "done",
 *   closedAt: string,
 *   mergeStatus: "MERGED" | "CLOSED",
 * }} DoneCard
 */

/**
 * Discriminated union of every card type the monitor renders.
 *
 * @typedef {PRCard
 *   | MissionCard
 *   | CodexTaskCard
 *   | DeployCard
 *   | DraftCard
 *   | DoneCard} BoardCard
 */

/**
 * The seven valid lane IDs. Exported as a frozen array so tests and
 * UI code can iterate without re-declaring the list.
 */
export const LANES = Object.freeze([
  "needs-attention",
  "drafts",
  "codex-needed",
  "hermes-checking",
  "operator-review",
  "release-queue",
  "deploying",
  "done",
]);

/**
 * The valid card-state values.
 */
export const CARD_STATES = Object.freeze([
  "fresh",
  "stale",
  "failed-fetch",
  "source-offline",
  "running",
]);

/**
 * The valid card-type values.
 */
export const CARD_TYPES = Object.freeze([
  "pr",
  "mission",
  "task",
  "deploy",
  "draft",
  "done",
]);
