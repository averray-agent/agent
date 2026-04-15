import { DEFAULT_ESCALATION_MESSAGE, DEFAULT_POSTER_TERMS, DEFAULT_WALLET } from "./constants.js";
import { postJson, readJson } from "./http-client.js";
import { buildEvidenceTemplate, parseTerms } from "./job-utils.js";
import {
  applySessionState,
  applyVerificationState,
  refreshActionPanel,
  renderCatalog,
  renderHistory,
  renderRecommendations,
  setActionFeedback,
  setPosterFeedback,
  setWalletFeedback,
  updateAccount,
  updateReputation,
  updateSelectedJob
} from "./renderers.js";
import { readPersistedState, state } from "./state.js";
import { setButtonBusy, setOverallStatus, setText, showToast } from "./ui-helpers.js";

async function runWithBusyButton(button, busyLabel, action) {
  setButtonBusy(button, true, busyLabel);
  try {
    return await action();
  } finally {
    setButtonBusy(button, false);
  }
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
  renderHistory(state.history);
}

async function loadHistoryForCurrentWallet() {
  const history = await readJson(`/api/sessions?wallet=${encodeURIComponent(state.wallet)}&limit=8`);
  state.history = history;
  renderHistory(history);
  setText("history-count", `${history.length} recent sessions`);
}

async function selectJob(jobId) {
  const job = await readJson(`/api/jobs/definition?jobId=${encodeURIComponent(jobId)}`);
  updateSelectedJob(job);

  const persisted = readPersistedState();
  const expectedSessionId =
    persisted.wallet === state.wallet && persisted.selectedJobId === job.id ? persisted.sessionId : "";

  if (expectedSessionId) {
    try {
      await restoreSession(expectedSessionId);
      setActionFeedback(`Restored prior session ${expectedSessionId}.`, "success");
      return;
    } catch {
      applySessionState(undefined);
      applyVerificationState(undefined);
    }
  }

  applySessionState(undefined);
  applyVerificationState(undefined);
  setActionFeedback(`Loaded ${job.id}. Claim it when you are ready.`, "neutral");
  refreshActionPanel();
}

async function loadWallet(wallet) {
  state.wallet = wallet;
  setWalletFeedback("Refreshing live operator view...", "loading");

  const [account, reputation, recommendations, history] = await Promise.all([
    readJson(`/api/account?wallet=${encodeURIComponent(wallet)}`),
    readJson(`/api/reputation?wallet=${encodeURIComponent(wallet)}`),
    readJson(`/api/jobs/recommendations?wallet=${encodeURIComponent(wallet)}`),
    readJson(`/api/sessions?wallet=${encodeURIComponent(wallet)}&limit=8`)
  ]);

  state.recommendations = recommendations;
  state.history = history;

  updateAccount(account);
  updateReputation(reputation);
  renderRecommendations(recommendations);
  renderHistory(history);
  setText("job-count", `${recommendations.length} recommendations`);
  setText("history-count", `${history.length} recent sessions`);
  setWalletFeedback(`Loaded live data for ${wallet}.`, "success");
  localStorage.setItem("averray:last-wallet", wallet);

  const persisted = readPersistedState();
  const nextJobId = recommendations.some((job) => job.jobId === persisted.selectedJobId)
    ? persisted.selectedJobId
    : recommendations[0]?.jobId ?? "";

  if (nextJobId) {
    await selectJob(nextJobId);
  } else if (!state.selectedJobId) {
    updateSelectedJob(undefined);
    setActionFeedback("No action flow available until recommendations appear.", "neutral");
  }
}

async function loadCatalog() {
  const jobs = await readJson("/api/jobs");
  state.catalog = jobs;
  renderCatalog(jobs);
  setText("catalog-count", `${jobs.length} jobs live`);
}

async function claimSelectedJob() {
  if (!state.selectedJobId) return;

  const idempotencyKey = `ui:${state.wallet}:${state.selectedJobId}`;
  setActionFeedback(`Claiming ${state.selectedJobId}...`, "loading");

  const session = await postJson(
    `/api/jobs/claim?wallet=${encodeURIComponent(state.wallet)}&jobId=${encodeURIComponent(state.selectedJobId)}&idempotencyKey=${encodeURIComponent(idempotencyKey)}`
  );

  applySessionState(session);
  applyVerificationState(undefined);
  setActionFeedback(`Claimed ${state.selectedJobId}. Session ${session.sessionId} is ready for submission.`, "success");
  showToast(`Claimed ${state.selectedJobId}.`, "success");
  refreshActionPanel();
  await loadHistoryForCurrentWallet();
}

async function submitSelectedWork() {
  if (!state.session?.sessionId) return;

  const evidenceInput = document.getElementById("evidence-input");
  const evidence = evidenceInput?.value?.trim() || buildEvidenceTemplate(state.selectedJob);

  setActionFeedback(`Submitting work for ${state.session.sessionId}...`, "loading");
  const session = await postJson(
    `/api/jobs/submit?sessionId=${encodeURIComponent(state.session.sessionId)}&evidence=${encodeURIComponent(evidence)}`
  );

  applySessionState(session);
  setActionFeedback("Submission stored. Run the verifier to settle the result.", "success");
  showToast("Submission stored.", "success");
  refreshActionPanel();
  await loadHistoryForCurrentWallet();
}

async function verifySelectedWork() {
  if (!state.session?.sessionId) return;

  const evidenceInput = document.getElementById("evidence-input");
  const evidence = evidenceInput?.value?.trim() || buildEvidenceTemplate(state.selectedJob);

  setActionFeedback(`Running verifier for ${state.session.sessionId}...`, "loading");
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
  document.getElementById("action-feedback")?.setAttribute("data-tone", result.outcome === "approved" ? "success" : "neutral");
  showToast(
    result.outcome === "approved" ? "Verification approved." : `Verification ${result.outcome}.`,
    result.outcome === "approved" ? "success" : "neutral"
  );
  refreshActionPanel();
  await loadHistoryForCurrentWallet();
}

async function refreshCurrentSession() {
  if (!state.session?.sessionId) return;

  setActionFeedback(`Refreshing ${state.session.sessionId}...`, "loading");
  await restoreSession(state.session.sessionId);
  setActionFeedback(`Refreshed session ${state.session.sessionId}.`, "success");
}

function syncPosterDefaults(force = false) {
  const verifierMode = document.getElementById("poster-verifier-mode")?.value ?? "benchmark";
  const terms = document.getElementById("poster-verifier-terms");
  const escalation = document.getElementById("poster-escalation");

  if (terms && (force || !terms.value.trim())) {
    terms.value = DEFAULT_POSTER_TERMS[verifierMode] ?? "";
  }

  if (escalation && (force || !escalation.value.trim())) {
    escalation.value = DEFAULT_ESCALATION_MESSAGE;
  }
}

async function createPosterJob() {
  const form = document.getElementById("poster-form");
  const formData = new FormData(form);
  const category = String(formData.get("category") ?? "").trim().toLowerCase();
  const verifierMode = String(formData.get("verifierMode") ?? "benchmark");
  const outputSchemaRef = String(formData.get("outputSchemaRef") ?? "").trim() || `schema://jobs/${category}-output`;

  const payload = {
    id: String(formData.get("id") ?? "").trim(),
    category,
    tier: String(formData.get("tier") ?? "starter"),
    rewardAmount: Number(formData.get("rewardAmount") ?? 0),
    verifierMode,
    outputSchemaRef,
    inputSchemaRef: `schema://jobs/${category}-input`,
    claimTtlSeconds: Number(formData.get("claimTtlSeconds") ?? 3600),
    retryLimit: Number(formData.get("retryLimit") ?? 1),
    requiresSponsoredGas: formData.get("requiresSponsoredGas") === "on",
    verifierTerms: parseTerms(formData.get("verifierTerms")),
    verifierMatchMode: String(formData.get("verifierMatchMode") ?? "contains_all"),
    verifierMinimumMatches: Number(formData.get("verifierMinimumMatches") ?? 2),
    escalationMessage: String(formData.get("escalationMessage") ?? "").trim() || DEFAULT_ESCALATION_MESSAGE,
    autoApprove: formData.get("autoApprove") === "on"
  };

  setPosterFeedback(`Creating ${payload.id || "job"}...`, "loading");
  const job = await postJson("/api/admin/jobs", payload);
  setPosterFeedback(`Created ${job.id}. Refreshing catalog and operator view...`, "loading");
  await Promise.all([loadCatalog(), loadWallet(state.wallet)]);
  await selectJob(job.id);
  setPosterFeedback(`Created ${job.id} and loaded it into the execution flow.`, "success");
  showToast(`Created ${job.id}.`, "success");
}

function wireWalletForm(walletForm, walletInput) {
  walletForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const wallet = walletInput?.value?.trim();
    if (!wallet) {
      setText("wallet-feedback", "Enter a wallet address first.");
      document.getElementById("wallet-feedback")?.setAttribute("data-tone", "error");
      return;
    }

    try {
      await loadWallet(wallet);
    } catch (error) {
      console.error(error);
      setWalletFeedback(error.message ?? "Failed to load wallet data.", "error");
      showToast(error.message ?? "Failed to load wallet data.", "error");
    }
  });
}

function wireJobSelection(jobList) {
  jobList?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-job-id]");
    if (!button) return;

    try {
      await selectJob(button.dataset.jobId);
    } catch (error) {
      console.error(error);
      setActionFeedback(error.message ?? "Failed to load job definition.", "error");
      showToast(error.message ?? "Failed to load job definition.", "error");
    }
  });
}

function wireCatalogSelection(catalogList) {
  catalogList?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-catalog-job-id]");
    if (!button) return;

    try {
      await selectJob(button.dataset.catalogJobId);
      setPosterFeedback(`Loaded ${button.dataset.catalogJobId} into the execution flow.`, "success");
    } catch (error) {
      console.error(error);
      setPosterFeedback(error.message ?? "Failed to load catalog job.", "error");
      showToast(error.message ?? "Failed to load catalog job.", "error");
    }
  });
}

function wireHistorySelection(historyList) {
  historyList?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-session-id]");
    if (!button) return;

    try {
      const sessionId = button.dataset.sessionId;
      const matchingHistory = state.history.find((entry) => entry.sessionId === sessionId);
      if (matchingHistory) {
        const job = await readJson(`/api/jobs/definition?jobId=${encodeURIComponent(matchingHistory.jobId)}`);
        updateSelectedJob(job);
      }
      await restoreSession(sessionId);
      setActionFeedback(`Loaded session ${sessionId}.`, "success");
    } catch (error) {
      console.error(error);
      setActionFeedback(error.message ?? "Failed to load session history.", "error");
      showToast(error.message ?? "Failed to load session history.", "error");
    }
  });
}

function wireActionButtons({ claimButton, submitButton, verifyButton, refreshButton }) {
  claimButton?.addEventListener("click", async () => {
    try {
      await runWithBusyButton(claimButton, "Claiming...", claimSelectedJob);
    } catch (error) {
      console.error(error);
      setActionFeedback(error.message ?? "Claim failed.", "error");
      showToast(error.message ?? "Claim failed.", "error");
    }
  });

  submitButton?.addEventListener("click", async () => {
    try {
      await runWithBusyButton(submitButton, "Submitting...", submitSelectedWork);
    } catch (error) {
      console.error(error);
      setActionFeedback(error.message ?? "Submit failed.", "error");
      showToast(error.message ?? "Submit failed.", "error");
    }
  });

  verifyButton?.addEventListener("click", async () => {
    try {
      await runWithBusyButton(verifyButton, "Verifying...", verifySelectedWork);
    } catch (error) {
      console.error(error);
      setActionFeedback(error.message ?? "Verification failed.", "error");
      showToast(error.message ?? "Verification failed.", "error");
    }
  });

  refreshButton?.addEventListener("click", async () => {
    try {
      await runWithBusyButton(refreshButton, "Refreshing...", refreshCurrentSession);
    } catch (error) {
      console.error(error);
      setActionFeedback(error.message ?? "Refresh failed.", "error");
      showToast(error.message ?? "Refresh failed.", "error");
    }
  });
}

function wirePosterControls({ posterForm, refreshCatalogButton, verifierModeSelect }) {
  posterForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = posterForm.querySelector('button[type="submit"]');
    try {
      await runWithBusyButton(submitButton, "Creating...", createPosterJob);
    } catch (error) {
      console.error(error);
      setPosterFeedback(error.message ?? "Create job failed.", "error");
      showToast(error.message ?? "Create job failed.", "error");
    }
  });

  refreshCatalogButton?.addEventListener("click", async () => {
    try {
      await runWithBusyButton(refreshCatalogButton, "Refreshing...", async () => {
        setPosterFeedback("Refreshing live catalog...", "loading");
        await loadCatalog();
      });
      setPosterFeedback("Catalog refreshed.", "success");
    } catch (error) {
      console.error(error);
      setPosterFeedback(error.message ?? "Catalog refresh failed.", "error");
      showToast(error.message ?? "Catalog refresh failed.", "error");
    }
  });

  verifierModeSelect?.addEventListener("change", () => {
    syncPosterDefaults(true);
  });
}

async function loadPlatformStatus() {
  try {
    const [health, onboarding, index] = await Promise.all([readJson("/api/health"), readJson("/api/onboarding"), readJson("/index/")]);

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
}

async function boot() {
  const walletInput = document.getElementById("wallet-input");
  const walletForm = document.getElementById("wallet-form");
  const jobList = document.getElementById("job-list");
  const claimButton = document.getElementById("claim-button");
  const submitButton = document.getElementById("submit-button");
  const verifyButton = document.getElementById("verify-button");
  const refreshButton = document.getElementById("refresh-session-button");
  const posterForm = document.getElementById("poster-form");
  const refreshCatalogButton = document.getElementById("refresh-catalog-button");
  const catalogList = document.getElementById("catalog-list");
  const historyList = document.getElementById("history-list");
  const verifierModeSelect = document.getElementById("poster-verifier-mode");
  const initialWallet = localStorage.getItem("averray:last-wallet") || DEFAULT_WALLET;

  if (walletInput) walletInput.value = initialWallet;
  syncPosterDefaults(true);

  await loadPlatformStatus();

  try {
    await Promise.all([loadWallet(initialWallet), loadCatalog()]);
  } catch (error) {
    console.error(error);
    setWalletFeedback(error.message ?? "Failed to load wallet data.", "error");
    renderRecommendations([]);
    setPosterFeedback(error.message ?? "Failed to load poster workspace.", "error");
    showToast(error.message ?? "Failed to load poster workspace.", "error");
  }

  wireWalletForm(walletForm, walletInput);
  wireJobSelection(jobList);
  wireCatalogSelection(catalogList);
  wireHistorySelection(historyList);
  wireActionButtons({ claimButton, submitButton, verifyButton, refreshButton });
  wirePosterControls({ posterForm, refreshCatalogButton, verifierModeSelect });
  refreshActionPanel();
}

boot();
