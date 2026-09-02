function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = byId(id);
  if (el) el.textContent = value;
}

function setHref(id, value) {
  const el = byId(id);
  if (el) el.setAttribute("href", value);
}

const EXAMPLE_WALLET = "0xfd2eae2043243fddd2721c0b42af1b8284fd6519";

function extractWallet() {
  const url = new URL(window.location.href);
  const query = url.searchParams.get("wallet");
  if (query) return query.trim().toLowerCase();
  const match = url.pathname.match(/\/agents\/(0x[a-fA-F0-9]{40})\/?$/u);
  return match ? match[1].toLowerCase() : "";
}

function formatAmountFromBase(amountObj) {
  if (!amountObj) return "—";
  try {
    const raw = BigInt(amountObj.amount ?? "0");
    const decimals = BigInt(amountObj.decimals ?? 18);
    const base = 10n ** decimals;
    const whole = raw / base;
    const fraction = raw % base;
    const fractionText = fraction.toString().padStart(Number(decimals), "0").slice(0, 4).replace(/0+$/u, "");
    const number = fractionText ? `${whole}.${fractionText}` : whole.toString();
    return `${number} ${amountObj.asset ?? ""}`.trim();
  } catch {
    return "—";
  }
}

function formatIso(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-CH", { dateStyle: "medium", timeStyle: "short" });
}

/* ---------------------------------------------------------------- */
/* Trail summary helpers — see AVERRAY_WORKING_SPEC §10 reputation   */
/* deepening. Pure functions over the live badges list with honest   */
/* "—" fallbacks when nothing is computable.                          */
/* ---------------------------------------------------------------- */

const TIER_BUCKETS = [
  { id: "substantive", label: "Substantive", min: 5 },
  { id: "standard", label: "Standard", min: 2 },
  { id: "micro", label: "Micro", min: 0 },
];

function rewardToFloat(reward) {
  if (!reward) return 0;
  try {
    const raw = BigInt(reward.amount ?? "0");
    const decimals = BigInt(reward.decimals ?? 6);
    const base = 10n ** decimals;
    const whole = Number(raw / base);
    const fraction = Number(raw % base) / Number(base);
    return whole + fraction;
  } catch {
    return 0;
  }
}

function bucketBadgeByReward(badge) {
  const value = rewardToFloat(badge.reward);
  // Premium tier covers post-launch external posters paying within
  // published ranges; >$500 lands in Premium rather than overflowing
  // Substantive.
  if (value > 500) return "premium";
  if (value >= 5) return "substantive";
  if (value >= 2) return "standard";
  return "micro";
}

function computeTierBreakdown(badges) {
  const counts = { micro: 0, standard: 0, substantive: 0, premium: 0 };
  for (const badge of badges) {
    const id = bucketBadgeByReward(badge);
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

function renderTierBreakdown(badges) {
  const root = byId("profile-tier-breakdown");
  if (!root) return;
  if (!badges.length) {
    root.innerHTML = '<p class="profile-empty">No completions yet.</p>';
    return;
  }
  const counts = computeTierBreakdown(badges);
  const total = badges.length;
  const rows = [
    { id: "substantive", label: "Substantive", count: counts.substantive },
    { id: "standard", label: "Standard", count: counts.standard },
    { id: "micro", label: "Micro", count: counts.micro },
  ];
  if (counts.premium > 0) {
    rows.unshift({ id: "premium", label: "Premium", count: counts.premium });
  }
  root.innerHTML = rows
    .map((row) => {
      const pct = total > 0 ? Math.round((row.count / total) * 100) : 0;
      return `
        <div class="trail-tier-row" title="${row.label}: ${row.count} of ${total} badges">
          <span>${row.label}</span>
          <span class="trail-tier-bar tier-${row.id}"><i style="width:${pct}%"></i></span>
          <span>${row.count}</span>
        </div>
      `;
    })
    .join("");
}

const STREAK_BREAK_MS = 7 * 24 * 60 * 60 * 1000;

function computeStreak(badges) {
  if (!badges.length) return { count: 0 };
  const ordered = badges
    .map((badge) => Date.parse(badge.completedAt ?? ""))
    .filter((ts) => Number.isFinite(ts))
    .sort((a, b) => b - a); // newest-first
  if (!ordered.length) return { count: 0 };
  let count = 1;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i - 1] - ordered[i] > STREAK_BREAK_MS) break;
    count += 1;
  }
  return { count };
}

function streakTierFor(count) {
  if (count >= 25) return { id: "waiver", label: "fee waiver" };
  if (count >= 10) return { id: "badge", label: "streak badge" };
  if (count >= 1) return { id: "active", label: "active" };
  return null;
}

function renderStreak(badges, stats = {}) {
  const valueEl = byId("profile-streak-value");
  const suffixEl = byId("profile-streak-suffix");
  const metaEl = byId("profile-streak-meta");
  if (!valueEl || !suffixEl) return;
  const { count } = computeStreak(badges);
  const rejected = Number(stats.rejectedCount ?? 0);
  if (count === 0) {
    valueEl.textContent = "—";
    suffixEl.textContent = "no streak yet";
    if (metaEl) {
      metaEl.textContent = "Streak grows on each merged job; broken on a rejection or a 7-day gap.";
    }
    return;
  }
  valueEl.textContent = String(count);
  suffixEl.textContent = count === 1 ? "consecutive job" : "consecutive jobs";
  if (metaEl) {
    const tier = streakTierFor(count);
    const rejNote = rejected > 0
      ? ` ${rejected} rejection${rejected === 1 ? "" : "s"} on this wallet.`
      : "";
    const tierBadge = tier
      ? ` <span class="trail-streak-tier tier-${tier.id}">${tier.label}</span>`
      : "";
    metaEl.innerHTML = `Approximate from public badges (≤7-day gap).${rejNote}${tierBadge}`.trim();
  }
}

function badgeSourceKey(badge) {
  const source = badge.source && typeof badge.source === "object" ? badge.source : null;
  if (source) {
    if (typeof source.repo === "string" && source.repo) return { kind: "github", key: source.repo };
    if (typeof source.pageTitle === "string" && source.pageTitle) {
      return {
        kind: "wikipedia",
        key: `${source.language ?? "en"}.wikipedia / ${source.pageTitle}`,
      };
    }
    if (typeof source.datasetTitle === "string" && source.datasetTitle) {
      return { kind: "dataset", key: source.datasetTitle };
    }
  }
  const jobId = String(badge.jobId ?? "");
  if (jobId.startsWith("oss-")) {
    const parts = jobId.split("-");
    if (parts.length >= 4) return { kind: "github", key: `${parts[1]}/${parts[2]}` };
  }
  if (jobId.startsWith("wiki-")) {
    const parts = jobId.split("-");
    if (parts.length >= 3) return { kind: "wikipedia", key: `${parts[1]}.wikipedia / ${parts[2]}` };
  }
  if (jobId.startsWith("open-data-") || jobId.startsWith("openapi-") || jobId.startsWith("standards-")) {
    return { kind: "dataset", key: jobId.split("-").slice(1, 4).join("-") };
  }
  return { kind: "native", key: jobId || "unknown" };
}

function computePrimaryRepos(badges, limit = 3) {
  const counts = new Map();
  for (const badge of badges) {
    const { key, kind } = badgeSourceKey(badge);
    if (!key) continue;
    const existing = counts.get(key) ?? { key, kind, count: 0 };
    existing.count += 1;
    counts.set(key, existing);
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function renderPrimaryRepos(badges) {
  const root = byId("profile-primary-repos");
  if (!root) return;
  const repos = computePrimaryRepos(badges);
  if (!repos.length) {
    root.innerHTML = '<li class="profile-empty">No source attribution yet.</li>';
    return;
  }
  root.innerHTML = repos
    .map((entry) => `
      <li>
        <span title="${entry.kind}">${entry.key}</span>
        <span>${entry.count} ${entry.count === 1 ? "job" : "jobs"}</span>
      </li>
    `)
    .join("");
}

function computeMergeTime(badges) {
  const durations = [];
  for (const badge of badges) {
    const completed = Date.parse(badge.completedAt ?? "");
    const claimed = Date.parse(badge.claimedAt ?? badge.startedAt ?? "");
    if (!Number.isFinite(completed) || !Number.isFinite(claimed)) continue;
    if (completed < claimed) continue;
    durations.push(completed - claimed);
  }
  if (!durations.length) {
    return { median: null, sampleCount: 0, missing: badges.length };
  }
  durations.sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const median = durations.length % 2 === 0
    ? (durations[mid - 1] + durations[mid]) / 2
    : durations[mid];
  return {
    median,
    sampleCount: durations.length,
    missing: badges.length - durations.length,
  };
}

function formatDurationCompact(ms) {
  if (!Number.isFinite(ms) || ms < 0) return { value: "—", unit: "" };
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return { value: String(totalSeconds), unit: "s" };
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0
      ? { value: String(minutes), unit: "m" }
      : { value: `${minutes}m`, unit: `${seconds}s` };
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) {
    return remMinutes === 0
      ? { value: String(hours), unit: "h" }
      : { value: `${hours}h`, unit: `${remMinutes}m` };
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0
    ? { value: String(days), unit: "d" }
    : { value: `${days}d`, unit: `${remHours}h` };
}

function renderMergeTime(badges) {
  const valueEl = byId("profile-merge-value");
  const suffixEl = byId("profile-merge-suffix");
  const metaEl = byId("profile-merge-meta");
  if (!valueEl || !suffixEl) return;
  const stats = computeMergeTime(badges);
  if (stats.median == null) {
    valueEl.textContent = "—";
    suffixEl.textContent = "";
    if (metaEl) {
      metaEl.textContent = badges.length
        ? `Badges don't carry claim timestamps yet (${badges.length} missing).`
        : "Will populate once approved badges land.";
    }
    return;
  }
  const formatted = formatDurationCompact(stats.median);
  valueEl.textContent = formatted.value;
  suffixEl.textContent = formatted.unit;
  if (metaEl) {
    const missingNote = stats.missing > 0
      ? ` ${stats.missing} badge${stats.missing === 1 ? "" : "s"} missing claimedAt.`
      : "";
    metaEl.textContent = `Median across ${stats.sampleCount} approved badge${stats.sampleCount === 1 ? "" : "s"}.${missingNote}`;
  }
}

function renderTrailSummary(profile) {
  const badges = Array.isArray(profile.badges) ? profile.badges : [];
  renderTierBreakdown(badges);
  renderStreak(badges, profile.stats ?? {});
  renderPrimaryRepos(badges);
  renderMergeTime(badges);
}

/* ---------------------------------------------------------------- */
/* Dispute history — see AVERRAY_WORKING_SPEC §3 (arbitrator model)  */
/* and §10 (reputation deepening). Renders the slim disputes[] block */
/* from the wallet profile JSON: status pill, opened/window-ends     */
/* timestamps, verdict + reason code, and an on-chain link when the  */
/* arbitrator's release receipt has a tx hash. Public read; heavy    */
/* fields (full evidence, signed receipt body) live behind           */
/* `/disputes/<id>` and require auth.                                 */
/* ---------------------------------------------------------------- */

const DISPUTE_VERDICT_PILL = {
  upheld:    { variant: "lost",   label: "Worker lost" },
  dismissed: { variant: "won",    label: "Worker won" },
  split:     { variant: "split",  label: "Split award" },
  timeout:   { variant: "timeout", label: "Arbitrator timeout" },
};

const DISPUTE_REASON_LABEL = {
  DISPUTE_LOST:        "Dispute upheld — escrow slashed to treasury",
  DISPUTE_OVERTURNED:  "Dispute dismissed — escrow returned to depositor",
  DISPUTE_PARTIAL:     "Split verdict — partial payout to worker",
  ARB_TIMEOUT:         "Arbitrator SLA elapsed — escrow auto-released",
};

function disputeStatusPill(dispute) {
  if (dispute.status === "open") {
    return { variant: "open", label: "Open" };
  }
  const verdict = String(dispute.verdict ?? "").toLowerCase();
  if (DISPUTE_VERDICT_PILL[verdict]) {
    return DISPUTE_VERDICT_PILL[verdict];
  }
  return { variant: "resolved", label: "Resolved" };
}

function formatSlaWindow(slaSeconds) {
  if (!Number.isFinite(slaSeconds) || slaSeconds <= 0) return "—";
  const days = Math.round(slaSeconds / 86400);
  return `${days}-day SLA`;
}

function formatPayoutString(value) {
  if (value === undefined || value === null || value === "") return "—";
  const text = String(value);
  // Heuristic: when the raw integer looks like a base-unit balance
  // (≥7 digits) we don't try to scale it without decimals metadata —
  // we render as-is so we never misrepresent the amount.
  return text;
}

function renderDisputeRow(dispute) {
  const pill = disputeStatusPill(dispute);
  const reasonLine = dispute.reasonCode && DISPUTE_REASON_LABEL[dispute.reasonCode]
    ? DISPUTE_REASON_LABEL[dispute.reasonCode]
    : null;
  const title = dispute.jobTitle ? `${dispute.jobTitle}` : dispute.jobId;
  const detailRows = [];
  detailRows.push(`
    <div class="verify-row">
      <span class="verify-label">Opened</span>
      <span class="verify-value" title="${escapeHtml(dispute.openedAt ?? "")}">${escapeHtml(formatIso(dispute.openedAt))}</span>
    </div>
  `);
  if (dispute.windowEndsAt) {
    detailRows.push(`
      <div class="verify-row">
        <span class="verify-label">Window ends</span>
        <span class="verify-value" title="${escapeHtml(dispute.windowEndsAt)}">${escapeHtml(formatIso(dispute.windowEndsAt))} · ${escapeHtml(formatSlaWindow(dispute.slaSeconds))}</span>
      </div>
    `);
  }
  if (dispute.verdict) {
    detailRows.push(`
      <div class="verify-row">
        <span class="verify-label">Verdict</span>
        <span class="verify-value">${escapeHtml(dispute.verdict)}${dispute.reasonCode ? ` · <code>${escapeHtml(dispute.reasonCode)}</code>` : ""}</span>
      </div>
    `);
  }
  if (dispute.workerPayout !== undefined && dispute.workerPayout !== null && dispute.workerPayout !== "") {
    detailRows.push(`
      <div class="verify-row">
        <span class="verify-label">Worker payout</span>
        <code class="verify-value">${escapeHtml(formatPayoutString(dispute.workerPayout))}</code>
      </div>
    `);
  }
  if (dispute.releasedAt) {
    detailRows.push(`
      <div class="verify-row">
        <span class="verify-label">Released</span>
        <span class="verify-value" title="${escapeHtml(dispute.releasedAt)}">${escapeHtml(formatIso(dispute.releasedAt))}</span>
      </div>
    `);
  }
  if (dispute.txHash) {
    detailRows.push(`
      <div class="verify-row">
        <span class="verify-label">On-chain receipt</span>
        <a class="verify-link" href="${escapeHtml(subscanExtrinsicSearchUrl(dispute.txHash))}" target="_blank" rel="noreferrer">
          <code>${escapeHtml(shortHash(dispute.txHash))}</code> ↗
        </a>
      </div>
    `);
  }

  return `
    <article class="dispute-row dispute-row-${escapeHtml(pill.variant)}">
      <header class="dispute-row-header">
        <div class="dispute-row-title">
          <p class="eyebrow">${escapeHtml(dispute.id ?? "dispute")}</p>
          <h3>${escapeHtml(title)}</h3>
          <p class="dispute-row-job"><code>${escapeHtml(dispute.jobId)}</code> · session <code>${escapeHtml(dispute.sessionId)}</code></p>
        </div>
        <span class="dispute-pill dispute-pill-${escapeHtml(pill.variant)}">${escapeHtml(pill.label)}</span>
      </header>
      ${reasonLine ? `<p class="dispute-row-reason">${escapeHtml(reasonLine)}</p>` : ""}
      <div class="verify-rows dispute-row-rows">${detailRows.join("")}</div>
    </article>
  `;
}

function renderDisputeOutcomes(outcomes, total) {
  const root = byId("profile-dispute-outcomes");
  if (!root) return;
  if (!total || total <= 0) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  const cells = [
    { id: "open",    label: "Open",      count: outcomes.open ?? 0 },
    { id: "won",     label: "Won",       count: outcomes.won ?? 0 },
    { id: "lost",    label: "Lost",      count: outcomes.lost ?? 0 },
    { id: "split",   label: "Split",     count: outcomes.split ?? 0 },
    { id: "timeout", label: "Timeout",   count: outcomes.timeout ?? 0 },
  ].filter((cell) => cell.count > 0);
  if (cells.length === 0) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  root.hidden = false;
  root.innerHTML = cells
    .map((cell) => `
      <div class="dispute-outcome dispute-outcome-${escapeHtml(cell.id)}">
        <span class="dispute-outcome-label">${escapeHtml(cell.label)}</span>
        <strong class="dispute-outcome-count">${cell.count}</strong>
      </div>
    `)
    .join("");
}

function renderDisputeHistory(profile) {
  const root = byId("profile-disputes");
  const countEl = byId("profile-dispute-count");
  if (!root) return;
  const disputes = Array.isArray(profile.disputes) ? profile.disputes : [];
  const outcomes = profile.stats?.disputes ?? {};
  const total = Number(outcomes.total ?? disputes.length ?? 0);

  renderDisputeOutcomes(outcomes, total);

  if (countEl) {
    if (total <= 0) {
      countEl.textContent = "no disputes yet";
    } else {
      countEl.textContent = `${total} arbitrated session${total === 1 ? "" : "s"}`;
    }
  }

  if (!disputes.length) {
    root.innerHTML = '<p class="profile-empty">No arbitrated sessions on this wallet yet.</p>';
    return;
  }
  root.innerHTML = disputes.map((dispute) => renderDisputeRow(dispute)).join("");
}

/* ---------------------------------------------------------------- */
/* One-click verification — spec §10 PR B. Each badge card carries  */
/* a "Verify receipt" disclosure exposing the source URL, on-chain  */
/* hash, verifier verdict timestamp, verifier address, and Subscan  */
/* deeplinks so the receipt is auditable in two clicks.             */
/* Subscan URLs from Polkadot docs MCP:                              */
/*   - mainnet: https://assethub-polkadot.subscan.io                 */
/*   - testnet: https://assethub-paseo.subscan.io                    */
/* ---------------------------------------------------------------- */

const SUBSCAN_BASE_URL = "https://assethub-polkadot.subscan.io";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortHash(value, head = 8, tail = 6) {
  if (!value) return "—";
  const s = String(value);
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function subscanAddressUrl(address) {
  return `${SUBSCAN_BASE_URL}/account/${encodeURIComponent(address)}`;
}

function subscanExtrinsicSearchUrl(hash) {
  // For arbitrary bytes32 hashes (chainJobId / evidenceHash) the
  // canonical search endpoint accepts the value as a query and
  // resolves to the matching block / extrinsic / event when it
  // exists on-chain.
  return `${SUBSCAN_BASE_URL}/search?q=${encodeURIComponent(hash)}`;
}

function verifySourceLabel(kind) {
  switch (kind) {
    case "wikipedia_article": return "Wikipedia revision";
    case "github_issue": return "GitHub issue";
    case "osv_advisory": return "OSV advisory";
    case "open_data_dataset": return "Data.gov resource";
    case "openapi_spec": return "OpenAPI spec";
    case "standards_spec": return "Standards spec";
    default: return "Source";
  }
}

function renderVerifyPanel(badge) {
  const v = badge.verification;
  if (!v) {
    return '<p class="profile-empty verify-empty">No verification details yet for this badge.</p>';
  }
  const rows = [];
  if (v.sourceUrl) {
    rows.push(`
      <div class="verify-row">
        <span class="verify-label">${escapeHtml(verifySourceLabel(v.sourceKind))}</span>
        <a class="verify-link" href="${escapeHtml(v.sourceUrl)}" target="_blank" rel="noreferrer">Open upstream ↗</a>
      </div>
    `);
  }
  if (badge.completedAt) {
    rows.push(`
      <div class="verify-row">
        <span class="verify-label">Verifier verdict</span>
        <span class="verify-value" title="${escapeHtml(badge.completedAt)}">${escapeHtml(formatIso(badge.completedAt))}</span>
      </div>
    `);
  }
  if (v.verifierMode) {
    rows.push(`
      <div class="verify-row">
        <span class="verify-label">Mode</span>
        <code class="verify-value">${escapeHtml(v.verifierMode)}</code>
      </div>
    `);
  }
  if (v.verifier) {
    rows.push(`
      <div class="verify-row">
        <span class="verify-label">Verifier wallet</span>
        <a class="verify-link" href="${escapeHtml(subscanAddressUrl(v.verifier))}" target="_blank" rel="noreferrer">
          <code>${escapeHtml(shortHash(v.verifier, 6, 4))}</code> ↗
        </a>
      </div>
    `);
  }
  if (v.chainJobId) {
    rows.push(`
      <div class="verify-row">
        <span class="verify-label">On-chain job</span>
        <a class="verify-link" href="${escapeHtml(subscanExtrinsicSearchUrl(v.chainJobId))}" target="_blank" rel="noreferrer">
          <code>${escapeHtml(shortHash(v.chainJobId))}</code> ↗
        </a>
      </div>
    `);
  }
  if (v.evidenceHash) {
    rows.push(`
      <div class="verify-row">
        <span class="verify-label">Evidence hash</span>
        <a class="verify-link" href="${escapeHtml(subscanExtrinsicSearchUrl(v.evidenceHash))}" target="_blank" rel="noreferrer">
          <code>${escapeHtml(shortHash(v.evidenceHash))}</code> ↗
        </a>
      </div>
    `);
  }
  if (rows.length === 0) {
    return '<p class="profile-empty verify-empty">No verification details yet for this badge.</p>';
  }
  return `<div class="verify-rows">${rows.join("")}</div>`;
}

/* ---------------------------------------------------------------- */
/* Sub-contracting history — see CORE_FRAMEWORK_ROADMAP §8. Reads    */
/* the live `profile.lineage` block emitted by the agent profile    */
/* builder (delegated[] + subcontracted[]) and renders two columns: */
/* parent jobs this wallet posted, and child jobs this wallet       */
/* worked on someone else's behalf. Each row stays compact: jobId,  */
/* counterparty wallet, status, updatedAt. Empty state speaks       */
/* honestly ("no sub-contracting yet") rather than inventing rows.  */
/* ---------------------------------------------------------------- */

const LINEAGE_STATUS_TONE = {
  resolved: "won",
  rejected: "lost",
  disputed: "open",
  open: "open",
  paused: "open",
  archived: "split",
  stale: "split"
};

function renderLineageStatusPill(status) {
  const key = String(status ?? "").toLowerCase();
  const variant = LINEAGE_STATUS_TONE[key] ?? "resolved";
  return `<span class="dispute-pill dispute-pill-${escapeHtml(variant)}">${escapeHtml(key || "unknown")}</span>`;
}

function renderDelegatedRow(entry) {
  const childCount = entry?.children?.count ?? 0;
  const jobIds = Array.isArray(entry?.children?.jobIds) ? entry.children.jobIds : [];
  return `
    <article class="lineage-row lineage-row-parent">
      <header class="lineage-row-header">
        <div class="lineage-row-title">
          <p class="eyebrow">Parent</p>
          <h3>${escapeHtml(entry.jobTitle ?? entry.jobId)}</h3>
          <p class="lineage-row-meta">
            <code>${escapeHtml(entry.jobId)}</code> · session
            <code>${escapeHtml(entry.sessionId)}</code>
          </p>
        </div>
        ${renderLineageStatusPill(entry.status)}
      </header>
      <p class="lineage-row-summary">
        Delegated <strong>${childCount}</strong>
        sub-job${childCount === 1 ? "" : "s"} on
        <span title="${escapeHtml(entry.updatedAt ?? "")}">${escapeHtml(formatIso(entry.updatedAt))}</span>.
      </p>
      ${jobIds.length
        ? `<ul class="lineage-row-jobs">${jobIds
            .slice(0, 5)
            .map((id) => `<li><code>${escapeHtml(id)}</code></li>`)
            .join("")}${jobIds.length > 5 ? `<li class="lineage-row-jobs-more">+${jobIds.length - 5} more</li>` : ""}</ul>`
        : ""}
    </article>
  `;
}

function renderSubcontractedRow(entry) {
  const parent = entry?.parent ?? {};
  const counterparty = parent.wallet
    ? `<a class="verify-link" href="/agents/${escapeHtml(parent.wallet)}"><code>${escapeHtml(shortHash(parent.wallet, 6, 4))}</code> ↗</a>`
    : '<span class="verify-value">—</span>';
  return `
    <article class="lineage-row lineage-row-child">
      <header class="lineage-row-header">
        <div class="lineage-row-title">
          <p class="eyebrow">Sub-contractor</p>
          <h3>${escapeHtml(entry.jobTitle ?? entry.jobId)}</h3>
          <p class="lineage-row-meta">
            <code>${escapeHtml(entry.jobId)}</code> · session
            <code>${escapeHtml(entry.sessionId)}</code>
          </p>
        </div>
        ${renderLineageStatusPill(entry.status)}
      </header>
      <p class="lineage-row-summary">
        ${parent.isSelf ? "Self-delegated from" : "Posted by"}
        ${counterparty}
        ${parent.jobId ? `· parent job <code>${escapeHtml(parent.jobId)}</code>` : ""}
        on <span title="${escapeHtml(entry.updatedAt ?? "")}">${escapeHtml(formatIso(entry.updatedAt))}</span>.
      </p>
    </article>
  `;
}

function renderLineageHistory(profile) {
  const summary = byId("profile-lineage-summary");
  const delegatedRoot = byId("profile-lineage-delegated");
  const subcontractedRoot = byId("profile-lineage-subcontracted");
  const delegatedCount = byId("profile-lineage-delegated-count");
  const subcontractedCount = byId("profile-lineage-subcontracted-count");

  const lineage = profile.lineage ?? {};
  const delegated = Array.isArray(lineage.delegated) ? lineage.delegated : [];
  const subcontracted = Array.isArray(lineage.subcontracted) ? lineage.subcontracted : [];
  const stats = profile.stats?.lineage ?? {};
  const totalDelegated = Number(stats.delegated ?? delegated.length ?? 0);
  const totalSubcontracted = Number(stats.subcontracted ?? subcontracted.length ?? 0);

  if (delegatedCount) delegatedCount.textContent = `(${totalDelegated})`;
  if (subcontractedCount) subcontractedCount.textContent = `(${totalSubcontracted})`;

  if (summary) {
    if (totalDelegated <= 0 && totalSubcontracted <= 0) {
      summary.textContent = "no sub-contracting yet";
    } else {
      const parts = [];
      if (totalDelegated > 0) parts.push(`${totalDelegated} delegated`);
      if (totalSubcontracted > 0) parts.push(`${totalSubcontracted} subcontracted`);
      summary.textContent = parts.join(" · ");
    }
  }

  if (delegatedRoot) {
    if (delegated.length === 0) {
      delegatedRoot.innerHTML = '<p class="profile-empty">No sub-jobs posted from this wallet yet.</p>';
    } else {
      delegatedRoot.innerHTML = delegated.map(renderDelegatedRow).join("");
    }
  }

  if (subcontractedRoot) {
    if (subcontracted.length === 0) {
      subcontractedRoot.innerHTML = '<p class="profile-empty">No sub-jobs claimed by this wallet yet.</p>';
    } else {
      subcontractedRoot.innerHTML = subcontracted.map(renderSubcontractedRow).join("");
    }
  }
}

function renderBadges(badges = []) {
  const root = byId("profile-badges");
  if (!root) return;
  if (!badges.length) {
    root.innerHTML = '<p class="profile-empty">No approved badges yet. Once this wallet completes a verifier-approved run, badges will appear here.</p>';
    return;
  }

  root.innerHTML = badges
    .map((badge) => `
    <article class="badge-card">
      <p class="eyebrow">Badge</p>
      <h3>${escapeHtml(badge.jobId)}</h3>
      <div class="badge-meta">
        <span>${escapeHtml(badge.category)} · level ${escapeHtml(badge.level)}</span>
        <span>${escapeHtml(formatAmountFromBase(badge.reward))}</span>
        <span>${escapeHtml(formatIso(badge.completedAt))}</span>
      </div>
      <details class="verify-disclosure">
        <summary>Verify receipt</summary>
        ${renderVerifyPanel(badge)}
      </details>
      <div class="link-row">
        <a class="button-ghost" href="${escapeHtml(badge.badgeUrl ?? "#")}" target="_blank" rel="noreferrer">Open badge JSON</a>
      </div>
    </article>
  `)
    .join("");
}

async function bootProfile() {
  const wallet = extractWallet();
  const loading = byId("profile-loading");
  if (!/^0x[a-f0-9]{40}$/u.test(wallet)) {
    if (loading) {
      loading.innerHTML = `No wallet specified. Open this page with <code>?wallet=0x…</code> or try <a href="/agents/${EXAMPLE_WALLET}">the example wallet profile</a>.`;
    }
    return;
  }

  setText("profile-wallet", wallet);
  setHref("profile-json-url", `https://api.averray.com/agents/${wallet}`);

  try {
    const response = await fetch(`https://api.averray.com/agents/${wallet}`, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Profile lookup returned ${response.status}`);
    }
    const profile = await response.json();
    if (loading) loading.hidden = true;
    setText("profile-title", `Agent ${wallet.slice(0, 8)}…${wallet.slice(-4)}`);
    document.title = `Averray — ${wallet.slice(0, 8)}…${wallet.slice(-4)}`;
    setText("profile-tier", (profile.reputation?.tier ?? "starter").toUpperCase());
    setText("profile-skill", String(profile.reputation?.skill ?? 0));
    setText("profile-reliability", String(profile.reputation?.reliability ?? 0));
    setText("profile-economic", String(profile.reputation?.economic ?? 0));
    setText("profile-total-badges", String(profile.stats?.totalBadges ?? 0));
    setText("profile-approved", String(profile.stats?.approvedCount ?? 0));
    setText("profile-rejected", String(profile.stats?.rejectedCount ?? 0));
    setText("profile-completion-rate", profile.stats?.completionRate == null ? "—" : `${Math.round(profile.stats.completionRate * 100)}%`);
    setText("profile-total-earned", formatAmountFromBase(profile.stats?.totalEarned));
    setText("profile-active-since", formatIso(profile.stats?.activeSince));
    setText("profile-last-active", formatIso(profile.stats?.lastActive));
    setText(
      "profile-preferred-categories",
      Array.isArray(profile.stats?.preferredCategories) && profile.stats.preferredCategories.length
        ? profile.stats.preferredCategories.map((entry) => `${entry.category} (${entry.count})`).join(" · ")
        : "No preferred categories yet."
    );
    setText(
      "profile-category-levels",
      Object.keys(profile.categoryLevels ?? {}).length
        ? Object.entries(profile.categoryLevels).map(([category, level]) => `${category} · lvl ${level}`).join(" · ")
        : "No category levels yet."
    );
    renderTrailSummary(profile);
    renderDisputeHistory(profile);
    renderLineageHistory(profile);
    renderBadges(profile.badges);
  } catch (error) {
    if (loading) loading.textContent = error?.message ?? "Failed to load profile.";
  }
}

bootProfile();
