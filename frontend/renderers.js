import { persistUiState, state } from "./state.js";
import { buildEvidenceTemplate, describeVerifier } from "./job-utils.js";
import { formatAmount, setActionStatus, setFeedback, setText } from "./ui-helpers.js";

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
            <span class="eligibility-pill ${entry.status === "resolved" ? "eligible-yes" : "eligible-no"}">
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

  claimButton.disabled = !hasJob;
  submitButton.disabled = !hasSession;
  verifyButton.disabled = !hasSession || sessionStatus === "claimed";
  refreshButton.disabled = !hasSession;

  if (!hasJob) {
    setActionStatus("Awaiting job", "status-pending");
    return;
  }

  if (hasVerification) {
    const approved = state.verification.outcome === "approved";
    setActionStatus(approved ? "Verified" : "Needs review", approved ? "status-ok" : "status-pending");
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
  setText("selected-verifier", job?.verifierMode ?? "-");
  setText("selected-schema", job?.outputSchemaRef ?? "-");
  setText(
    "selected-job-copy",
    job
      ? `${job.category} job, ${job.claimTtlSeconds}s claim TTL, ${job.retryLimit} retry limit.`
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

export function setPosterFeedback(message, tone = "neutral") {
  setFeedback("poster-feedback", message, tone);
}
