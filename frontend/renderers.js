import { persistUiState, state } from "./state.js";
import { buildEvidenceTemplate, describeVerifier } from "./job-utils.js";
import { formatAmount, setActionStatus, setFeedback, setText } from "./ui-helpers.js";

function outcomeTone(status) {
  return ["approved", "resolved", "closed"].includes(status) ? "eligible-yes" : "eligible-no";
}

export function renderRecommendations(recommendations) {
  const root = document.getElementById("job-list");
  if (!root) return;

  if (!recommendations.length) {
    root.innerHTML = '<p class="empty-state">No recommendations returned for this wallet yet.</p>';
    return;
  }

  root.innerHTML = recommendations
    .map(
      (job) => `
        <article class="job-card ${job.jobId === state.selectedJobId ? "job-selected" : ""}">
          <div class="job-topline">
            <p class="job-id">${job.jobId}</p>
            <span class="eligibility-pill ${job.eligible ? "eligible-yes" : "eligible-no"}">
              ${job.eligible ? "Eligible" : "Blocked"}
            </span>
          </div>
          <div class="job-metrics">
            <span>Fit score ${job.fitScore}</span>
            <span>Net reward ${formatAmount(job.netReward)} DOT</span>
          </div>
          <div class="job-copy">
            <p>${job.explanation}</p>
          </div>
          <button class="job-select-button" type="button" data-job-id="${job.jobId}">
            ${job.jobId === state.selectedJobId ? "Selected" : "Select job"}
          </button>
        </article>
      `
    )
    .join("");
}

export function renderCatalog(jobs) {
  const root = document.getElementById("catalog-list");
  if (!root) return;

  if (!jobs.length) {
    root.innerHTML = '<p class="empty-state">No jobs are live yet.</p>';
    return;
  }

  root.innerHTML = jobs
    .map(
      (job) => `
        <article class="catalog-card ${job.id === state.selectedJobId ? "job-selected" : ""}">
          <div class="job-topline">
            <h3>${job.id}</h3>
            <span class="eligibility-pill ${job.requiresSponsoredGas ? "eligible-yes" : "eligible-no"}">
              ${job.requiresSponsoredGas ? "Sponsored gas" : "Self-funded gas"}
            </span>
          </div>
          <div class="catalog-meta">
            <span>${job.category}</span>
            <span>${job.tier}</span>
            <span>${formatAmount(job.rewardAmount)} ${job.rewardAsset}</span>
            <span>${job.verifierMode}</span>
          </div>
          <p>${describeVerifier(job)}</p>
          <button class="job-select-button" type="button" data-catalog-job-id="${job.id}">
            ${job.id === state.selectedJobId ? "Loaded in flow" : "Load in flow"}
          </button>
        </article>
      `
    )
    .join("");
}

export function renderHistory(entries) {
  const root = document.getElementById("history-list");
  if (!root) return;

  if (!entries.length) {
    root.innerHTML = '<p class="empty-state">No sessions recorded for this wallet yet.</p>';
    return;
  }

  root.innerHTML = entries
    .map(
      (entry) => `
        <article class="history-card ${entry.sessionId === state.session?.sessionId ? "job-selected" : ""}">
          <div class="job-topline">
            <p class="job-id">${entry.jobId}</p>
            <span class="eligibility-pill ${outcomeTone(entry.verification?.outcome ?? entry.status)}">
              ${entry.status}
            </span>
          </div>
          <div class="catalog-meta">
            <span>${entry.protocolHistory?.join(" / ") ?? "-"}</span>
            <span>${entry.verification?.outcome ?? "pending"}</span>
            <span>${entry.updatedAt ? new Date(entry.updatedAt).toLocaleString("en-CH", { dateStyle: "short", timeStyle: "short" }) : "-"}</span>
          </div>
          <p>${entry.sessionId}</p>
          <button class="job-select-button" type="button" data-session-id="${entry.sessionId}">
            ${entry.sessionId === state.session?.sessionId ? "Current session" : "Load session"}
          </button>
        </article>
      `
    )
    .join("");
}

export function renderJobDetail(job, jobHistory) {
  const summaryRoot = document.getElementById("job-detail-summary");
  const historyRoot = document.getElementById("job-detail-history");
  const historyCount = document.getElementById("job-detail-count");

  if (!summaryRoot || !historyRoot || !historyCount) return;

  if (!job) {
    summaryRoot.innerHTML = '<p class="empty-state">Select a job to inspect its verifier, rules, and recent runs.</p>';
    historyRoot.innerHTML = '<p class="empty-state">No job selected yet.</p>';
    historyCount.textContent = "Awaiting selection";
    return;
  }

  const approvedRuns = jobHistory.filter((entry) => entry.verification?.outcome === "approved").length;
  const latestRun = jobHistory[0];

  summaryRoot.innerHTML = `
    <div class="job-detail-grid">
      <div class="detail-stat">
        <dt>Tier</dt>
        <dd>${job.tier}</dd>
      </div>
      <div class="detail-stat">
        <dt>Claim TTL</dt>
        <dd>${job.claimTtlSeconds}s</dd>
      </div>
      <div class="detail-stat">
        <dt>Retry limit</dt>
        <dd>${job.retryLimit}</dd>
      </div>
      <div class="detail-stat">
        <dt>Gas</dt>
        <dd>${job.requiresSponsoredGas ? "Sponsored" : "Self-funded"}</dd>
      </div>
      <div class="detail-stat">
        <dt>Verifier</dt>
        <dd>${job.verifierMode}</dd>
      </div>
      <div class="detail-stat">
        <dt>Claim stake</dt>
        <dd>${formatAmount(job.preflight?.claimStake)} ${job.rewardAsset}</dd>
      </div>
      <div class="detail-stat">
        <dt>Runs / approved</dt>
        <dd>${jobHistory.length} / ${approvedRuns}</dd>
      </div>
      <div class="detail-stat detail-span">
        <dt>Output schema</dt>
        <dd>${job.outputSchemaRef}</dd>
      </div>
      <div class="detail-stat detail-span">
        <dt>Verifier rules</dt>
        <dd>${describeVerifier(job)}</dd>
      </div>
      <div class="detail-stat detail-span">
        <dt>Worker liquidity</dt>
        <dd>${formatAmount(job.preflight?.availableLiquidity)} ${job.rewardAsset} available before claim</dd>
      </div>
      <div class="detail-stat detail-span">
        <dt>Latest run</dt>
        <dd>${latestRun ? `${latestRun.status} · ${latestRun.verification?.reasonCode ?? "pending verification"}` : "No runs yet for this wallet."}</dd>
      </div>
    </div>
  `;

  historyCount.textContent = `${jobHistory.length} runs for this job`;

  if (!jobHistory.length) {
    historyRoot.innerHTML = '<p class="empty-state">No runs recorded for this job and wallet yet.</p>';
    return;
  }

  historyRoot.innerHTML = jobHistory
    .map(
      (entry) => `
        <article class="job-run-card ${entry.sessionId === state.session?.sessionId ? "job-selected" : ""}">
          <div class="job-topline">
            <p class="job-id">${entry.sessionId}</p>
            <span class="eligibility-pill ${outcomeTone(entry.verification?.outcome ?? entry.status)}">
              ${entry.verification?.outcome ?? entry.status}
            </span>
          </div>
          <div class="catalog-meta">
            <span>${entry.status}</span>
            <span>${entry.verification?.reasonCode ?? "pending"}</span>
            <span>${entry.updatedAt ? new Date(entry.updatedAt).toLocaleString("en-CH", { dateStyle: "short", timeStyle: "short" }) : "-"}</span>
          </div>
          <button class="job-select-button" type="button" data-session-id="${entry.sessionId}">
            ${entry.sessionId === state.session?.sessionId ? "Current run" : "Open run"}
          </button>
        </article>
      `
    )
    .join("");
}

export function renderCatalogJobActivity(job, entries) {
  const summaryRoot = document.getElementById("catalog-job-summary");
  const historyRoot = document.getElementById("catalog-job-history");
  const countRoot = document.getElementById("catalog-job-count");

  if (!summaryRoot || !historyRoot || !countRoot) return;

  if (!job) {
    summaryRoot.innerHTML = '<p class="empty-state">Load a catalog job to inspect poster-side activity and worker runs.</p>';
    historyRoot.innerHTML = '<p class="empty-state">No catalog job selected yet.</p>';
    countRoot.textContent = "Awaiting selection";
    return;
  }

  const approvedRuns = entries.filter((entry) => entry.verification?.outcome === "approved").length;
  const distinctWallets = new Set(entries.map((entry) => entry.wallet).filter(Boolean)).size;
  const latestRun = entries[0];

  summaryRoot.innerHTML = `
    <div class="job-detail-grid">
      <div class="detail-stat">
        <dt>Category</dt>
        <dd>${job.category}</dd>
      </div>
      <div class="detail-stat">
        <dt>Reward</dt>
        <dd>${formatAmount(job.rewardAmount)} ${job.rewardAsset}</dd>
      </div>
      <div class="detail-stat">
        <dt>Verifier</dt>
        <dd>${job.verifierMode}</dd>
      </div>
      <div class="detail-stat">
        <dt>Workers / approved</dt>
        <dd>${distinctWallets} / ${approvedRuns}</dd>
      </div>
      <div class="detail-stat detail-span">
        <dt>Poster summary</dt>
        <dd>${job.requiresSponsoredGas ? "Sponsored gas enabled" : "Workers self-fund gas"} · TTL ${job.claimTtlSeconds}s · retries ${job.retryLimit}</dd>
      </div>
      <div class="detail-stat detail-span">
        <dt>Latest run</dt>
        <dd>${latestRun ? `${latestRun.wallet ?? "unknown_wallet"} · ${latestRun.status} · ${latestRun.verification?.reasonCode ?? "pending verification"}` : "No runs recorded for this job yet."}</dd>
      </div>
    </div>
  `;

  countRoot.textContent = `${entries.length} runs across the catalog`;

  if (!entries.length) {
    historyRoot.innerHTML = '<p class="empty-state">No poster-side activity recorded for this job yet.</p>';
    return;
  }

  historyRoot.innerHTML = entries
    .map(
      (entry) => `
        <article class="job-run-card ${entry.sessionId === state.session?.sessionId ? "job-selected" : ""}">
          <div class="job-topline">
            <p class="job-id">${entry.wallet ?? "unknown_wallet"}</p>
            <span class="eligibility-pill ${outcomeTone(entry.verification?.outcome ?? entry.status)}">
              ${entry.verification?.outcome ?? entry.status}
            </span>
          </div>
          <div class="catalog-meta">
            <span>${entry.sessionId}</span>
            <span>${entry.verification?.reasonCode ?? "pending"}</span>
            <span>${entry.updatedAt ? new Date(entry.updatedAt).toLocaleString("en-CH", { dateStyle: "short", timeStyle: "short" }) : "-"}</span>
          </div>
          <button class="job-select-button" type="button" data-catalog-session-id="${entry.sessionId}" data-catalog-job-id="${entry.jobId}">
            ${entry.sessionId === state.session?.sessionId ? "Current run" : "Open run"}
          </button>
        </article>
      `
    )
    .join("");
}

export function updateReputation(reputation) {
  setText("rep-skill", formatAmount(reputation.skill));
  setText("rep-reliability", formatAmount(reputation.reliability));
  setText("rep-economic", formatAmount(reputation.economic));
  setText("tier-badge", reputation.tier ?? "starter");

  const badge = document.getElementById("tier-badge");
  if (!badge) return;
  badge.className = `tier-badge ${reputation.tier === "starter" ? "tier-warn" : "tier-ok"}`;
}

export function updateAccount(account) {
  setText("liquid-dot", formatAmount(account.liquid?.DOT));
  setText("reserved-dot", formatAmount(account.reserved?.DOT));
  setText("allocated-dot", formatAmount(account.strategyAllocated?.DOT));
  setText("staked-dot", formatAmount(account.jobStakeLocked?.DOT));
  setText("debt-dot", formatAmount(account.debtOutstanding?.DOT));
}

export function applySessionState(session = undefined) {
  state.session = session;
  setText("session-id", session?.sessionId ?? "-");
  setText("session-status", session?.status ?? "-");
  persistUiState();
}

export function applyVerificationState(result = undefined) {
  state.verification = result;
  setText("verification-outcome", result?.outcome ?? "-");
  setText("verification-reason", result?.reasonCode ?? "-");
  if (result?.session) {
    applySessionState(result.session);
  }
}

export function refreshActionPanel() {
  const claimButton = document.getElementById("claim-button");
  const submitButton = document.getElementById("submit-button");
  const verifyButton = document.getElementById("verify-button");
  const refreshButton = document.getElementById("refresh-session-button");

  const hasJob = Boolean(state.selectedJob);
  const sessionStatus = state.session?.status ?? "";
  const hasSession = Boolean(state.session?.sessionId);
  const hasSubmitted = sessionStatus === "submitted" || sessionStatus === "resolved" || sessionStatus === "verifying" || sessionStatus === "disputed";
  const hasVerification = Boolean(state.verification?.outcome);
  const canVerify = hasSession && sessionStatus === "submitted" && !hasVerification;

  claimButton.disabled = !hasJob;
  submitButton.disabled = !hasSession;
  verifyButton.disabled = !canVerify;
  refreshButton.disabled = !hasSession;

  if (!hasJob) {
    setActionStatus("Awaiting job", "status-pending");
    return;
  }

  if (hasVerification) {
    const approved = state.verification.outcome === "approved";
    const rejected = state.verification.outcome === "rejected";
    setActionStatus(
      approved ? "Verified" : rejected ? "Pending dispute window" : "Needs review",
      approved ? "status-ok" : "status-pending"
    );
    return;
  }

  if (sessionStatus === "rejected") {
    setActionStatus("Pending dispute window", "status-pending");
    return;
  }

  if (hasSubmitted) {
    setActionStatus("Submitted", "status-ok");
    return;
  }

  if (hasSession) {
    setActionStatus("Claimed", "status-ok");
    return;
  }

  setActionStatus("Ready", "status-pending");
}

export function updateSelectedJob(job) {
  const previousJobId = state.selectedJobId;
  state.selectedJob = job;
  state.selectedJobId = job?.id ?? "";
  setText("selected-job-id", job?.id ?? "-");
  setText("selected-reward", job ? `${formatAmount(job.rewardAmount)} ${job.rewardAsset}` : "-");
  setText("selected-claim-stake", job?.preflight ? `${formatAmount(job.preflight.claimStake)} ${job.rewardAsset}` : "-");
  setText("selected-liquidity", job?.preflight ? `${formatAmount(job.preflight.availableLiquidity)} ${job.rewardAsset}` : "-");
  setText("selected-verifier", job?.verifierMode ?? "-");
  setText("selected-schema", job?.outputSchemaRef ?? "-");
  setText(
    "selected-job-copy",
    job
      ? `${job.category} job, ${job.claimTtlSeconds}s claim TTL, ${job.retryLimit} retry limit, ${formatAmount(job.preflight?.claimStake ?? 0)} ${job.rewardAsset} stake.`
      : "Select a recommended job to load its requirements and run the claim-to-verify flow."
  );

  const evidenceInput = document.getElementById("evidence-input");
  if (evidenceInput && job && (previousJobId !== job.id || !evidenceInput.value.trim())) {
    evidenceInput.value = buildEvidenceTemplate(job);
  }

  renderRecommendations(state.recommendations);
  renderCatalog(state.catalog);
  persistUiState();
  refreshActionPanel();
}

export function setActionFeedback(message, tone = "neutral") {
  setFeedback("action-feedback", message, tone);
}

export function setWalletFeedback(message, tone = "neutral") {
  setFeedback("wallet-feedback", message, tone);
}

export function setFundingFeedback(message, tone = "neutral") {
  setFeedback("funding-feedback", message, tone);
}

export function setPosterFeedback(message, tone = "neutral") {
  setFeedback("poster-feedback", message, tone);
}
