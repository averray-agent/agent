const DEFAULT_WALLET = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519";

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

async function readJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
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
        <article class="job-card">
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

async function loadWallet(wallet) {
  setText("wallet-feedback", "Refreshing live operator view...");

  const [account, reputation, recommendations] = await Promise.all([
    readJson(`/api/account?wallet=${encodeURIComponent(wallet)}`),
    readJson(`/api/reputation?wallet=${encodeURIComponent(wallet)}`),
    readJson(`/api/jobs/recommendations?wallet=${encodeURIComponent(wallet)}`)
  ]);

  updateAccount(account);
  updateReputation(reputation);
  renderRecommendations(recommendations);
  setText("job-count", `${recommendations.length} recommendations`);
  setText("wallet-feedback", `Loaded live data for ${wallet}.`);
  localStorage.setItem("averray:last-wallet", wallet);
}

async function boot() {
  const walletInput = document.getElementById("wallet-input");
  const walletForm = document.getElementById("wallet-form");
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
}

boot();
