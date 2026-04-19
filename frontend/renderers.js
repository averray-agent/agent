import { persistUiState, state } from "./state.js";
import { buildEvidenceTemplate, describeVerifier } from "./job-utils.js";
import {
  formatAmount,
  html,
  renderHtml,
  setActionStatus,
  setFeedback,
  setText
} from "./ui-helpers.js";

function outcomeTone(status) {
  return ["approved", "resolved", "closed"].includes(status) ? "eligible-yes" : "eligible-no";
}

function setStatusPill(id, label, toneClass) {
  const pill = document.getElementById(id);
  if (!pill) return;
  pill.textContent = label;
  pill.className = `status-pill ${toneClass}`;
}

function formatEventTime(timestamp) {
  if (!timestamp) return "Just now";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Just now";
  return date.toLocaleString("en-CH", { dateStyle: "short", timeStyle: "short" });
}

function compactWallet(wallet) {
  if (!wallet) return "Unknown wallet";
  return wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;
}

function summarizeEvent(event) {
  const jobId = event.jobId ?? event.data?.jobId ?? "unknown job";
  const sessionId = event.sessionId ?? event.data?.sessionId;

  switch (event.topic) {
    case "session.claimed":
      return {
        title: "Claim opened",
        body: `Session ${sessionId ?? "pending"} claimed for ${jobId}. Claim stake is now locked for this worker.`,
        tone: "status-ok"
      };
    case "session.submitted":
      return {
        title: "Evidence submitted",
        body: `Evidence for ${jobId} was stored. The run is ready for verification.`,
        tone: "status-ok"
      };
    case "verification.resolved":
      return {
        title: "Verifier settled",
        body: `Verification returned ${event.data?.outcome ?? "an outcome"}${event.data?.reasonCode ? ` with ${event.data.reasonCode}` : ""}.`,
        tone: event.data?.outcome === "approved" ? "status-ok" : "tier-warn"
      };
    case "account.job_stake_locked":
      return {
        title: "Stake locked",
        body: `${formatAmount(event.data?.amount)} DOT moved into the claim stake bucket.`,
        tone: "status-ok"
      };
    case "account.job_stake_released":
      return {
        title: "Stake released",
        body: `${formatAmount(event.data?.amount)} DOT returned to liquid balance after resolution.`,
        tone: "status-ok"
      };
    case "account.job_stake_slashed":
      return {
        title: "Stake slashed",
        body: `${formatAmount(event.data?.amount)} DOT was slashed. Poster received ${formatAmount(event.data?.posterAmount)} DOT and treasury recorded ${formatAmount(event.data?.treasuryAmount)} DOT.`,
        tone: "eligible-no"
      };
    case "reputation.updated":
      return {
        title: "Reputation updated",
        body: `Skill ${formatAmount(event.data?.skill)}, reliability ${formatAmount(event.data?.reliability)}, economic ${formatAmount(event.data?.economic)}.`,
        tone: "status-ok"
      };
    case "reputation.slashed":
      return {
        title: "Reputation slashed",
        body: `Penalties applied${event.data?.reasonCode ? ` for ${event.data.reasonCode}` : ""}. Reliability and skill dropped for this wallet.`,
        tone: "eligible-no"
      };
    case "escrow.job_rejected":
      return {
        title: "Job rejected",
        body: `${jobId} was rejected on-chain. Stake and reputation stay pending until the dispute window closes or a dispute opens.`,
        tone: "tier-warn"
      };
    case "escrow.job_closed":
      return {
        title: "Job closed",
        body: `${jobId} reached terminal settlement on-chain.`,
        tone: "status-ok"
      };
    case "escrow.dispute_opened":
      return {
        title: "Dispute opened",
        body: `A dispute is now open for ${jobId}. Expect settlement and penalties to wait for arbitration.`,
        tone: "tier-warn"
      };
    case "system.reconnect":
      return {
        title: "Realtime restored",
        body: `The event listener reconnected after an RPC interruption.`,
        tone: "status-ok"
      };
    case "system.provider_error":
    case "system.listener_error":
      return {
        title: "Realtime warning",
        body: event.data?.message ?? "The event stream reported an upstream issue.",
        tone: "tier-warn"
      };
    case "gap":
      return {
        title: "Replay gap",
        body: "The live feed missed some buffered events, so the app refreshed the REST panels to catch up.",
        tone: "status-pending"
      };
    default:
      return {
        title: event.topic.replaceAll(".", " "),
        body: sessionId ? `${jobId} · ${sessionId}` : `${jobId}`,
        tone: "status-pending"
      };
  }
}

function describeStakeImpact(session, verification, rewardAsset) {
  const stakeLabel = `${formatAmount(session?.claimStake)} ${rewardAsset}`;

  if (!session?.sessionId) {
    return "No session selected yet.";
  }

  if (verification?.outcome === "approved" || session?.status === "resolved") {
    return `${stakeLabel} should release back to liquid balance on terminal approval.`;
  }

  if (session?.status === "rejected") {
    return `${stakeLabel} stays locked until the dispute window closes or a dispute is opened.`;
  }

  if (session?.status === "disputed") {
    return `${stakeLabel} stays locked while arbitration is pending.`;
  }

  if (session?.status === "claimed" || session?.status === "submitted") {
    return `${stakeLabel} is currently locked as claim stake for this run.`;
  }

  return `${stakeLabel} follows the terminal settlement path for this session.`;
}

function describeReputationImpact(session, verification) {
  if (!session?.sessionId) {
    return "No session selected yet.";
  }

  if (verification?.outcome === "approved") {
    return "Approved runs can mint or update reputation on-chain depending on the verifier path.";
  }

  if (session?.status === "rejected") {
    return "No slash is final yet. Reputation only changes when rejection becomes terminal or a dispute resolves against the worker.";
  }

  if (session?.status === "disputed") {
    return "Reputation is waiting on arbitration. No terminal penalty should be assumed yet.";
  }

  if (session?.status === "claimed" || session?.status === "submitted") {
    return "No reputation movement yet. This run has not reached a terminal outcome.";
  }

  return "Reputation impact depends on the final verifier and settlement path.";
}

function getFundingReadiness() {
  const rewardAsset = state.selectedJob?.rewardAsset ?? "DOT";
  const availableLiquidity = Number(state.selectedJob?.preflight?.availableLiquidity ?? state.account?.liquid?.[rewardAsset] ?? 0);
  const claimStake = Number(state.selectedJob?.preflight?.claimStake ?? 0);
  const shortfall = Math.max(claimStake - availableLiquidity, 0);
  const eligible = state.selectedJob ? Boolean(state.selectedJob.preflight?.eligible) : false;

  if (!state.wallet) {
    return {
      label: "Sign in first",
      tone: "status-pending",
      headline: "Authenticate with your wallet to load balances, recommendations, and claim readiness.",
      gapLabel: "-",
      availableLabel: "-",
      stakeLabel: "-",
      guidance:
        "Claim stake is enforced against deposited DOT inside AgentAccountCore. Native wallet gas remains separate from the in-app balance.",
      shortfall,
      canClaim: false
    };
  }

  if (!state.selectedJob) {
    return {
      label: "Pick a job",
      tone: "status-pending",
      headline: "Select a recommended or catalog job to calculate the exact stake requirement.",
      gapLabel: "0 DOT",
      availableLabel: `${formatAmount(state.account?.liquid?.DOT)} DOT`,
      stakeLabel: "0 DOT",
      guidance:
        "Your deposited DOT balance is live, but claim readiness is computed per selected job.",
      shortfall,
      canClaim: false
    };
  }

  if (!eligible) {
    return {
      label: "Eligibility blocked",
      tone: "eligible-no",
      headline: "This wallet does not yet meet the reputation or routing requirements for the selected job.",
      gapLabel: `${formatAmount(shortfall)} ${rewardAsset}`,
      availableLabel: `${formatAmount(availableLiquidity)} ${rewardAsset}`,
      stakeLabel: `${formatAmount(claimStake)} ${rewardAsset}`,
      guidance:
        "Funding alone will not unblock this claim. Choose another job or improve the worker profile and reputation first.",
      shortfall,
      canClaim: false
    };
  }

  if (shortfall > 0) {
    return {
      label: "Needs funding",
      tone: "tier-warn",
      headline: `This job needs ${formatAmount(claimStake)} ${rewardAsset} locked as claim stake, but only ${formatAmount(
        availableLiquidity
      )} ${rewardAsset} is deposited.`,
      gapLabel: `${formatAmount(shortfall)} ${rewardAsset}`,
      availableLabel: `${formatAmount(availableLiquidity)} ${rewardAsset}`,
      stakeLabel: `${formatAmount(claimStake)} ${rewardAsset}`,
      guidance:
        "Top up the missing deposited DOT before claiming. Native wallet gas funds do not count toward claim stake.",
      shortfall,
      canClaim: false
    };
  }

  return {
    label: "Ready to claim",
    tone: "status-ok",
    headline: `This wallet can lock ${formatAmount(claimStake)} ${rewardAsset} and claim ${state.selectedJob.id} right now.`,
    gapLabel: `0 ${rewardAsset}`,
    availableLabel: `${formatAmount(availableLiquidity)} ${rewardAsset}`,
    stakeLabel: `${formatAmount(claimStake)} ${rewardAsset}`,
    guidance:
      "Claim stake is already covered by deposited DOT. You still need enough native wallet gas for chain execution.",
    shortfall,
    canClaim: true
  };
}

function getExecutionState() {
  const readiness = getFundingReadiness();
  const sessionStatus = state.session?.status ?? "";
  const hasJob = Boolean(state.selectedJob);
  const hasSession = Boolean(state.session?.sessionId);
  const hasVerification = Boolean(state.verification?.outcome);

  if (!state.wallet) {
    return {
      stage: "Signed out",
      next: "Connect and sign in with the wallet you want to use for this run.",
      blocker: "The run cannot start until a wallet is signed in."
    };
  }

  if (!hasJob) {
    return {
      stage: "No job selected",
      next: "Choose a recommended or catalog job to load its run details.",
      blocker: "Nothing else can move until you pick a job."
    };
  }

  if (hasVerification) {
    return {
      stage: state.verification.outcome === "approved" ? "Verified" : "Pending dispute window",
      next:
        state.verification.outcome === "approved"
          ? "Review the result or move on to another run."
          : "Wait for the dispute window or the future dispute flow before expecting final penalties.",
      blocker:
        state.verification.outcome === "approved"
          ? "Nothing is blocking this run anymore. It is settled."
          : "Penalties and refunds wait until the rejection becomes final or is disputed."
    };
  }

  if (sessionStatus === "submitted") {
    return {
      stage: "Ready to verify",
      next: "Run the verifier to settle this submission.",
      blocker: "This run is waiting on the verifier step."
    };
  }

  if (sessionStatus === "claimed") {
    return {
      stage: "Claimed",
      next: "Finish the submission and send it.",
      blocker: "Verification cannot start until the run is submitted."
    };
  }

  if (!readiness.canClaim) {
    return {
      stage: readiness.label,
      next: readiness.shortfall > 0 ? "Top up deposited DOT for this run." : "Pick another eligible job or improve the worker profile.",
      blocker: readiness.guidance
    };
  }

  if (hasSession) {
    return {
      stage: "In progress",
      next: "Continue from the current session state.",
      blocker: "Use Refresh status if this run looks stale."
    };
  }

  return {
    stage: "Ready",
    next: "Claim this job to open the run.",
    blocker: "Nothing is blocking the run. The wallet is funded and eligible."
  };
}

function filterCatalogEntries(entries) {
  const filter = state.catalogActivityFilter ?? "all";
  switch (filter) {
    case "active":
      return entries.filter((entry) => ["claimed", "submitted", "verifying", "rejected", "disputed"].includes(entry.status));
    case "approved":
      return entries.filter((entry) => entry.verification?.outcome === "approved" || entry.status === "resolved");
    case "rejected":
      return entries.filter((entry) => entry.verification?.outcome === "rejected" || entry.status === "rejected");
    case "disputed":
      return entries.filter((entry) => entry.status === "disputed" || entry.verification?.outcome === "disputed");
    default:
      return entries;
  }
}

function catalogFilterLabel(filter) {
  switch (filter) {
    case "active":
      return "active";
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "disputed":
      return "disputed";
    default:
      return "total";
  }
}

function filterHistoryEntries(entries) {
  const filter = state.historyFilter ?? "all";
  switch (filter) {
    case "active":
      return entries.filter((entry) => ["claimed", "submitted", "verifying", "rejected", "disputed"].includes(entry.status));
    case "approved":
      return entries.filter((entry) => entry.verification?.outcome === "approved" || entry.status === "resolved");
    case "rejected":
      return entries.filter((entry) => entry.verification?.outcome === "rejected" || entry.status === "rejected");
    case "disputed":
      return entries.filter((entry) => entry.status === "disputed" || entry.verification?.outcome === "disputed");
    default:
      return entries;
  }
}

function renderFundingReadiness() {
  const readiness = getFundingReadiness();
  setStatusPill("funding-readiness-pill", readiness.label, readiness.tone);
  setText("funding-gap-amount", readiness.gapLabel);
  setText("funding-available-liquid", readiness.availableLabel);
  setText("funding-claim-stake", readiness.stakeLabel);
  setText("funding-readiness-copy", readiness.headline);
  setText("funding-guidance-copy", readiness.guidance);
}

export function renderActivityFeed(entries = state.activity) {
  const root = document.getElementById("activity-feed");
  const count = document.getElementById("activity-count");
  if (!root || !count) return;

  count.textContent = entries.length ? `${entries.length} live events` : "No live events yet";

  if (!entries.length) {
    root.innerHTML =
      state.wallet
        ? '<p class="empty-state">Realtime activity will appear here as this wallet claims jobs, submits evidence, receives verifier outcomes, and moves stake or reputation on-chain.</p>'
        : '<p class="empty-state">Sign in and keep this page open to watch claim, verification, stake, and reputation events arrive in real time.</p>';
    return;
  }

  const cards = entries.map((event) => {
    const summary = summarizeEvent(event);
    const txHashShort = event.txHash
      ? `${event.txHash.slice(0, 8)}…${event.txHash.slice(-6)}`
      : "platform event";
    return html`
      <article class="activity-card">
        <div class="job-topline">
          <div>
            <p class="job-id">${summary.title}</p>
            <p class="activity-meta">${event.topic}</p>
          </div>
          <span class="status-pill ${summary.tone}">${formatEventTime(event.timestamp)}</span>
        </div>
        <p class="activity-copy">${summary.body}</p>
        <div class="catalog-meta">
          <span>${event.jobId ?? "no job"}</span>
          <span>${event.sessionId ?? "no session"}</span>
          <span>${txHashShort}</span>
        </div>
      </article>
    `;
  });
  renderHtml(root, html`${cards}`);
}

export function renderOpsDeck(snapshot = {}) {
  const topJobsRoot = document.getElementById("ops-job-flow");
  const pulseRoot = document.getElementById("ops-platform-pulse");
  if (!topJobsRoot || !pulseRoot) return;

  setText("ops-headline", snapshot.headline ?? "Operator picture unavailable");
  setText("ops-copy", snapshot.copy ?? "Operator data is not available right now.");
  setText("ops-active-runs", snapshot.metrics?.activeRuns?.value ?? "-");
  setText("ops-active-runs-copy", snapshot.metrics?.activeRuns?.copy ?? "Waiting for run data");
  setText("ops-active-agents", snapshot.metrics?.activeAgents?.value ?? "-");
  setText("ops-active-agents-copy", snapshot.metrics?.activeAgents?.copy ?? "Waiting for agent data");
  setText("ops-capital-at-work", snapshot.metrics?.capitalAtWork?.value ?? "-");
  setText("ops-capital-at-work-copy", snapshot.metrics?.capitalAtWork?.copy ?? "Waiting for treasury movement");
  setText("ops-treasury-posture", snapshot.metrics?.treasury?.value ?? "-");
  setText("ops-treasury-copy", snapshot.metrics?.treasury?.copy ?? "Waiting for treasury policy");
  setText("ops-flow-count", snapshot.flowLabel ?? "Waiting for platform flow");
  setText("ops-pulse-count", snapshot.pulseLabel ?? "Waiting for event pulse");
  setStatusPill("ops-pulse-pill", snapshot.pill?.label ?? "Syncing", snapshot.pill?.tone ?? "status-pending");

  if (!snapshot.topJobs?.length && !snapshot.recentSessions?.length) {
    renderHtml(
      topJobsRoot,
      html`<p class="empty-state">${snapshot.emptyFlow ?? "No job flow is visible yet."}</p>`
    );
  } else {
    renderHtml(
      topJobsRoot,
      html`
        ${snapshot.topJobs?.length ? html`
          <div class="ops-subsection">
            <p class="panel-label">Most active jobs</p>
            <div class="ops-list-stack">
              ${snapshot.topJobs.map((entry) => html`
                <article class="ops-row-card">
                  <div>
                    <p class="job-id">${entry.jobId}</p>
                    <p class="activity-meta">${entry.activeRuns} active · ${entry.totalRuns} total</p>
                  </div>
                  <div class="ops-row-meta">
                    <span class="status-pill ${entry.activeRuns > 0 ? "status-ok" : "status-pending"}">${entry.latestStatus ?? "idle"}</span>
                    <span>${formatEventTime(entry.latestAt)}</span>
                  </div>
                </article>
              `)}
            </div>
          </div>
        ` : ""}
        ${snapshot.recentSessions?.length ? html`
          <div class="ops-subsection">
            <p class="panel-label">Recent claims and runs</p>
            <div class="ops-list-stack">
              ${snapshot.recentSessions.map((entry) => html`
                <article class="ops-row-card">
                  <div>
                    <p class="job-id">${entry.jobId}</p>
                    <p class="activity-meta">${compactWallet(entry.wallet)} · ${entry.sessionId}</p>
                  </div>
                  <div class="ops-row-meta">
                    <span class="status-pill ${outcomeTone(entry.outcome ?? entry.status)}">${entry.outcome ?? entry.status}</span>
                    <span>${entry.claimStakeLabel ?? "-"}</span>
                    <span>${formatEventTime(entry.updatedAt)}</span>
                  </div>
                </article>
              `)}
            </div>
          </div>
        ` : ""}
      `
    );
  }

  if (!snapshot.pulseItems?.length) {
    renderHtml(
      pulseRoot,
      html`<p class="empty-state">${snapshot.emptyPulse ?? "No platform pulse is available yet."}</p>`
    );
    return;
  }

  const pulseCards = snapshot.pulseItems.map((entry) => {
    if (entry.kind === "anomaly") {
      return html`
        <article class="ops-row-card ops-row-card-alert">
          <div>
            <p class="job-id">${entry.title}</p>
            <p class="activity-copy">${entry.body}</p>
          </div>
          <div class="ops-row-meta">
            <span class="status-pill ${entry.tone ?? "tier-warn"}">${entry.label ?? "Attention"}</span>
          </div>
        </article>
      `;
    }

    const summary = summarizeEvent(entry.event ?? entry);
    return html`
      <article class="ops-row-card">
        <div>
          <p class="job-id">${summary.title}</p>
          <p class="activity-copy">${summary.body}</p>
        </div>
        <div class="ops-row-meta">
          <span class="status-pill ${summary.tone}">${entry.label ?? entry.event?.topic ?? entry.topic ?? "event"}</span>
          <span>${formatEventTime(entry.at ?? entry.timestamp ?? entry.event?.timestamp)}</span>
        </div>
      </article>
    `;
  });

  renderHtml(pulseRoot, html`${pulseCards}`);
}

export function renderSessionDetail() {
  const root = document.getElementById("session-detail-summary");
  const count = document.getElementById("session-detail-count");
  if (!root || !count) return;

  const session = state.session;
  const verification = state.verification;
  const rewardAsset = state.selectedJob?.rewardAsset ?? "DOT";

  if (!session?.sessionId) {
    count.textContent = "Awaiting session";
    root.innerHTML =
      state.wallet
        ? '<p class="empty-state">Open any run from history or claim a job to inspect session metadata, settlement status, and impact notes here.</p>'
        : '<p class="empty-state">Sign in and open a run to inspect session metadata, settlement status, and impact notes here.</p>';
    return;
  }

  count.textContent = session.status ?? "active";
  const evidenceTrace = verification?.metadataURI
    ? `Verifier metadata URI: ${verification.metadataURI}`
    : "Raw evidence text is used in the active run, but it is not yet persisted in session history. That should stay on the v2 backlog.";
  renderHtml(
    root,
    html`
      <div class="job-detail-grid">
        <div class="detail-stat">
          <dt>Session id</dt>
          <dd>${session.sessionId}</dd>
        </div>
        <div class="detail-stat">
          <dt>Wallet</dt>
          <dd>${session.wallet ?? state.wallet ?? "-"}</dd>
        </div>
        <div class="detail-stat">
          <dt>Job</dt>
          <dd>${session.jobId ?? "-"}</dd>
        </div>
        <div class="detail-stat">
          <dt>Protocol trail</dt>
          <dd>${session.protocolHistory?.join(" / ") ?? "-"}</dd>
        </div>
        <div class="detail-stat">
          <dt>Session status</dt>
          <dd>${session.status ?? "-"}</dd>
        </div>
        <div class="detail-stat">
          <dt>Verifier outcome</dt>
          <dd>${verification?.outcome ?? "pending"}</dd>
        </div>
        <div class="detail-stat">
          <dt>Reason code</dt>
          <dd>${verification?.reasonCode ?? "pending"}</dd>
        </div>
        <div class="detail-stat">
          <dt>Claim stake</dt>
          <dd>${formatAmount(session.claimStake)} ${rewardAsset}</dd>
        </div>
        <div class="detail-stat detail-span">
          <dt>Chain job id</dt>
          <dd>${session.chainJobId ?? "Using logical job id only for this run."}</dd>
        </div>
        <div class="detail-stat detail-span">
          <dt>Stake impact</dt>
          <dd>${describeStakeImpact(session, verification, rewardAsset)}</dd>
        </div>
        <div class="detail-stat detail-span">
          <dt>Reputation impact</dt>
          <dd>${describeReputationImpact(session, verification)}</dd>
        </div>
        <div class="detail-stat detail-span">
          <dt>Evidence trace</dt>
          <dd>${evidenceTrace}</dd>
        </div>
        <div class="detail-stat detail-span">
          <dt>Last updated</dt>
          <dd>${session.updatedAt ? formatEventTime(session.updatedAt) : "Not available"}</dd>
        </div>
      </div>
    `
  );
}

export function renderRecommendations(recommendations) {
  const root = document.getElementById("job-list");
  if (!root) return;

  if (!recommendations.length) {
    root.innerHTML = state.wallet
      ? '<p class="empty-state">No recommendations are ready for this wallet yet. Try topping up deposited DOT, raising reputation, or creating a fresh job from the poster panel.</p>'
      : '<p class="empty-state">Sign in to load recommendations tailored to the active worker wallet.</p>';
    return;
  }

  const cards = recommendations.map((job) => {
    const isSelected = job.jobId === state.selectedJobId;
    const tierLabel = job.tier ? `${job.tier.toUpperCase()} tier` : "Starter tier";
    const tierUnlock = describeTierUnlock(job.tierGate);
    return html`
      <article class="job-card ${isSelected ? "job-selected" : ""}">
        <div class="job-topline">
          <p class="job-id">${job.jobId}</p>
          <span class="eligibility-pill ${job.eligible ? "eligible-yes" : "eligible-no"}">
            ${job.eligible ? "Eligible" : "Blocked"}
          </span>
        </div>
        <div class="job-metrics">
          <span>${tierLabel}</span>
          <span>Fit score ${job.fitScore}</span>
          <span>Net reward ${formatAmount(job.netReward)} DOT</span>
        </div>
        <div class="job-copy">
          <p>${job.explanation}</p>
          ${tierUnlock ? html`<p class="catalog-meta"><strong>Unlock:</strong> ${tierUnlock}</p>` : ""}
        </div>
        <button class="job-select-button" type="button" data-job-id="${job.jobId}">
          ${isSelected ? "Selected" : "Select job"}
        </button>
      </article>
    `;
  });
  renderHtml(root, html`${cards}`);
}

/**
 * Describe the tier-gate status for a recommendation in a single line.
 * Returns an empty string when the wallet has already unlocked the tier —
 * the UI should render nothing rather than "unlocked!" noise on every card.
 */
function describeTierUnlock(tierGate) {
  if (!tierGate || tierGate.unlocked) {
    return "";
  }
  const missing = Object.entries(tierGate.missing ?? {})
    .map(([key, gap]) => `${gap} more ${key}`)
    .join(", ");
  if (!missing) {
    return "";
  }
  return `Earn ${missing} to unlock the ${tierGate.tier} tier.`;
}

export function renderCatalog(jobs) {
  const root = document.getElementById("catalog-list");
  if (!root) return;

  if (!jobs.length) {
    root.innerHTML = '<p class="empty-state">No jobs are live yet. Publish one from the poster panel to seed the live catalog.</p>';
    return;
  }

  const cards = jobs.map((job) => {
    const isSelected = job.id === state.selectedJobId;
    return html`
      <article class="catalog-card ${isSelected ? "job-selected" : ""}">
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
          ${isSelected ? "Loaded in flow" : "Load in flow"}
        </button>
      </article>
    `;
  });
  renderHtml(root, html`${cards}`);
}

export function renderHistory(entries) {
  const root = document.getElementById("history-list");
  const count = document.getElementById("history-count");
  if (!root) return;

  const filteredEntries = filterHistoryEntries(entries);
  const approvedRuns = entries.filter((entry) => entry.verification?.outcome === "approved" || entry.status === "resolved").length;
  const activeRuns = entries.filter((entry) => ["claimed", "submitted", "verifying", "rejected", "disputed"].includes(entry.status)).length;
  const rejectedRuns = entries.filter((entry) => entry.verification?.outcome === "rejected" || entry.status === "rejected").length;
  const disputedRuns = entries.filter((entry) => entry.status === "disputed" || entry.verification?.outcome === "disputed").length;

  if (count) {
    count.textContent = `${filteredEntries.length} shown · ${entries.length} total · ${activeRuns} active · ${approvedRuns} approved · ${rejectedRuns} rejected · ${disputedRuns} disputed`;
  }

  if (!entries.length) {
    root.innerHTML = state.wallet
      ? '<p class="empty-state">This wallet has not run any jobs yet. Claim a job to start building session history.</p>'
      : '<p class="empty-state">Sign in to load the recent session history for the active worker wallet.</p>';
    return;
  }

  if (!filteredEntries.length) {
    root.innerHTML =
      '<p class="empty-state">No sessions match the current filter yet. Switch filters or open another run state from the full history.</p>';
    return;
  }

  const cards = filteredEntries.map((entry) => {
    const isCurrent = entry.sessionId === state.session?.sessionId;
    const updated = entry.updatedAt
      ? new Date(entry.updatedAt).toLocaleString("en-CH", { dateStyle: "short", timeStyle: "short" })
      : "-";
    return html`
      <article class="history-card ${isCurrent ? "job-selected" : ""}">
        <div class="job-topline">
          <p class="job-id">${entry.jobId}</p>
          <span class="eligibility-pill ${outcomeTone(entry.verification?.outcome ?? entry.status)}">
            ${entry.status}
          </span>
        </div>
        <div class="catalog-meta">
          <span>${entry.protocolHistory?.join(" / ") ?? "-"}</span>
          <span>${entry.verification?.outcome ?? "pending"}</span>
          <span>${updated}</span>
        </div>
        <p>${entry.sessionId}</p>
        <button class="job-select-button" type="button" data-session-id="${entry.sessionId}">
          ${isCurrent ? "Current session" : "Load session"}
        </button>
      </article>
    `;
  });
  renderHtml(root, html`${cards}`);
}

export function renderJobDetail(job, jobHistory) {
  const summaryRoot = document.getElementById("job-detail-summary");
  const historyRoot = document.getElementById("job-detail-history");
  const historyCount = document.getElementById("job-detail-count");

  if (!summaryRoot || !historyRoot || !historyCount) return;

  if (!job) {
    summaryRoot.innerHTML = '<p class="empty-state">Select a job to inspect its verifier rules, stake requirement, and recent run history for this wallet.</p>';
    historyRoot.innerHTML = '<p class="empty-state">Job-specific run history will appear here after you select a job.</p>';
    historyCount.textContent = "No job selected";
    return;
  }

  const approvedRuns = jobHistory.filter((entry) => entry.verification?.outcome === "approved").length;
  const latestRun = jobHistory[0];

  const latestRunLabel = latestRun
    ? `${latestRun.status} · ${latestRun.verification?.reasonCode ?? "pending verification"}`
    : "This wallet has not run the selected job yet.";

  renderHtml(
    summaryRoot,
    html`
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
          <dd>${latestRunLabel}</dd>
        </div>
      </div>
    `
  );

  historyCount.textContent = `${jobHistory.length} runs for this job`;

  if (!jobHistory.length) {
    historyRoot.innerHTML = '<p class="empty-state">This wallet has not run the selected job yet. Claim it to create the first session.</p>';
    return;
  }

  const runCards = jobHistory.map((entry) => {
    const isCurrent = entry.sessionId === state.session?.sessionId;
    const updated = entry.updatedAt
      ? new Date(entry.updatedAt).toLocaleString("en-CH", { dateStyle: "short", timeStyle: "short" })
      : "-";
    return html`
      <article class="job-run-card ${isCurrent ? "job-selected" : ""}">
        <div class="job-topline">
          <p class="job-id">${entry.sessionId}</p>
          <span class="eligibility-pill ${outcomeTone(entry.verification?.outcome ?? entry.status)}">
            ${entry.verification?.outcome ?? entry.status}
          </span>
        </div>
        <div class="catalog-meta">
          <span>${entry.status}</span>
          <span>${entry.verification?.reasonCode ?? "pending"}</span>
          <span>${updated}</span>
        </div>
        <button class="job-select-button" type="button" data-session-id="${entry.sessionId}">
          ${isCurrent ? "Current run" : "Open run"}
        </button>
      </article>
    `;
  });
  renderHtml(historyRoot, html`${runCards}`);
}

export function renderCatalogJobActivity(job, entries) {
  const summaryRoot = document.getElementById("catalog-job-summary");
  const historyRoot = document.getElementById("catalog-job-history");
  const countRoot = document.getElementById("catalog-job-count");

  if (!summaryRoot || !historyRoot || !countRoot) return;

  if (!job) {
    summaryRoot.innerHTML = '<p class="empty-state">Load any catalog job to inspect worker activity, outcomes, and poster-side monitoring metrics.</p>';
    historyRoot.innerHTML = '<p class="empty-state">Poster-side run activity will appear here after you load a catalog job.</p>';
    countRoot.textContent = "No job selected";
    return;
  }

  const approvedRuns = entries.filter((entry) => entry.verification?.outcome === "approved").length;
  const rejectedRuns = entries.filter((entry) => entry.verification?.outcome === "rejected" || entry.status === "rejected").length;
  const disputedRuns = entries.filter((entry) => entry.status === "disputed" || entry.verification?.outcome === "disputed").length;
  const activeRuns = entries.filter((entry) => ["claimed", "submitted", "verifying", "rejected", "disputed"].includes(entry.status)).length;
  const distinctWallets = new Set(entries.map((entry) => entry.wallet).filter(Boolean)).size;
  const latestRun = entries[0];
  const filteredEntries = filterCatalogEntries(entries);
  const filterLabel = catalogFilterLabel(state.catalogActivityFilter);

  const posterSummary = `${
    job.requiresSponsoredGas ? "Sponsored gas enabled" : "Workers self-fund gas"
  } · TTL ${job.claimTtlSeconds}s · retries ${job.retryLimit}`;
  const latestRunLabel = latestRun
    ? `${latestRun.wallet ?? "unknown_wallet"} · ${latestRun.status} · ${latestRun.verification?.reasonCode ?? "pending verification"}`
    : "No worker runs have been recorded for this job yet.";
  const monitoringFocus = activeRuns
    ? `${activeRuns} run(s) still need poster attention across claim, submit, reject, or dispute stages.`
    : "No active runs right now. This job is currently quiet.";

  renderHtml(
    summaryRoot,
    html`
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
        <div class="detail-stat">
          <dt>Active runs</dt>
          <dd>${activeRuns}</dd>
        </div>
        <div class="detail-stat">
          <dt>Rejected / disputed</dt>
          <dd>${rejectedRuns} / ${disputedRuns}</dd>
        </div>
        <div class="detail-stat detail-span">
          <dt>Poster summary</dt>
          <dd>${posterSummary}</dd>
        </div>
        <div class="detail-stat detail-span">
          <dt>Latest run</dt>
          <dd>${latestRunLabel}</dd>
        </div>
        <div class="detail-stat detail-span">
          <dt>Monitoring focus</dt>
          <dd>${monitoringFocus}</dd>
        </div>
      </div>
    `
  );

  countRoot.textContent = `${filteredEntries.length} ${filterLabel} runs · ${entries.length} total`;

  if (!entries.length) {
    historyRoot.innerHTML = '<p class="empty-state">No worker activity has been recorded for this job yet. Once claims start, runs will appear here.</p>';
    return;
  }

  if (!filteredEntries.length) {
    renderHtml(
      historyRoot,
      html`<p class="empty-state">
        No ${filterLabel} runs match the current filter for this job yet. Switch filters to inspect other worker outcomes.
      </p>`
    );
    return;
  }

  const runCards = filteredEntries.map((entry) => {
    const isCurrent = entry.sessionId === state.session?.sessionId;
    const updated = entry.updatedAt
      ? new Date(entry.updatedAt).toLocaleString("en-CH", { dateStyle: "short", timeStyle: "short" })
      : "-";
    return html`
      <article class="job-run-card ${isCurrent ? "job-selected" : ""}">
        <div class="job-topline">
          <p class="job-id">${entry.wallet ?? "unknown_wallet"}</p>
          <span class="eligibility-pill ${outcomeTone(entry.verification?.outcome ?? entry.status)}">
            ${entry.verification?.outcome ?? entry.status}
          </span>
        </div>
        <div class="catalog-meta">
          <span>${entry.sessionId}</span>
          <span>${entry.verification?.reasonCode ?? "pending"}</span>
          <span>${updated}</span>
        </div>
        <button
          class="job-select-button"
          type="button"
          data-catalog-session-id="${entry.sessionId}"
          data-catalog-job-id="${entry.jobId}"
        >
          ${isCurrent ? "Current run" : "Open run"}
        </button>
      </article>
    `;
  });
  renderHtml(historyRoot, html`${runCards}`);
}

export function updateReputation(reputation) {
  state.reputation = reputation;
  setText("rep-skill", formatAmount(reputation.skill));
  setText("rep-reliability", formatAmount(reputation.reliability));
  setText("rep-economic", formatAmount(reputation.economic));
  setText("tier-badge", reputation.tier ?? "starter");

  const badge = document.getElementById("tier-badge");
  if (!badge) return;
  badge.className = `tier-badge ${reputation.tier === "starter" ? "tier-warn" : "tier-ok"}`;
}

export function updateAccount(account) {
  state.account = account;
  setText("liquid-dot", formatAmount(account.liquid?.DOT));
  setText("reserved-dot", formatAmount(account.reserved?.DOT));
  setText("allocated-dot", formatAmount(account.strategyAllocated?.DOT));
  setText("staked-dot", formatAmount(account.jobStakeLocked?.DOT));
  setText("debt-dot", formatAmount(account.debtOutstanding?.DOT));
  setText("funding-wallet-value", account.wallet ?? state.wallet ?? "-");
  setText("deposited-balance-dot", `${formatAmount(account.liquid?.DOT)} DOT`);
  setText("active-stake-dot", `${formatAmount(account.jobStakeLocked?.DOT)} DOT`);
  renderFundingReadiness();
}

export function applySessionState(session = undefined) {
  state.session = session;
  setText("session-id", session?.sessionId ?? "-");
  setText("session-status", session?.status ?? "-");
  renderSessionDetail();
  persistUiState();
}

export function applyVerificationState(result = undefined) {
  state.verification = result;
  setText("verification-outcome", result?.outcome ?? "-");
  setText("verification-reason", result?.reasonCode ?? "-");
  if (result?.session) {
    applySessionState(result.session);
    return;
  }
  renderSessionDetail();
}

function setRunbookStepState(id, status, title, copy) {
  const card = document.getElementById(id);
  if (!card) return;
  card.classList.toggle("is-active", status === "active");
  card.classList.toggle("is-complete", status === "complete");
  const strong = card.querySelector("strong");
  const span = card.querySelector("span");
  if (strong) strong.textContent = title;
  if (span) span.textContent = copy;
}

function updateWorkRunbook(readiness, hasSession, hasVerification, hasVerifierRole) {
  const focusPill = document.getElementById("work-focus-pill");
  const walletReady = Boolean(state.wallet);
  const canClaim = Boolean(readiness?.canClaim);
  const sessionStatus = state.session?.status ?? "";
  const submitted = sessionStatus === "submitted";
  const settled = Boolean(hasVerification);

  setRunbookStepState(
    "work-step-auth",
    walletReady ? "complete" : "active",
    walletReady ? "Wallet connected" : "Connect wallet",
    walletReady ? "This wallet is signed in and ready." : "Start by signing in with the wallet that will run the job."
  );
  setRunbookStepState(
    "work-step-funding",
    !walletReady ? "default" : canClaim || hasSession ? "complete" : "active",
    canClaim || hasSession ? "Stake covered" : "Top up balance",
    canClaim || hasSession
      ? "This wallet already covers the required claim stake."
      : "Add funds if this run needs claim stake before it can start."
  );
  setRunbookStepState(
    "work-step-execution",
    !walletReady || (!canClaim && !hasSession) ? "default" : hasSession ? "active" : "complete",
    hasSession ? (submitted ? "Submission sent" : "Run in progress") : "Claim and submit",
    hasSession
      ? "Move from claimed work to a finished submission."
      : "Open the run, complete the work, and submit the result."
  );
  setRunbookStepState(
    "work-step-settlement",
    settled ? "complete" : submitted ? "active" : "default",
    settled ? "Result settled" : hasVerifierRole ? "Verify result" : "Await verifier",
    settled
      ? "This run already has a verifier outcome."
      : submitted
        ? (hasVerifierRole ? "Run the verifier to close out this submission." : "A verifier-scoped wallet must close out this submission.")
        : "This step unlocks after the submission is sent."
  );

  if (focusPill) {
    if (!walletReady) {
      focusPill.className = "status-pill status-pending";
      focusPill.textContent = "Waiting for wallet";
      setText("work-focus-title", "Connect and sign in first.");
      setText("work-focus-copy", "Start with the wallet that will fund, claim, and submit the run.");
      return;
    }
    if (!canClaim && !hasSession) {
      focusPill.className = "status-pill status-pending";
      focusPill.textContent = readiness?.label ?? "Fund first";
      setText("work-focus-title", "Make this run claim-ready.");
      setText("work-focus-copy", readiness?.guidance ?? "Add deposited DOT until this run is fully covered.");
      return;
    }
    if (!hasSession) {
      focusPill.className = "status-pill status-ok";
      focusPill.textContent = "Ready to claim";
      setText("work-focus-title", "Claim this job.");
      setText("work-focus-copy", "The wallet is ready, so you can open the run now.");
      return;
    }
    if (sessionStatus === "claimed") {
      focusPill.className = "status-pill status-ok";
      focusPill.textContent = "Finish the submission";
      setText("work-focus-title", "Complete the work and submit it.");
      setText("work-focus-copy", "This run is already open. Use the editor, then send the result.");
      return;
    }
    if (submitted && !settled) {
      focusPill.className = hasVerifierRole ? "status-pill status-ok" : "status-pill status-pending";
      focusPill.textContent = hasVerifierRole ? "Ready to verify" : "Verifier required";
      setText("work-focus-title", hasVerifierRole ? "Verify this run." : "Switch to a verifier wallet.");
      setText("work-focus-copy", hasVerifierRole
        ? "The submission is in place. Run verification when you are ready to close it out."
        : "This submission is ready, but the current wallet cannot settle it.");
      return;
    }

    focusPill.className = "status-pill status-ok";
    focusPill.textContent = "Run settled";
    setText("work-focus-title", "Review the result or pick the next run.");
    setText("work-focus-copy", "This run already has an outcome, so the next useful action is to open another job or review the history.");
  }
}

export function refreshActionPanel() {
  const claimButton = document.getElementById("claim-button");
  const submitButton = document.getElementById("submit-button");
  const verifyButton = document.getElementById("verify-button");
  const refreshButton = document.getElementById("refresh-session-button");
  const readiness = getFundingReadiness();
  const execution = getExecutionState();

  const hasJob = Boolean(state.selectedJob);
  const sessionStatus = state.session?.status ?? "";
  const hasSession = Boolean(state.session?.sessionId);
  const hasSubmitted = sessionStatus === "submitted" || sessionStatus === "resolved" || sessionStatus === "verifying" || sessionStatus === "disputed";
  const hasVerification = Boolean(state.verification?.outcome);
  const canSubmit = hasSession && sessionStatus === "claimed" && !hasVerification;
  const hasVerifierRole = state.authRoles.includes("verifier");
  const canVerify = hasSession && sessionStatus === "submitted" && !hasVerification && hasVerifierRole;
  const claimBlocked = !hasJob || !readiness.canClaim || hasSession;

  claimButton.disabled = claimBlocked;
  submitButton.disabled = !canSubmit;
  verifyButton.disabled = !canVerify;
  refreshButton.disabled = !hasSession;
  updateWorkRunbook(readiness, hasSession, hasVerification, hasVerifierRole);

  setText("execution-stage", execution.stage);
  setText("execution-next-step", execution.next);
  setText("execution-blocker", execution.blocker);

  if (!state.wallet) {
    setActionStatus("Sign in", "status-pending");
    setText("action-guidance", "Sign in first. After that, this panel will guide you through funding, claiming, submitting, and settling.");
    return;
  }

  if (!hasJob) {
    setActionStatus("Awaiting job", "status-pending");
    setText("action-guidance", "Choose a recommended or catalog job to load what it pays, what it needs, and what to do next.");
    return;
  }

  if (hasVerification) {
    const approved = state.verification.outcome === "approved";
    const rejected = state.verification.outcome === "rejected";
    setActionStatus(
      approved ? "Verified" : rejected ? "Pending dispute window" : "Needs review",
      approved ? "status-ok" : "status-pending"
    );
    setText(
      "action-guidance",
      approved
        ? "This run is settled. Review the result or move on to another job."
        : "The verifier has responded. If the result is contested, wait for or open the dispute flow before expecting stake or reputation changes."
    );
    return;
  }

  if (sessionStatus === "rejected") {
    setActionStatus("Pending dispute window", "status-pending");
    setText(
      "action-guidance",
      "This run is provisionally rejected. Stake and reputation stay pending until the dispute window closes or arbitration resolves the outcome."
    );
    return;
  }

  if (hasSession && sessionStatus === "submitted" && !hasVerification && !hasVerifierRole) {
    setActionStatus("Verifier required", "status-pending");
    setText(
      "action-guidance",
      "This submission is ready, but the current wallet does not have the verifier role. Sign in with a verifier wallet to finish it here."
    );
    return;
  }

  if (hasSubmitted) {
    setActionStatus("Submitted", "status-ok");
    setText("action-guidance", "The submission is stored. Run the verifier when you are ready to close out this run.");
    return;
  }

  if (hasSession) {
    setActionStatus("Claimed", "status-ok");
    setText("action-guidance", "The run is open. Fill in or edit the submission, then send it for verification.");
    return;
  }

  if (!readiness.canClaim) {
    setActionStatus(readiness.label, readiness.tone);
    setText("action-guidance", readiness.guidance);
    return;
  }

  setActionStatus("Ready", "status-ok");
  setText("action-guidance", "This run is ready. The required stake is covered, so you can claim it now.");
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
      ? `${job.category} job · ${job.claimTtlSeconds}s to claim · ${job.retryLimit} retries · ${formatAmount(job.preflight?.claimStake ?? 0)} ${job.rewardAsset} stake required · ${formatAmount(job.preflight?.availableLiquidity ?? 0)} ${job.rewardAsset} already deposited.`
      : "Select a job to see what it pays, what it needs, and how to complete it."
  );

  const evidenceInput = document.getElementById("evidence-input");
  if (evidenceInput && job && (previousJobId !== job.id || !evidenceInput.value.trim())) {
    evidenceInput.value = buildEvidenceTemplate(job);
  }

  renderRecommendations(state.recommendations);
  renderCatalog(state.catalog);
  renderSessionDetail();
  persistUiState();
  renderFundingReadiness();
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
