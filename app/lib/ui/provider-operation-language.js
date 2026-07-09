/**
 * Operator-readable labels for provider ingestion counters.
 *
 * The backend uses scheduler vocabulary (`candidate`, `created`, `skipped`,
 * `error`). The overview screen needs action vocabulary: what passed the
 * gates, what became work, what was safely ignored, and what needs
 * attention.
 *
 * Counter semantics (verified against mcp-server/src/jobs/ingest-*.js):
 *   candidateCount · items that SURVIVED policy, dedupe, and capacity
 *                    gates this run (post-gate, not raw discovery)
 *   skippedCount   · upstream items those gates filtered out
 *   → upstream items checked ≈ candidateCount + skippedCount
 * Labeling candidates as "found upstream / before gates" made rows like
 * "found 2, ignored 18" read as nonsense.
 */

/**
 * @typedef {"candidate" | "created" | "skipped" | "error"} ProviderOperationMetricKey
 *
 * @typedef {object} ProviderOperationLegendEntry
 * @property {ProviderOperationMetricKey} key
 * @property {string} label
 * @property {string} description
 *
 * @typedef {object} ProviderRunLike
 * @property {boolean} [dryRun]
 * @property {number} [candidateCount]
 * @property {number} [createdCount]
 * @property {number} [skippedCount]
 * @property {number} [errorCount]
 */

/** @type {ProviderOperationLegendEntry[]} */
export const PROVIDER_OPERATION_LEGEND = Object.freeze([
  {
    key: "candidate",
    label: "Passed gates",
    description: "Upstream items that survived policy, dedupe, and capacity gates this run.",
  },
  {
    key: "created",
    label: "Opened as jobs",
    description: "Items that became claimable work in the run lane.",
  },
  {
    key: "skipped",
    label: "Safely ignored",
    description: "Duplicates, capped work, dry-run items, or policy-filtered inputs.",
  },
  {
    key: "error",
    label: "Needs attention",
    description: "Provider failures or malformed inputs the operator should inspect.",
  },
]);

const METRIC_LABEL = Object.freeze(
  Object.fromEntries(PROVIDER_OPERATION_LEGEND.map((entry) => [entry.key, entry.label]))
);

/**
 * @param {ProviderOperationMetricKey} key
 * @returns {string}
 */
export function providerOperationMetricLabel(key) {
  return METRIC_LABEL[key] ?? key;
}

/**
 * @param {ProviderOperationMetricKey} key
 * @param {ProviderRunLike | undefined | null} run
 * @returns {number}
 */
export function providerOperationMetricValue(key, run) {
  if (!run || typeof run !== "object") return 0;
  switch (key) {
    case "candidate":
      return nonNegInt(run.candidateCount);
    case "created":
      return nonNegInt(run.createdCount);
    case "skipped":
      return nonNegInt(run.skippedCount);
    case "error":
      return nonNegInt(run.errorCount);
    default:
      return 0;
  }
}

/**
 * Turns the last-run counters into one readable operator sentence.
 *
 * @param {ProviderRunLike | undefined | null} run
 * @returns {string}
 */
export function formatProviderRunSummary(run) {
  if (!run || typeof run !== "object") return "No provider run has been recorded yet.";

  const passed = providerOperationMetricValue("candidate", run);
  const created = providerOperationMetricValue("created", run);
  const ignored = providerOperationMetricValue("skipped", run);
  const errors = providerOperationMetricValue("error", run);
  // candidateCount is post-gate; the operator-meaningful "checked" total
  // is survivors plus everything the gates filtered out.
  const checked = passed + ignored;
  const dryRunPrefix = run.dryRun ? "Dry run: " : "";

  if (errors > 0) {
    const verb = errors === 1 ? "needs" : "need";
    return `${dryRunPrefix}${plural(errors, "item")} ${verb} operator attention after checking ${plural(checked, "upstream item")}.`;
  }

  if (created > 0) {
    return `${dryRunPrefix}${plural(created, "job")} opened from ${plural(checked, "upstream item")}.`;
  }

  if (ignored > 0) {
    return `${dryRunPrefix}${plural(checked, "upstream item")} checked; ${plural(ignored, "item")} safely ignored.`;
  }

  return `${dryRunPrefix}${plural(checked, "upstream item")} checked; no new work opened.`;
}

/**
 * @param {number | undefined} value
 * @returns {number}
 */
function nonNegInt(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

/**
 * @param {number} count
 * @param {string} singular
 * @returns {string}
 */
function plural(count, singular) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
