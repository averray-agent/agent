import { getAuthSnapshot, getAuthWallet, onAuthChange, signIn, signOut } from "./auth.js";
import { DEFAULT_ESCALATION_MESSAGE, DEFAULT_POSTER_TERMS, DEFAULT_WALLET } from "./constants.js";
import { startEventStream } from "./events.js";
import { postJson, readJson } from "./http-client.js";
import { buildEvidenceTemplate, parseTerms } from "./job-utils.js";
import {
  applySessionState,
  applyVerificationState,
  refreshActionPanel,
  renderCatalog,
  renderCatalogJobActivity,
  renderJobDetail,
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

let stopEventStream = undefined;
let liveRefreshTimer = undefined;
let authMode = "strict";

function shortenWallet(wallet) {
  if (!wallet) return "";
  return wallet.length > 10 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;
}

function setAuthFeedback(text, tone = "neutral") {
  const feedback = document.getElementById("auth-feedback");
  if (!feedback) return;
  feedback.textContent = text;
  feedback.setAttribute("data-tone", tone);
}

function renderAuthUi(snapshot = getAuthSnapshot()) {
  const panel = document.getElementById("auth-panel");
  const signInBtn = document.getElementById("auth-signin-button");
  const signOutBtn = document.getElementById("auth-signout-button");
  const pill = document.getElementById("auth-session-pill");
  const walletForm = document.getElementById("wallet-form");

  if (panel) {
    panel.setAttribute("data-auth", snapshot.authenticated ? "signed-in" : "signed-out");
  }
  if (signInBtn) {
    signInBtn.hidden = snapshot.authenticated;
    signInBtn.textContent = snapshot.authenticated ? "Re-sign" : "Connect & Sign In";
  }
  if (signOutBtn) {
    signOutBtn.hidden = !snapshot.authenticated;
  }
  if (pill) {
    pill.hidden = false;
    if (snapshot.authenticated) {
      pill.className = "status-pill status-ok";
      pill.textContent = `Signed in · ${shortenWallet(snapshot.wallet)}`;
      pill.title = `Signed in as ${snapshot.wallet}\nToken expires ${snapshot.expiresAt}`;
    } else {
      pill.className = "status-pill status-pending";
      pill.textContent = "Not signed in";
      pill.title = snapshot.lastReason ? `Last reason: ${snapshot.lastReason}` : "";
    }
  }

  // The legacy wallet-input form is only useful when the API is in permissive
  // mode — otherwise every request will be rejected until the user signs in.
  if (walletForm) {
    walletForm.hidden = authMode !== "permissive" || snapshot.authenticated;
  }
}

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
  renderJobDetail(state.selectedJob, state.jobHistory);
  renderCatalogJobActivity(state.selectedJob, state.catalogJobActivity);
}

async function loadJobDefinitionWithPreflight(jobId) {
  const [job, preflight] = await Promise.all([
    readJson(`/api/jobs/definition?jobId=${encodeURIComponent(jobId)}`),
    readJson(`/api/jobs/preflight?wallet=${encodeURIComponent(state.wallet)}&jobId=${encodeURIComponent(jobId)}`)
  ]);
  return {
    ...job,
    preflight
  };
}

async function refreshWalletPanels() {
  const [account, reputation, recommendations, history] = await Promise.all([
    readJson(`/api/account?wallet=${encodeURIComponent(state.wallet)}`),
    readJson(`/api/reputation?wallet=${encodeURIComponent(state.wallet)}`),
    readJson(`/api/jobs/recommendations?wallet=${encodeURIComponent(state.wallet)}`),
    readJson(`/api/sessions?wallet=${encodeURIComponent(state.wallet)}&limit=8`)
  ]);

  state.recommendations = recommendations;
  state.history = history;

  updateAccount(account);
  updateReputation(reputation);
  renderRecommendations(recommendations);
  renderHistory(history);
  setText("job-count", `${recommendations.length} recommendations`);
  setText("history-count", `${history.length} recent sessions`);

  if (state.selectedJobId) {
    const job = await loadJobDefinitionWithPreflight(state.selectedJobId);
    updateSelectedJob(job);
    await Promise.all([loadSelectedJobHistory(), loadSelectedCatalogJobActivity()]);
  }

  if (state.session?.sessionId) {
    await restoreSession(state.session.sessionId);
  } else {
    refreshActionPanel();
  }
}

function scheduleLiveRefresh(event = undefined) {
  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(async () => {
    try {
      await refreshWalletPanels();
      if (event?.topic === "verification.resolved" || event?.topic === "reputation.slashed") {
        showToast(`${event.topic} received.`, "success");
      }
    } catch (error) {
      console.error(error);
      setWalletFeedback(error.message ?? "Live refresh failed.", "error");
    }
  }, 250);
}

function restartEventSubscription() {
  stopEventStream?.();
  if (!state.wallet) {
    return;
  }

  stopEventStream = startEventStream({
    wallet: state.wallet,
    onEvent: (event) => {
      scheduleLiveRefresh(event);
    },
    onGap: () => {
      scheduleLiveRefresh({ topic: "gap" });
    },
    onError: () => {
      setWalletFeedback("Realtime stream reconnecting...", "loading");
    }
  });
}

async function loadHistoryForCurrentWallet() {
  const history = await readJson(`/api/sessions?wallet=${encodeURIComponent(state.wallet)}&limit=8`);
  state.history = history;
  renderHistory(history);
  setText("history-count", `${history.length} recent sessions`);
}

async function loadSelectedJobHistory() {
  if (!state.selectedJobId) {
    state.jobHistory = [];
    renderJobDetail(undefined, []);
    return;
  }

  const jobHistory = await readJson(
    `/api/sessions?wallet=${encodeURIComponent(state.wallet)}&jobId=${encodeURIComponent(state.selectedJobId)}&limit=10`
  );
  state.jobHistory = jobHistory;
  renderJobDetail(state.selectedJob, jobHistory);
}

async function loadSelectedCatalogJobActivity() {
  if (!state.selectedJobId) {
    state.catalogJobActivity = [];
    renderCatalogJobActivity(undefined, []);
    return;
  }

  const activity = await readJson(`/api/sessions?jobId=${encodeURIComponent(state.selectedJobId)}&limit=12`);
  state.catalogJobActivity = activity;
  renderCatalogJobActivity(state.selectedJob, activity);
}

async function selectJob(jobId) {
  const job = await loadJobDefinitionWithPreflight(jobId);
  updateSelectedJob(job);

  const persisted = readPersistedState();
  const expectedSessionId =
    persisted.wallet === state.wallet && persisted.selectedJobId === job.id ? persisted.sessionId : "";

  if (expectedSessionId) {
    try {
      await restoreSession(expectedSessionId);
      await Promise.all([loadSelectedJobHistory(), loadSelectedCatalogJobActivity()]);
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
  await Promise.all([loadSelectedJobHistory(), loadSelectedCatalogJobActivity()]);
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
    renderJobDetail(undefined, []);
    renderCatalogJobActivity(undefined, []);
    setActionFeedback("No action flow available until recommendations appear.", "neutral");
  }

  restartEventSubscription();
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
  await Promise.all([loadSelectedJobHistory(), loadSelectedCatalogJobActivity()]);
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
  await Promise.all([loadSelectedJobHistory(), loadSelectedCatalogJobActivity()]);
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
      : result.outcome === "rejected"
        ? `Verifier rejected the submission with ${result.reasonCode}. Stake and reputation remain pending until the dispute window closes.`
      : `Verifier returned ${result.outcome} with ${result.reasonCode}.`
  );
  document.getElementById("action-feedback")?.setAttribute("data-tone", result.outcome === "approved" ? "success" : "neutral");
  showToast(
    result.outcome === "approved" ? "Verification approved." : `Verification ${result.outcome}.`,
    result.outcome === "approved" ? "success" : "neutral"
  );
  refreshActionPanel();
  await loadHistoryForCurrentWallet();
  await Promise.all([loadSelectedJobHistory(), loadSelectedCatalogJobActivity()]);
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
        await Promise.all([loadSelectedJobHistory(), loadSelectedCatalogJobActivity()]);
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

function wireJobRunSelection() {
  const detailHistory = document.getElementById("job-detail-history");
  detailHistory?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-session-id]");
    if (!button) return;

    try {
      await restoreSession(button.dataset.sessionId);
      setActionFeedback(`Loaded run ${button.dataset.sessionId}.`, "success");
    } catch (error) {
      console.error(error);
      setActionFeedback(error.message ?? "Failed to load job run.", "error");
      showToast(error.message ?? "Failed to load job run.", "error");
    }
  });
}

function wireCatalogActivitySelection() {
  const catalogHistory = document.getElementById("catalog-job-history");
  catalogHistory?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-catalog-session-id]");
    if (!button) return;

    try {
      const jobId = button.dataset.catalogJobId;
      if (jobId && jobId !== state.selectedJobId) {
        await selectJob(jobId);
      }
      await restoreSession(button.dataset.catalogSessionId);
      setPosterFeedback(`Loaded run ${button.dataset.catalogSessionId} from poster activity.`, "success");
    } catch (error) {
      console.error(error);
      setPosterFeedback(error.message ?? "Failed to load poster run.", "error");
      showToast(error.message ?? "Failed to load poster run.", "error");
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

    authMode = health?.auth?.mode ?? onboarding?.authMode ?? authMode;
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

function wireAuthControls() {
  const signInBtn = document.getElementById("auth-signin-button");
  const signOutBtn = document.getElementById("auth-signout-button");

  signInBtn?.addEventListener("click", async () => {
    setAuthFeedback("Waiting for wallet signature...", "loading");
    try {
      const result = await signIn();
      setAuthFeedback(`Signed in as ${result.wallet}. Loading your workspace...`, "success");
      await loadWallet(result.wallet);
      setAuthFeedback(`Signed in as ${result.wallet}. Token expires ${result.expiresAt}.`, "success");
    } catch (error) {
      console.error(error);
      setAuthFeedback(error.message ?? "Sign in failed.", "error");
      showToast(error.message ?? "Sign in failed.", "error");
    }
  });

  signOutBtn?.addEventListener("click", () => {
    signOut();
    stopEventStream?.();
    stopEventStream = undefined;
    state.wallet = "";
    setAuthFeedback("Signed out. Sign in again to resume live data.", "neutral");
    // Clear the wallet-scoped panels so stale data doesn't linger on screen.
    updateAccount({ wallet: "", liquid: {}, reserved: {}, strategyAllocated: {}, collateralLocked: {}, jobStakeLocked: {}, debtOutstanding: {} });
    updateReputation({ skill: 0, reliability: 0, economic: 0, tier: "starter" });
    renderRecommendations([]);
    renderHistory([]);
    setText("job-count", "0 recommendations");
    setText("history-count", "0 recent sessions");
  });

  onAuthChange((snapshot) => {
    renderAuthUi(snapshot);
  });
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

  syncPosterDefaults(true);
  await loadPlatformStatus();

  // Render initial auth UI *after* we know the auth mode so the permissive
  // fallback form shows up correctly on dev deployments.
  renderAuthUi();

  try {
    await loadCatalog();
  } catch (error) {
    console.error(error);
    setPosterFeedback(error.message ?? "Failed to load poster workspace.", "error");
    showToast(error.message ?? "Failed to load poster workspace.", "error");
  }

  // Bootstrap wallet loading decision tree:
  //   1. If the user already has a valid JWT → reuse its wallet.
  //   2. Else in permissive mode → fall back to the last-used wallet (or default).
  //   3. Else (strict + no token) → show the sign-in prompt and wait.
  const authenticatedWallet = getAuthWallet();
  const permissiveWallet = authMode === "permissive"
    ? (localStorage.getItem("averray:last-wallet") || DEFAULT_WALLET)
    : undefined;
  const initialWallet = authenticatedWallet ?? permissiveWallet;

  if (walletInput && permissiveWallet) walletInput.value = permissiveWallet;

  if (initialWallet) {
    try {
      await loadWallet(initialWallet);
    } catch (error) {
      console.error(error);
      setWalletFeedback(error.message ?? "Failed to load wallet data.", "error");
      renderRecommendations([]);
    }
  } else {
    setAuthFeedback("Sign in with your wallet to load balances, reputation, and the action flow.", "neutral");
  }

  wireAuthControls();
  wireWalletForm(walletForm, walletInput);
  wireJobSelection(jobList);
  wireCatalogSelection(catalogList);
  wireHistorySelection(historyList);
  wireJobRunSelection();
  wireCatalogActivitySelection();
  wireActionButtons({ claimButton, submitButton, verifyButton, refreshButton });
  wirePosterControls({ posterForm, refreshCatalogButton, verifierModeSelect });
  refreshActionPanel();
}

boot();
