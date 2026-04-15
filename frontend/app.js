const DEFAULT_WALLET = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519";
const UI_STATE_KEY = "averray:ui-state";

const state = {
  wallet: DEFAULT_WALLET,
  recommendations: [],
  selectedJobId: "",
  selectedJob: undefined,
  session: undefined,
  verification: undefined
};

const formatAmount = (value) => {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "-";
};

const setText = (id, value) => {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
};

const setOverallStatus = (label, className) => {
  const pill = document.getElementById("system-pill");
  if (!pill) return;
  pill.textContent = label;
  pill.className = `status-pill ${className}`;
};

const setActionStatus = (label, className) => {
  const pill = document.getElementById("action-pill");
  if (!pill) return;
  pill.textContent = label;
  pill.className = `status-pill ${className}`;
};

function persistUiState() {
  localStorage.setItem(
    UI_STATE_KEY,
    JSON.stringify({
      wallet: state.wallet,
      selectedJobId: state.selectedJobId,
      sessionId: state.session?.sessionId ?? ""
    })
  );
}

function readPersistedState() {
  try {
    return JSON.parse(localStorage.getItem(UI_STATE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

async function requestJson(path, init = {}) {
  const response = await fetch(path, {
    headers: { accept: "application/json" },
    ...init
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    throw new Error(payload?.error ?? payload?.status ?? `${path} returned ${response.status}`);
  }

  return payload;
}

async function readJson(path) {
  return requestJson(path);
}

async function postJson(path) {
  return requestJson(path, { method: "POST" });
}

function buildEvidenceTemplate(job) {
  if (!job) return "";

  if (job.verifierConfig?.handler === "benchmark") {
    return `complete verified output for ${job.id}`;
  }

  if (job.verifierConfig?.handler === "deterministic") {
    return (job.verifierConfig.expectedOutputs ?? []).join(" ");
  }

  return `submission for ${job.id}`;
}

function renderRecommendations(recommendations) {
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

function updateReputation(reputation) {
  setText("rep-skill", formatAmount(reputation.skill));
  setText("rep-reliability", formatAmount(reputation.reliability));
  setText("rep-economic", formatAmount(reputation.economic));
  setText("tier-badge", reputation.tier ?? "starter");

  const badge = document.getElementById("tier-badge");
  if (!badge) return;
  badge.className = `tier-badge ${reputation.tier === "starter" ? "tier-warn" : "tier-ok"}`;
}

function updateAccount(account) {
  setText("liquid-dot", formatAmount(account.liquid?.DOT));
  setText("reserved-dot", formatAmount(account.reserved?.DOT));
  setText("allocated-dot", formatAmount(account.strategyAllocated?.DOT));
  setText("debt-dot", formatAmount(account.debtOutstanding?.DOT));
}

function applySessionState(session = undefined) {
  state.session = session;
  setText("session-id", session?.sessionId ?? "-");
  setText("session-status", session?.status ?? "-");
  persistUiState();
}

function applyVerificationState(result = undefined) {
  state.verification = result;
  setText("verification-outcome", result?.outcome ?? "-");
  setText("verification-reason", result?.reasonCode ?? "-");
  if (result?.session) {
    applySessionState(result.session);
  }
}

function refreshActionPanel() {
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

function updateSelectedJob(job) {
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

  persistUiState();
  refreshActionPanel();
}

async function restoreSession(sessionId) {
  if (!sessionId) {
    applySessionState(undefined);
    applyVerificationState(undefined);
    refreshActionPanel();
    return;
  }

  const session = await readJson(`/api/session?sessionId=${encodeURIComponent(sessionId)}`);
  applySessionState(session);

  try {
    const result = await readJson(`/api/verifier/result?sessionId=${encodeURIComponent(sessionId)}`);
    if (result?.status !== "not_found") {
      applyVerificationState(result);
    } else {
      applyVerificationState(undefined);
    }
  } catch {
    applyVerificationState(undefined);
  }

  refreshActionPanel();
}

async function selectJob(jobId) {
  const job = await readJson(`/api/jobs/definition?jobId=${encodeURIComponent(jobId)}`);
  updateSelectedJob(job);
  renderRecommendations(state.recommendations);

  const persisted = readPersistedState();
  const expectedSessionId = persisted.wallet === state.wallet && persisted.selectedJobId === job.id
    ? persisted.sessionId
    : "";

  if (expectedSessionId) {
    try {
      await restoreSession(expectedSessionId);
      setText("action-feedback", `Restored prior session ${expectedSessionId}.`);
      return;
    } catch {
      applySessionState(undefined);
      applyVerificationState(undefined);
    }
  }

  applySessionState(undefined);
  applyVerificationState(undefined);
  setText("action-feedback", `Loaded ${job.id}. Claim it when you are ready.`);
  refreshActionPanel();
}

async function loadWallet(wallet) {
  state.wallet = wallet;
  setText("wallet-feedback", "Refreshing live operator view...");

  const [account, reputation, recommendations] = await Promise.all([
    readJson(`/api/account?wallet=${encodeURIComponent(wallet)}`),
    readJson(`/api/reputation?wallet=${encodeURIComponent(wallet)}`),
    readJson(`/api/jobs/recommendations?wallet=${encodeURIComponent(wallet)}`)
  ]);

  state.recommendations = recommendations;

  updateAccount(account);
  updateReputation(reputation);
  renderRecommendations(recommendations);
  setText("job-count", `${recommendations.length} recommendations`);
  setText("wallet-feedback", `Loaded live data for ${wallet}.`);
  localStorage.setItem("averray:last-wallet", wallet);

  const persisted = readPersistedState();
  const nextJobId = recommendations.some((job) => job.jobId === persisted.selectedJobId)
    ? persisted.selectedJobId
    : recommendations[0]?.jobId ?? "";

  if (nextJobId) {
    await selectJob(nextJobId);
  } else {
    updateSelectedJob(undefined);
    setText("action-feedback", "No action flow available until recommendations appear.");
  }
}

async function claimSelectedJob() {
  if (!state.selectedJobId) return;

  const idempotencyKey = `ui:${state.wallet}:${state.selectedJobId}`;
  setText("action-feedback", `Claiming ${state.selectedJobId}...`);

  const session = await postJson(
    `/api/jobs/claim?wallet=${encodeURIComponent(state.wallet)}&jobId=${encodeURIComponent(state.selectedJobId)}&idempotencyKey=${encodeURIComponent(idempotencyKey)}`
  );

  applySessionState(session);
  applyVerificationState(undefined);
  setText("action-feedback", `Claimed ${state.selectedJobId}. Session ${session.sessionId} is ready for submission.`);
  refreshActionPanel();
}

async function submitSelectedWork() {
  if (!state.session?.sessionId) return;

  const evidenceInput = document.getElementById("evidence-input");
  const evidence = evidenceInput?.value?.trim() || buildEvidenceTemplate(state.selectedJob);

  setText("action-feedback", `Submitting work for ${state.session.sessionId}...`);
  const session = await postJson(
    `/api/jobs/submit?sessionId=${encodeURIComponent(state.session.sessionId)}&evidence=${encodeURIComponent(evidence)}`
  );

  applySessionState(session);
  setText("action-feedback", "Submission stored. Run the verifier to settle the result.");
  refreshActionPanel();
}

async function verifySelectedWork() {
  if (!state.session?.sessionId) return;

  const evidenceInput = document.getElementById("evidence-input");
  const evidence = evidenceInput?.value?.trim() || buildEvidenceTemplate(state.selectedJob);

  setText("action-feedback", `Running verifier for ${state.session.sessionId}...`);
  const result = await postJson(
    `/api/verifier/run?sessionId=${encodeURIComponent(state.session.sessionId)}&evidence=${encodeURIComponent(evidence)}`
  );

  applyVerificationState(result);
  setText(
    "action-feedback",
    result.outcome === "approved"
      ? `Verifier approved the submission with ${result.reasonCode}.`
      : `Verifier returned ${result.outcome} with ${result.reasonCode}.`
  );
  refreshActionPanel();
}

async function refreshCurrentSession() {
  if (!state.session?.sessionId) return;

  setText("action-feedback", `Refreshing ${state.session.sessionId}...`);
  await restoreSession(state.session.sessionId);
  setText("action-feedback", `Refreshed session ${state.session.sessionId}.`);
}

async function boot() {
  const walletInput = document.getElementById("wallet-input");
  const walletForm = document.getElementById("wallet-form");
  const jobList = document.getElementById("job-list");
  const claimButton = document.getElementById("claim-button");
  const submitButton = document.getElementById("submit-button");
  const verifyButton = document.getElementById("verify-button");
  const refreshButton = document.getElementById("refresh-session-button");
  const initialWallet = localStorage.getItem("averray:last-wallet") || DEFAULT_WALLET;

  if (walletInput) walletInput.value = initialWallet;

  try {
    const [health, onboarding, index] = await Promise.all([
      readJson("/api/health"),
      readJson("/api/onboarding"),
      readJson("/index/")
    ]);

    setText("api-status", health.status === "ok" ? "Healthy" : "Unexpected");
    setText("index-status", index.status === "ok" ? "Serving" : "Unexpected");
    setText("protocol-status", onboarding.protocols.join(" / ").toUpperCase());
    setText("starter-flow", `${onboarding.onboarding.starterFlow.length} live steps`);
    setOverallStatus("Online", "status-ok");
  } catch (error) {
    console.error(error);
    setText("api-status", "Unavailable");
    setText("index-status", "Unavailable");
    setText("protocol-status", "Check routes");
    setText("starter-flow", "Waiting for API");
    setOverallStatus("Attention needed", "status-pending");
  }

  try {
    await loadWallet(initialWallet);
  } catch (error) {
    console.error(error);
    setText("wallet-feedback", error.message ?? "Failed to load wallet data.");
    renderRecommendations([]);
  }

  walletForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const wallet = walletInput?.value?.trim();
    if (!wallet) {
      setText("wallet-feedback", "Enter a wallet address first.");
      return;
    }

    try {
      await loadWallet(wallet);
    } catch (error) {
      console.error(error);
      setText("wallet-feedback", error.message ?? "Failed to load wallet data.");
    }
  });

  jobList?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-job-id]");
    if (!button) return;

    try {
      await selectJob(button.dataset.jobId);
    } catch (error) {
      console.error(error);
      setText("action-feedback", error.message ?? "Failed to load job definition.");
    }
  });

  claimButton?.addEventListener("click", async () => {
    try {
      await claimSelectedJob();
    } catch (error) {
      console.error(error);
      setText("action-feedback", error.message ?? "Claim failed.");
    }
  });

  submitButton?.addEventListener("click", async () => {
    try {
      await submitSelectedWork();
    } catch (error) {
      console.error(error);
      setText("action-feedback", error.message ?? "Submit failed.");
    }
  });

  verifyButton?.addEventListener("click", async () => {
    try {
      await verifySelectedWork();
    } catch (error) {
      console.error(error);
      setText("action-feedback", error.message ?? "Verification failed.");
    }
  });

  refreshButton?.addEventListener("click", async () => {
    try {
      await refreshCurrentSession();
    } catch (error) {
      console.error(error);
      setText("action-feedback", error.message ?? "Refresh failed.");
    }
  });

  refreshActionPanel();
}

boot();
