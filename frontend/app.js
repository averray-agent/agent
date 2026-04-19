import { getAuthSnapshot, getAuthWallet, onAuthChange, signIn, signOut } from "./auth.js";
import { DEFAULT_ESCALATION_MESSAGE, DEFAULT_POSTER_TERMS } from "./constants.js";
import { startEventStream } from "./events.js";
import { postJson, readJson } from "./http-client.js";
import { initObservability } from "./observability.js";
import { buildEvidenceTemplate, parseTerms } from "./job-utils.js";
import { apiUrl } from "./config.js";
import {
  applySessionState,
  renderOpsDeck,
  applyVerificationState,
  refreshActionPanel,
  renderActivityFeed,
  renderCatalog,
  renderCatalogJobActivity,
  renderJobDetail,
  renderHistory,
  renderRecommendations,
  refreshTreasurySurfaces,
  setActionFeedback,
  setFundingFeedback,
  setPosterFeedback,
  setWalletFeedback,
  updateAccount,
  updateReputation,
  updateSelectedJob
} from "./renderers.js";
import { readPersistedState, state } from "./state.js";
import { debug, html, renderHtml, setButtonBusy, setOverallStatus, setText, showToast } from "./ui-helpers.js";

let stopEventStream = undefined;
let liveRefreshTimer = undefined;
let authMode = "strict";
const WORKSPACE_MODE_STORAGE_KEY = "averray:workspace-mode";
const WORKSPACE_MODES = ["work", "admin", "observe"];
const platformStatus = {
  protocols: [],
  verifierModes: [],
  strategies: [],
  strategyDocs: "",
  authMode: "strict",
  catalogCount: 0,
  indexReady: false
};

function formatOpsAmount(value, asset = "DOT") {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return `- ${asset}`;
  return `${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${asset}`;
}

function formatCompactCount(value, fallback = "0") {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return fallback;
  return amount.toLocaleString("en-US");
}

function inferWorkspaceModeFromHash(hash = window.location.hash) {
  if (!hash) return undefined;
  if (hash === "#admin-workspace" || hash === "#catalog-workspace") return "admin";
  if (hash === "#ops-details") return "observe";
  if (hash === "#workspace-core" || hash === "#jobs-workspace") return "work";
  return undefined;
}

function setWorkspaceMode(mode = "work", options = {}) {
  const { persist = true, focusTargetId = undefined } = options;
  const nextMode = WORKSPACE_MODES.includes(mode) ? mode : "work";
  const buttons = document.querySelectorAll("[data-workspace-mode]");
  const panels = document.querySelectorAll("[data-workspace-panel]");

  buttons.forEach((button) => {
    const active = button.getAttribute("data-workspace-mode") === nextMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });

  panels.forEach((panel) => {
    const active = panel.getAttribute("data-workspace-panel") === nextMode;
    panel.hidden = !active;
    panel.setAttribute("aria-hidden", active ? "false" : "true");
  });

  if (persist) {
    localStorage.setItem(WORKSPACE_MODE_STORAGE_KEY, nextMode);
  }

  if (focusTargetId) {
    requestAnimationFrame(() => {
      document.getElementById(focusTargetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

function jumpToSection(id, options = {}) {
  const { mode = undefined, expandId = undefined } = options;
  if (mode) setWorkspaceMode(mode);
  if (expandId) {
    document.getElementById(expandId)?.setAttribute("open", "");
  }
  requestAnimationFrame(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function wireWorkspaceModes() {
  const buttons = document.querySelectorAll("[data-workspace-mode]");
  const adminLink = document.getElementById("auth-admin-link");
  const initialMode = inferWorkspaceModeFromHash()
    || localStorage.getItem(WORKSPACE_MODE_STORAGE_KEY)
    || "work";

  setWorkspaceMode(initialMode, { persist: false });

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      setWorkspaceMode(button.getAttribute("data-workspace-mode") ?? "work");
    });
  });

  adminLink?.addEventListener("click", (event) => {
    event.preventDefault();
    setWorkspaceMode("admin", { focusTargetId: "admin-workspace" });
    window.history.replaceState(null, "", "#admin-workspace");
  });

  window.addEventListener("hashchange", () => {
    const mode = inferWorkspaceModeFromHash();
    if (mode) {
      setWorkspaceMode(mode, { persist: false });
    }
  });
}

function formatAdminNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Unknown";
  if (number === Number.MAX_SAFE_INTEGER || number >= 1e15) return "Unlimited";
  return number.toLocaleString("en-US");
}

function compactOpsWallet(wallet = "") {
  return wallet && wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet || "Unknown wallet";
}

function shortenWallet(wallet) {
  if (!wallet) return "";
  return wallet.length > 10 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;
}

function hasRole(role, roles = state.authRoles) {
  return Array.isArray(roles) && roles.includes(role);
}

function roleSummary(roles = state.authRoles) {
  if (!Array.isArray(roles) || roles.length === 0) {
    return "No control-plane roles";
  }
  return roles.map((role) => role.toUpperCase()).join(" · ");
}

function renderRolePills(rootId, roles = state.authRoles) {
  const root = document.getElementById(rootId);
  if (!root) return;
  root.innerHTML = "";
  if (!Array.isArray(roles) || roles.length === 0) {
    root.hidden = true;
    return;
  }

  for (const role of roles) {
    const pill = document.createElement("span");
    pill.className = `role-pill role-pill-${role}`;
    pill.textContent = role.toUpperCase();
    pill.title = "Role badge";
    pill.setAttribute("aria-label", `${role} role badge`);
    root.appendChild(pill);
  }
  root.hidden = false;
}

function setAuthFeedback(text, tone = "neutral") {
  const feedback = document.getElementById("auth-feedback");
  if (!feedback) return;
  feedback.textContent = text;
  feedback.setAttribute("data-tone", tone);
}

function setAdminFeedback(text, tone = "neutral") {
  const feedback = document.getElementById("admin-fire-feedback");
  if (!feedback) return;
  feedback.textContent = text;
  feedback.setAttribute("data-tone", tone);
}

function renderRecurringStatus(status = undefined) {
  const root = document.getElementById("admin-recurring-status");
  const count = document.getElementById("admin-recurring-count");
  if (!root || !count) return;

  if (!status?.templates?.length) {
    count.textContent = status ? "No recurring templates" : "Waiting for admin status";
    renderHtml(root, html`<p class="empty-state">Recurring templates will appear here once an admin-scoped wallet is signed in and templates exist in the live catalog.</p>`);
    return;
  }

  count.textContent = `${status.templates.length} template${status.templates.length === 1 ? "" : "s"}`;
  renderHtml(
    root,
    html`${status.templates.map((entry) => html`
      <article class="admin-status-card">
        <div class="admin-status-topline">
          <div>
            <p class="panel-label">Template</p>
            <h3>${entry.templateId}</h3>
          </div>
          <span class="status-pill ${entry.derivativeCount > 0 ? "status-ok" : "status-pending"}">
            ${entry.derivativeCount > 0 ? "Fired before" : "Awaiting first fire"}
          </span>
        </div>
        <div class="admin-meta-row">
          <span>${entry.category}</span>
          <span>${entry.tier}</span>
          <span>${entry.verifierMode}</span>
          <span>${entry.schedule?.cron ?? "No cron"}</span>
        </div>
        <p class="section-note">
          ${entry.derivativeCount} derivative run${entry.derivativeCount === 1 ? "" : "s"} so far.
          ${entry.lastFiredAt ? `Last fired ${formatExpiry(entry.lastFiredAt)}.` : "No derivative has been minted yet."}
        </p>
      </article>
    `)}`,
  );
}

function renderMaintenanceStatus(maintenance = undefined) {
  const root = document.getElementById("admin-maintenance-status");
  if (!root) return;

  if (!maintenance) {
    renderHtml(root, html`<p class="empty-state">Sign in with an admin-scoped wallet to load maintenance and release posture.</p>`);
    return;
  }

  const policy = maintenance.policy ?? {};
  const release = maintenance.release ?? {};
  renderHtml(
    root,
    html`
      <div class="admin-maintenance-grid">
        <article class="admin-status-card">
          <div class="admin-status-topline">
            <div>
              <p class="panel-label">Treasury policy</p>
              <h3>${policy.policyAddress ?? "Unavailable"}</h3>
            </div>
            <span class="status-pill ${policy.paused ? "tier-warn" : "status-ok"}">
              ${policy.paused ? "Paused" : policy.enabled ? "Live" : "Off-chain"}
            </span>
          </div>
          <p class="section-note">Owner ${policy.owner ?? "unknown"} · Pauser ${policy.pauser ?? "unknown"}</p>
        </article>
        <article class="admin-status-card">
          <p class="panel-label">Risk parameters</p>
          <dl class="admin-inline-metrics">
            <div><dt>Daily outflow cap</dt><dd>${formatAdminNumber(policy.risk?.dailyOutflowCap)}</dd></div>
            <div><dt>Borrow cap</dt><dd>${formatAdminNumber(policy.risk?.perAccountBorrowCap)}</dd></div>
            <div><dt>Collateral ratio</dt><dd>${formatAdminNumber(policy.risk?.minimumCollateralRatioBps)} bps</dd></div>
            <div><dt>Claim stake</dt><dd>${formatAdminNumber(policy.risk?.defaultClaimStakeBps)} bps</dd></div>
          </dl>
        </article>
        <article class="admin-status-card">
          <p class="panel-label">Release posture</p>
          <div class="admin-doc-links">
            <a class="secondary-action" href="${release.checklistDoc}" target="_blank" rel="noreferrer">Production checklist</a>
            <a class="secondary-action" href="${release.incidentDoc}" target="_blank" rel="noreferrer">Incident response</a>
            <a class="secondary-action" href="${release.multisigDoc}" target="_blank" rel="noreferrer">Multisig guide</a>
          </div>
        </article>
      </div>
    `
  );
}

function buildLocalOpsSnapshot() {
  const activeStatuses = new Set(["claimed", "submitted", "disputed", "rejected"]);
  const recentSessions = (state.history ?? []).slice(0, 6);
  const activeSessions = recentSessions.filter((entry) => activeStatuses.has(entry.status));
  const localJobs = [...recentSessions.reduce((accumulator, session) => {
    const current = accumulator.get(session.jobId) ?? {
      jobId: session.jobId,
      activeRuns: 0,
      totalRuns: 0,
      latestStatus: session.status,
      latestAt: session.updatedAt
    };
    current.totalRuns += 1;
    if (activeStatuses.has(session.status)) current.activeRuns += 1;
    if (String(session.updatedAt ?? "") > String(current.latestAt ?? "")) {
      current.latestAt = session.updatedAt;
      current.latestStatus = session.status;
    }
    accumulator.set(session.jobId, current);
    return accumulator;
  }, new Map()).values()].slice(0, 4);

  if (!state.wallet) {
    return {
      headline: "The operator room is waiting for a signed-in wallet.",
      copy: "Sign in first, then this deck will switch from setup copy to live worker motion, claim stake, and operator pulse.",
      pill: { label: "Awaiting sign-in", tone: "status-pending" },
      metrics: {
        activeRuns: { value: "-", copy: "No wallet session yet" },
        activeAgents: { value: "-", copy: "Admin snapshot required for platform-wide view" },
        capitalAtWork: { value: "-", copy: "Claim stake appears after sign-in" },
        treasury: { value: "Locked", copy: "Admin view reveals treasury posture" }
      },
      flowLabel: "Sign in to load job flow",
      pulseLabel: "Sign in to load event pulse",
      emptyFlow: "No job flow is visible until a wallet signs in and loads session history.",
      emptyPulse: "No event pulse is visible until the wallet event stream is active.",
      topJobs: [],
      recentSessions: [],
      pulseItems: []
    };
  }

  return {
    headline: activeSessions.length
      ? "This operator wallet has live runs in motion."
      : "The operator wallet is connected and ready for the next run.",
    copy: activeSessions.length
      ? "Use the live deck to see which runs are still in flight, how much stake is currently at work, and what the wallet has touched most recently."
      : "The page is live, but the current picture is still wallet-scoped until an admin session unlocks the global platform snapshot.",
    pill: {
      label: activeSessions.length ? "Wallet live" : "Wallet ready",
      tone: activeSessions.length ? "status-ok" : "status-pending"
    },
    metrics: {
      activeRuns: {
        value: String(activeSessions.length),
        copy: activeSessions.length ? "Runs still moving through claim, submit, or dispute." : "No active runs for this wallet."
      },
      activeAgents: {
        value: "1 wallet",
        copy: "Sign in as admin to see platform-wide agent activity."
      },
      capitalAtWork: {
        value: formatOpsAmount(activeSessions.reduce((sum, entry) => sum + Number(entry.claimStake ?? 0), 0)),
        copy: "Claim stake currently tied to this wallet's in-flight runs."
      },
      treasury: {
        value: formatOpsAmount(state.account?.liquid?.DOT ?? 0),
        copy: "Deposited DOT visible from the current operator wallet."
      }
    },
    flowLabel: `${recentSessions.length} wallet session${recentSessions.length === 1 ? "" : "s"} in view`,
    pulseLabel: `${Math.min(state.activity.length, 6)} recent wallet events`,
    topJobs: localJobs,
    recentSessions: recentSessions.map((entry) => ({
      ...entry,
      claimStakeLabel: formatOpsAmount(entry.claimStake ?? 0)
    })),
    pulseItems: (state.activity ?? []).slice(0, 6)
  };
}

function buildAdminOpsSnapshot(status = {}) {
  const ops = status.ops ?? {};
  const policy = status.maintenance?.policy ?? {};
  const treasuryLabel = policy.paused
    ? "Paused"
    : policy.enabled
      ? `${formatAdminNumber(policy.risk?.dailyOutflowCap)} DOT cap`
      : "Off-chain";
  const treasuryCopy = policy.paused
    ? "Treasury policy is paused. Operator intervention is required before capital should move."
    : policy.enabled
      ? `Daily outflow cap ${formatAdminNumber(policy.risk?.dailyOutflowCap)} DOT · default claim stake ${formatAdminNumber(policy.risk?.defaultClaimStakeBps)} bps.`
      : "Treasury policy is not currently enforced on-chain in this environment.";
  const anomalies = (status.anomalies ?? []).map((entry) => ({
    kind: "anomaly",
    title: entry.code === "policy_paused" ? "Treasury policy paused" : "Runtime attention needed",
    body: entry.message,
    label: entry.severity ?? "Attention",
    tone: entry.severity === "high" ? "eligible-no" : "tier-warn"
  }));

  return {
    headline: ops.activeSessions
      ? `${ops.activeSessions} live run${ops.activeSessions === 1 ? "" : "s"} are moving through the platform right now.`
      : "The platform is live, but no runs are currently in motion.",
    copy: ops.activeSessions
      ? `Recent flow shows ${ops.activeWallets} active wallet${ops.activeWallets === 1 ? "" : "s"} and ${formatOpsAmount(
          ops.totalCapitalAtWork
        )} currently committed as claim stake.`
      : "Use this deck as the operating picture for treasury posture, recent claims, and the jobs agents are actually touching.",
    pill: {
      label: anomalies.length ? "Attention on deck" : ops.activeSessions ? "Platform moving" : "Platform idle",
      tone: anomalies.length ? "tier-warn" : ops.activeSessions ? "status-ok" : "status-pending"
    },
    metrics: {
      activeRuns: {
        value: String(ops.activeSessions ?? 0),
        copy: `${ops.resolvedRecently ?? 0} recently resolved in the current snapshot window.`
      },
      activeAgents: {
        value: String(ops.activeWallets ?? 0),
        copy: "Unique wallets seen across the recent admin session window."
      },
      capitalAtWork: {
        value: formatOpsAmount(ops.totalCapitalAtWork ?? 0),
        copy: "Claim stake currently tied to runs that are still active."
      },
      treasury: {
        value: treasuryLabel,
        copy: treasuryCopy
      }
    },
    flowLabel: `${(ops.topJobs ?? []).length} hot job lanes · ${(ops.recentSessions ?? []).length} recent runs`,
    pulseLabel: `${(status.anomalies ?? []).length} anomalies · ${(ops.recentEvents ?? []).length} recent events`,
    topJobs: ops.topJobs ?? [],
    recentSessions: (ops.recentSessions ?? []).map((entry) => ({
      ...entry,
      wallet: compactOpsWallet(entry.wallet),
      claimStakeLabel: formatOpsAmount(entry.claimStake ?? 0)
    })),
    pulseItems: [...anomalies, ...(ops.recentEvents ?? []).slice(0, 7)],
    emptyFlow: "No recent platform runs are available yet.",
    emptyPulse: "No recent platform events are buffered right now."
  };
}

function renderProductMap(snapshot = getAuthSnapshot()) {
  const isAdmin = hasRole("admin", snapshot.roles ?? []);
  const isVerifier = hasRole("verifier", snapshot.roles ?? []);
  const authenticated = Boolean(snapshot.authenticated && state.wallet);
  const activeSessionCount = (state.history ?? []).filter((entry) => ["claimed", "submitted", "rejected", "disputed"].includes(entry.status)).length;
  const recommendationCount = state.recommendations?.length ?? 0;
  const liquidDot = Number(state.account?.liquid?.DOT ?? 0);
  const allocatedDot = Number(state.account?.strategyAllocated?.DOT ?? 0);
  const debtDot = Number(state.account?.debtOutstanding?.DOT ?? 0);
  const productPill = document.getElementById("product-map-pill");

  let pillLabel = "Loading picture";
  let pillTone = "status-pending";
  let workTitle = "Run agent work";
  let workMetric = "Waiting for wallet";
  let workSupport = "Run lane offline";

  let treasuryTitle = "Move capital through the account layer";
  let treasuryMetric = "Waiting for balances";
  let treasurySupport = "Treasury lane offline";

  let controlTitle = "Operate supply and policy";
  let controlMetric = "Waiting for roles";
  let controlSupport = "Control lane locked";

  if (authenticated) {
    pillLabel = isAdmin || isVerifier ? "Full platform view" : "Operator wallet live";
    pillTone = isAdmin || isVerifier ? "status-ok" : "status-pending";

    workTitle = activeSessionCount > 0 ? "Keep active runs moving" : "Open the next earning run";
    workMetric = activeSessionCount > 0
      ? `${formatCompactCount(activeSessionCount)} active run${activeSessionCount === 1 ? "" : "s"}`
      : `${formatCompactCount(recommendationCount)} recommendation${recommendationCount === 1 ? "" : "s"} ready`;
    workSupport = activeSessionCount > 0
      ? "In-flight sessions on this wallet"
      : "Queue ready";

    treasuryTitle = "See where account capital is sitting";
    treasuryMetric = `${formatOpsAmount(liquidDot)} liquid · ${formatOpsAmount(allocatedDot)} allocated`;
    treasurySupport = debtDot > 0
      ? `${formatOpsAmount(debtDot)} debt active`
      : "No debt active";

    if (isAdmin || isVerifier) {
      controlTitle = isAdmin ? "Operate the market side of the platform" : "Settle and monitor platform flow";
      controlMetric = isAdmin && isVerifier
        ? "Admin + verifier access"
        : isAdmin
          ? "Admin access live"
          : "Verifier access live";
      controlSupport = isAdmin
        ? `${formatCompactCount(platformStatus.catalogCount)} live job${platformStatus.catalogCount === 1 ? "" : "s"} and ${formatCompactCount(platformStatus.verifierModes.length)} verifier mode${platformStatus.verifierModes.length === 1 ? "" : "s"} in view.`
        : "Settlement and runtime oversight are available even without admin mutation rights.";
      pillTone = "status-ok";
    }
  }

  setText("product-lane-work-title", workTitle);
  setText("product-lane-work-metric", workMetric);
  setText("product-lane-work-support", workSupport);
  setText("product-lane-treasury-title", treasuryTitle);
  setText("product-lane-treasury-metric", treasuryMetric);
  setText("product-lane-treasury-support", treasurySupport);
  setText("product-lane-control-title", controlTitle);
  setText("product-lane-control-metric", controlMetric);
  setText("product-lane-control-support", controlSupport);
  if (productPill) {
    productPill.textContent = pillLabel;
    productPill.className = `status-pill ${pillTone}`;
  }
}

function renderStartGuide(snapshot = getAuthSnapshot()) {
  const isAdmin = hasRole("admin", snapshot.roles ?? []);
  const isVerifier = hasRole("verifier", snapshot.roles ?? []);
  const hasJob = Boolean(state.selectedJobId);
  const hasSession = Boolean(state.session?.sessionId);
  const sessionStatus = state.session?.status ?? "";
  const hasOutcome = Boolean(state.verification?.outcome);
  const workReady = Boolean(state.wallet);
  const guidePill = document.getElementById("start-guide-pill");
  const humanButton = document.getElementById("start-human-button");
  const adminButton = document.getElementById("start-admin-button");

  let nowTitle = "Connect a wallet first.";
  let nowCopy = "Wallet sign-in is the first step for the in-app worker flow. If you are integrating as an agent, open the onboarding contract instead of the browser flow.";
  let guideTitle = "This page is the operator surface for earning, treasury, and control.";
  let humanTitle = "Run earning flows from this browser";
  let humanCopy = "Sign in, fund the wallet if needed, choose a run, then move it through claim, submission, and settlement.";
  let humanButtonLabel = "Start worker flow";
  let adminTitle = isAdmin || isVerifier ? "Operate or watch the platform" : "Watch platform motion";
  let adminCopy = isAdmin || isVerifier
    ? "Open the control surface to create supply, inspect recurring runtime, and watch treasury and policy posture."
    : "Open the live ops view to see capital, treasury posture, and recent runtime events.";
  let adminButtonLabel = isAdmin || isVerifier ? "Open control workspace" : "Open live ops view";
  let pillLabel = "Orienting";
  let pillTone = "status-pending";

  if (workReady && !hasJob) {
    nowTitle = "Choose a job next.";
    nowCopy = "The wallet is authenticated. Pick a recommendation to load the stake requirement and the run flow.";
    humanTitle = "Open the worker queue";
    humanCopy = "Recommendations are ready. The next useful move is to select one run and inspect its stake and verifier requirements.";
    humanButtonLabel = "Choose a job";
    pillLabel = "Worker ready";
    pillTone = "status-ok";
  } else if (workReady && hasJob && !hasSession) {
    nowTitle = "Claim the selected job.";
    nowCopy = "You already have a wallet and a selected run. The next step is to open the session from the execution flow.";
    humanTitle = "Move the selected run into session";
    humanCopy = "Claim opens the active session. After that, submit the evidence payload and settle it.";
    humanButtonLabel = "Open execution flow";
    pillLabel = "Run selected";
    pillTone = "status-ok";
  } else if (hasSession && sessionStatus === "claimed") {
    nowTitle = "Submit the evidence payload.";
    nowCopy = "The job is already claimed. Stay in Work mode and move the run from claimed to submitted.";
    humanTitle = "Finish the claimed run";
    humanCopy = "Complete the evidence editor, submit the result, and then hand off to settlement.";
    humanButtonLabel = "Finish submission";
    pillLabel = "Run in progress";
    pillTone = "status-ok";
  } else if (hasSession && sessionStatus === "submitted") {
    nowTitle = isVerifier ? "Settle the submitted run." : "Switch to a verifier wallet or inspect the submitted run.";
    nowCopy = isVerifier
      ? "This run is ready for settlement. The verifier action is the next step."
      : "The run is already submitted. A verifier-scoped wallet is needed for the settlement step.";
    humanTitle = isVerifier ? "Complete settlement" : "Inspect the submitted run";
    humanCopy = isVerifier
      ? "Use the verify action now to close the run and publish the outcome."
      : "You have reached the handoff point. The remaining step is verifier settlement.";
    humanButtonLabel = "Open current run";
    pillLabel = isVerifier ? "Ready to settle" : "Verifier needed";
    pillTone = isVerifier ? "status-ok" : "tier-warn";
  } else if (hasOutcome) {
    nowTitle = "Inspect the result or start the next run.";
    nowCopy = "This session already has an outcome. Review the result, then move back into the queue for another run.";
    humanTitle = "Return to the queue";
    humanCopy = "The current run is no longer the bottleneck. Use the recommendations and history to decide the next move.";
    humanButtonLabel = "Pick next run";
    pillLabel = "Outcome recorded";
    pillTone = "status-ok";
  }

  if (isAdmin || isVerifier) {
    guideTitle = "This page works as a live operator room for earnings, treasury, and control.";
  } else if (!workReady) {
    guideTitle = "Start as either a human operator, an agent integration, or a treasury observer.";
  }

  setText("start-guide-title", guideTitle);
  setText("start-now-title", nowTitle);
  setText("start-now-copy", nowCopy);
  setText("start-human-title", humanTitle);
  setText("start-human-copy", humanCopy);
  setText("start-admin-title", adminTitle);
  setText("start-admin-copy", adminCopy);
  if (humanButton) humanButton.textContent = humanButtonLabel;
  if (adminButton) adminButton.textContent = adminButtonLabel;
  if (guidePill) {
    guidePill.textContent = pillLabel;
    guidePill.className = `status-pill ${pillTone}`;
  }
}

async function refreshOpsDeck(snapshot = getAuthSnapshot()) {
  if (snapshot.authenticated && hasRole("admin", snapshot.roles ?? [])) {
    try {
      const status = await readJson("/api/admin/status");
      renderOpsDeck(buildAdminOpsSnapshot(status));
      return status;
    } catch (error) {
      debug.error(error);
    }
  }

  renderOpsDeck(buildLocalOpsSnapshot());
  return undefined;
}

function refreshAdminConsole(snapshot = getAuthSnapshot()) {
  const adminEnabled = hasRole("admin", snapshot.roles ?? []);
  const verifierEnabled = hasRole("verifier", snapshot.roles ?? []);
  const recurringTemplateInput = document.getElementById("admin-template-id");
  const selectedRecurring = Boolean(state.selectedJob?.recurring);
  const consolePill = document.getElementById("admin-console-pill");
  const createButton = document.getElementById("admin-console-create-button");
  const fireButton = document.getElementById("admin-console-fire-button");
  const statusButton = document.getElementById("admin-console-status-button");
  const catalogButton = document.getElementById("admin-console-catalog-button");

  setText(
    "admin-console-state",
    !snapshot.authenticated
      ? "Locked"
      : adminEnabled && verifierEnabled
        ? "Admin + verifier"
        : adminEnabled
          ? "Admin ready"
          : verifierEnabled
            ? "Verifier ready"
            : "Worker-only"
  );

  if (!snapshot.authenticated) {
    if (consolePill) consolePill.className = "status-pill status-pending";
    setText("admin-console-pill", "Awaiting sign-in");
    setText("admin-console-next", "Authenticate");
    setText("admin-console-copy", "Sign in with an admin or verifier-scoped wallet to unlock internal commands.");
    setText("admin-console-hint", "No control-plane actions are available until the operator wallet is authenticated.");
  } else if (adminEnabled) {
    if (consolePill) consolePill.className = "status-pill status-ok";
    setText("admin-console-pill", "Console live");
    setText("admin-console-next", selectedRecurring ? "Fire recurring template" : "Create or review jobs");
    setText(
      "admin-console-copy",
      selectedRecurring
        ? `Selected template ${state.selectedJob.id} can be fired directly from the command deck.`
        : `Catalog has ${platformStatus.catalogCount} live jobs. Use the create form or inspect status before changing live state.`
    );
    setText(
      "admin-console-hint",
      selectedRecurring
        ? "The current recurring template is ready to drop into the fire form."
        : "Jump straight to the create form, recurring fire, status, or catalog activity."
    );
  } else if (verifierEnabled) {
    if (consolePill) consolePill.className = "status-pill status-pending";
    setText("admin-console-pill", "Verifier only");
    setText("admin-console-next", "Settle from Work mode");
    setText("admin-console-copy", "This wallet can settle submitted sessions but cannot create jobs or fire templates.");
    setText("admin-console-hint", "Switch back to Work mode to run verifier settlement on submitted sessions.");
  } else {
    if (consolePill) consolePill.className = "status-pill status-pending";
    setText("admin-console-pill", "Worker-only");
    setText("admin-console-next", "No admin actions");
    setText("admin-console-copy", "This wallet can inspect the control plane, but it cannot mutate admin state.");
    setText("admin-console-hint", "Admin-scoped wallets unlock job creation and recurring template actions.");
  }

  if (createButton) {
    createButton.disabled = !adminEnabled;
    createButton.title = adminEnabled ? "" : "Admin role required.";
  }
  if (fireButton) {
    fireButton.disabled = !adminEnabled;
    fireButton.title = adminEnabled ? "" : "Admin role required.";
  }
  if (statusButton) {
    statusButton.disabled = !snapshot.authenticated;
  }
  if (catalogButton) {
    catalogButton.disabled = platformStatus.catalogCount === 0;
  }
  if (recurringTemplateInput && adminEnabled && selectedRecurring && !recurringTemplateInput.value.trim()) {
    recurringTemplateInput.value = state.selectedJob.id;
  }
}

function formatExpiry(expiresAt) {
  if (!expiresAt) return "No active token";
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return expiresAt;
  return date.toLocaleString("en-CH", { dateStyle: "medium", timeStyle: "short" });
}

function syncPublicProfileLinks(wallet = "") {
  const links = document.getElementById("auth-profile-links");
  const pageLink = document.getElementById("auth-profile-page-link");
  const jsonLink = document.getElementById("auth-profile-json-link");
  const adminLink = document.getElementById("auth-admin-link");
  if (!links || !pageLink || !jsonLink) return;

  if (!wallet) {
    links.hidden = true;
    pageLink.href = "./agent.html";
    jsonLink.href = apiUrl("/agents/");
    if (adminLink) adminLink.hidden = true;
    return;
  }

  const encodedWallet = encodeURIComponent(wallet);
  links.hidden = false;
  pageLink.href = `./agent.html?wallet=${encodedWallet}`;
  jsonLink.href = apiUrl(`/agents/${wallet}`);
  if (adminLink) adminLink.href = "#admin-workspace";
}

function syncRoleGatedControls(snapshot = getAuthSnapshot()) {
  const roles = snapshot.roles ?? [];
  state.authRoles = roles;

  const createJobButton = document.querySelector('#poster-form button[type="submit"]');
  const fireJobButton = document.getElementById("admin-fire-button");
  const useSelectedTemplateButton = document.getElementById("admin-use-selected-template-button");
  const verifyButton = document.getElementById("verify-button");
  const posterForm = document.getElementById("poster-form");
  const fireForm = document.getElementById("admin-fire-form");
  const adminLink = document.getElementById("auth-admin-link");

  const adminEnabled = hasRole("admin", roles);
  const verifierEnabled = hasRole("verifier", roles);

  if (posterForm) {
    posterForm.setAttribute("data-admin-enabled", adminEnabled ? "true" : "false");
  }
  if (fireForm) {
    fireForm.setAttribute("data-admin-enabled", adminEnabled ? "true" : "false");
  }
  if (createJobButton) {
    createJobButton.disabled = !adminEnabled;
    createJobButton.title = adminEnabled ? "" : "Sign in with an admin-scoped wallet to create jobs.";
  }
  if (fireJobButton) {
    fireJobButton.disabled = !adminEnabled;
    fireJobButton.title = adminEnabled ? "" : "Sign in with an admin-scoped wallet to fire recurring templates.";
  }
  if (useSelectedTemplateButton) {
    useSelectedTemplateButton.disabled = !adminEnabled;
    useSelectedTemplateButton.title = adminEnabled ? "" : "Admin role required.";
  }
  if (verifyButton && !verifierEnabled) {
    verifyButton.title = "Sign in with a verifier-scoped wallet to run settlement.";
  }

  renderRolePills("auth-role-pills", roles);
  renderRolePills("admin-role-pills", roles);
  setText("auth-role-summary", roleSummary(roles));
  setText("auth-capability-summary", adminEnabled || verifierEnabled
    ? [
        adminEnabled ? "Can create jobs and fire recurring templates" : undefined,
        verifierEnabled ? "Can settle submitted sessions" : undefined
      ].filter(Boolean).join(" · ")
    : "Sign in with an admin or verifier wallet to unlock internal controls.");

  setText("admin-wallet-value", snapshot.wallet ?? "No wallet signed in");
  setText("admin-role-value", roleSummary(roles));
  setText("admin-admin-capability", adminEnabled ? "Unlocked" : "Locked");
  setText("admin-verifier-capability", verifierEnabled ? "Unlocked" : "Locked");
  if (adminLink) {
    adminLink.hidden = !(snapshot.authenticated && (adminEnabled || verifierEnabled));
    adminLink.textContent = adminEnabled ? "Open admin workspace" : "Open control workspace";
  }
  setText(
    "admin-surface-copy",
    !snapshot.authenticated
      ? "Sign in first, then this surface will show whether the current wallet can create jobs, fire recurring templates, and settle verifier runs."
      : adminEnabled || verifierEnabled
        ? "This wallet now exposes the internal control-plane actions it is allowed to perform."
        : "This wallet can still operate worker flows, but it does not currently carry admin or verifier claims."
  );

  const surfacePill = document.getElementById("admin-surface-pill");
  if (surfacePill) {
    if (!snapshot.authenticated) {
      surfacePill.className = "status-pill status-pending";
      surfacePill.textContent = "Awaiting sign-in";
    } else if (adminEnabled || verifierEnabled) {
      surfacePill.className = "status-pill status-ok";
      surfacePill.textContent = "Control plane unlocked";
    } else {
      surfacePill.className = "status-pill status-pending";
      surfacePill.textContent = "Worker-only session";
    }
  }

  refreshAdminConsole(snapshot);
  refreshActionPanel();
  void refreshAdminWorkspace(snapshot);
}

async function refreshAdminWorkspace(snapshot = getAuthSnapshot()) {
  if (!snapshot.authenticated || !hasRole("admin", snapshot.roles ?? [])) {
    renderRecurringStatus(undefined);
    renderMaintenanceStatus(undefined);
    renderOpsDeck(buildLocalOpsSnapshot());
    return;
  }

  try {
    const status = await readJson("/api/admin/status");
    renderRecurringStatus(status.recurring);
    renderMaintenanceStatus(status.maintenance);
    renderOpsDeck(buildAdminOpsSnapshot(status));
  } catch (error) {
    debug.error(error);
    renderHtml(
      document.getElementById("admin-recurring-status"),
      html`<p class="empty-state">Admin status could not be loaded right now. Check the API logs and the signed-in wallet's role claims.</p>`
    );
    renderHtml(
      document.getElementById("admin-maintenance-status"),
      html`<p class="empty-state">Maintenance posture is temporarily unavailable.</p>`
    );
    renderOpsDeck(buildLocalOpsSnapshot());
  }
}

function renderAuthUi(snapshot = getAuthSnapshot()) {
  const panel = document.getElementById("auth-panel");
  const signInBtn = document.getElementById("auth-signin-button");
  const signOutBtn = document.getElementById("auth-signout-button");
  const pill = document.getElementById("auth-session-pill");
  const walletForm = document.getElementById("wallet-form");
  const walletValue = document.getElementById("auth-wallet-value");
  const modeValue = document.getElementById("auth-mode-value");
  const expiryValue = document.getElementById("auth-expiry-value");
  const authHint = document.getElementById("auth-hint");

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
  if (walletValue) {
    walletValue.textContent = snapshot.wallet ?? "No wallet signed in";
  }
  if (modeValue) {
    modeValue.textContent = authMode === "permissive" ? "Permissive dev mode" : "Strict JWT mode";
  }
  if (expiryValue) {
    expiryValue.textContent = snapshot.authenticated ? formatExpiry(snapshot.expiresAt) : "Awaiting SIWE sign-in";
  }
  if (authHint) {
    authHint.textContent = snapshot.authenticated
      ? "This signed-in wallet is now the operator identity for wallet-scoped reads, claims, funding, and the live event stream."
      : authMode === "permissive"
        ? "Browser access and wallet sign-in are separate. In permissive mode, the legacy wallet form remains visible for local development."
        : "Browser access and wallet sign-in are separate. After the page loads, sign in with your wallet before the operator workspace, funding tools, and event stream unlock.";
  }

  syncPublicProfileLinks(snapshot.authenticated ? snapshot.wallet ?? "" : "");
  syncRoleGatedControls(snapshot);

  // The legacy wallet-input form is only useful when the API is in permissive
  // mode — otherwise every request will be rejected until the user signs in.
  if (walletForm) {
    walletForm.hidden = authMode !== "permissive" || snapshot.authenticated;
  }
  renderStartGuide(snapshot);
  renderProductMap(snapshot);
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
    renderStartGuide();
    renderProductMap();
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
  renderStartGuide();
  renderProductMap();
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

  if (state.selectedJobId) {
    const job = await loadJobDefinitionWithPreflight(state.selectedJobId);
    updateSelectedJob(job);
    await Promise.all([loadSelectedJobHistory(), loadSelectedCatalogJobActivity()]);
  }

  if (state.session?.sessionId) {
    await restoreSession(state.session.sessionId);
  } else {
    refreshActionPanel();
    renderStartGuide();
    renderProductMap();
  }
  await refreshOpsDeck();
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
      debug.error(error);
      setWalletFeedback(error.message ?? "Live refresh failed.", "error");
    }
  }, 250);
}

function recordActivity(event) {
  if (!event) return;
  state.activity = [event, ...state.activity].slice(0, 24);
  renderActivityFeed(state.activity);
  void refreshOpsDeck();
}

function restartEventSubscription() {
  stopEventStream?.();
  if (!state.wallet) {
    return;
  }

  stopEventStream = startEventStream({
    wallet: state.wallet,
    onEvent: (event) => {
      recordActivity(event);
      scheduleLiveRefresh(event);
    },
    onGap: (event) => {
      recordActivity(event ?? { topic: "gap", timestamp: new Date().toISOString(), data: {} });
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
  refreshAdminConsole();
  const templateInput = document.getElementById("admin-template-id");
  if (templateInput && job?.recurring && !templateInput.value.trim()) {
    templateInput.value = job.id;
  }

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
  renderStartGuide();
  renderProductMap();
  await Promise.all([loadSelectedJobHistory(), loadSelectedCatalogJobActivity()]);
}

async function loadWallet(wallet) {
  const previousWallet = state.wallet;
  state.wallet = wallet;
  if (previousWallet !== wallet) {
    state.activity = [];
    renderActivityFeed([]);
  }
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
  setWalletFeedback(`Loaded live data for ${wallet}.`, "success");
  setText("funding-wallet-value", wallet);
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
    renderStartGuide();
    renderProductMap();
  }

  restartEventSubscription();
  await refreshOpsDeck();
}

async function fundCurrentWallet() {
  const amountInput = document.getElementById("fund-amount-input");
  const amount = Number(amountInput?.value ?? "0");
  setFundingFeedback(`Funding ${state.wallet} with ${amount} DOT...`, "loading");

  const account = await postJson("/api/account/fund", { asset: "DOT", amount });

  updateAccount(account);
  setFundingFeedback(`Credited and deposited ${amount} DOT into AgentAccountCore.`, "success");
  showToast(`Funded ${amount} DOT.`, "success");
  await refreshWalletPanels();
}

async function loadCatalog() {
  const jobs = await readJson("/api/jobs");
  state.catalog = jobs;
  platformStatus.catalogCount = jobs.length;
  renderCatalog(jobs);
  setText("catalog-count", `${jobs.length} jobs live`);
  if (platformStatus.protocols.length || platformStatus.indexReady) {
    setText(
      "admin-platform-summary",
      `${platformStatus.catalogCount} live jobs · ${platformStatus.protocols.length || 0} protocols · ${platformStatus.indexReady ? "index ready" : "index warning"}`
    );
  }
  if (hasRole("admin")) {
    void refreshAdminWorkspace();
  }
  refreshAdminConsole();
  void refreshOpsDeck();
  renderProductMap();
}

async function claimSelectedJob() {
  if (!state.selectedJobId) return;

  const idempotencyKey = `ui:${state.wallet}:${state.selectedJobId}`;
  setActionFeedback(`Claiming ${state.selectedJobId}...`, "loading");

  const session = await postJson("/api/jobs/claim", {
    jobId: state.selectedJobId,
    idempotencyKey
  });

  applySessionState(session);
  applyVerificationState(undefined);
  setActionFeedback(`Claimed ${state.selectedJobId}. Session ${session.sessionId} is ready for submission.`, "success");
  showToast(`Claimed ${state.selectedJobId}.`, "success");
  refreshActionPanel();
  renderStartGuide();
  renderProductMap();
  await loadHistoryForCurrentWallet();
  await Promise.all([loadSelectedJobHistory(), loadSelectedCatalogJobActivity()]);
}

async function submitSelectedWork() {
  if (!state.session?.sessionId) return;

  const evidenceInput = document.getElementById("evidence-input");
  const evidence = evidenceInput?.value?.trim() || buildEvidenceTemplate(state.selectedJob);

  setActionFeedback(`Submitting work for ${state.session.sessionId}...`, "loading");
  const session = await postJson("/api/jobs/submit", {
    sessionId: state.session.sessionId,
    evidence
  });

  applySessionState(session);
  setActionFeedback("Submission stored. Run the verifier to settle the result.", "success");
  showToast("Submission stored.", "success");
  refreshActionPanel();
  renderStartGuide();
  renderProductMap();
  await loadHistoryForCurrentWallet();
  await Promise.all([loadSelectedJobHistory(), loadSelectedCatalogJobActivity()]);
}

async function verifySelectedWork() {
  if (!state.session?.sessionId) return;
  if (!hasRole("verifier")) {
    throw new Error("This wallet does not have the verifier role required to settle submissions.");
  }

  const evidenceInput = document.getElementById("evidence-input");
  const evidence = evidenceInput?.value?.trim() || buildEvidenceTemplate(state.selectedJob);

  setActionFeedback(`Running verifier for ${state.session.sessionId}...`, "loading");
  const result = await postJson("/api/verifier/run", {
    sessionId: state.session.sessionId,
    evidence
  });

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
  renderStartGuide();
  renderProductMap();
  await loadHistoryForCurrentWallet();
  await Promise.all([loadSelectedJobHistory(), loadSelectedCatalogJobActivity()]);
}

async function refreshCurrentSession() {
  if (!state.session?.sessionId) return;

  setActionFeedback(`Refreshing ${state.session.sessionId}...`, "loading");
  await restoreSession(state.session.sessionId);
  setActionFeedback(`Refreshed session ${state.session.sessionId}.`, "success");
  renderStartGuide();
  renderProductMap();
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

function syncPosterAdvancedFields() {
  const recurringToggle = document.getElementById("poster-recurring-toggle");
  const scheduleInput = document.getElementById("poster-schedule-cron");
  const scheduleHint = document.getElementById("poster-schedule-hint");
  const checked = recurringToggle?.checked ?? false;

  if (scheduleInput) {
    scheduleInput.required = checked;
    scheduleInput.placeholder = checked ? "0 9 * * 1" : "Optional unless recurring is enabled";
  }
  if (scheduleHint) {
    scheduleHint.textContent = checked
      ? "Recurring templates must include a cron schedule. Fire them manually below until the scheduler ships."
      : "Enable recurring only for reusable templates. One-shot jobs can leave the schedule blank.";
  }
}

async function createPosterJob() {
  if (!hasRole("admin")) {
    throw new Error("This wallet does not have the admin role required to create jobs.");
  }

  const form = document.getElementById("poster-form");
  const formData = new FormData(form);
  const category = String(formData.get("category") ?? "").trim().toLowerCase();
  const verifierMode = String(formData.get("verifierMode") ?? "benchmark");
  const outputSchemaRef = String(formData.get("outputSchemaRef") ?? "").trim() || `schema://jobs/${category}-output`;
  const recurring = formData.get("recurring") === "on";
  const scheduleCron = String(formData.get("scheduleCron") ?? "").trim();
  const parentSessionId = String(formData.get("parentSessionId") ?? "").trim();

  if (recurring && !scheduleCron) {
    throw new Error("Recurring templates need a cron schedule.");
  }

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
    autoApprove: formData.get("autoApprove") === "on",
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(recurring ? { recurring: true, schedule: { cron: scheduleCron } } : {})
  };

  setPosterFeedback(`Creating ${payload.id || "job"}...`, "loading");
  const job = await postJson("/api/admin/jobs", payload);
  setPosterFeedback(`Created ${job.id}. Refreshing catalog and operator view...`, "loading");
  await Promise.all([loadCatalog(), loadWallet(state.wallet)]);
  await selectJob(job.id);
  await refreshAdminWorkspace();
  setPosterFeedback(`Created ${job.id} and loaded it into the execution flow.`, "success");
  showToast(`Created ${job.id}.`, "success");
}

async function fireRecurringTemplate() {
  if (!hasRole("admin")) {
    throw new Error("This wallet does not have the admin role required to fire recurring templates.");
  }

  const templateInput = document.getElementById("admin-template-id");
  const firedAtInput = document.getElementById("admin-fired-at");
  const templateId = templateInput?.value?.trim() ?? "";
  const firedAt = firedAtInput?.value?.trim() ?? "";

  if (!templateId) {
    throw new Error("Enter a recurring template id first.");
  }
  if (firedAt && Number.isNaN(new Date(firedAt).getTime())) {
    throw new Error("firedAt must be a valid date and time.");
  }

  setAdminFeedback(`Firing ${templateId}...`, "loading");
  const derivative = await postJson("/api/admin/jobs/fire", {
    templateId,
    ...(firedAt ? { firedAt: new Date(firedAt).toISOString() } : {})
  });

  await Promise.all([loadCatalog(), loadWallet(state.wallet)]);
  await selectJob(derivative.id);
  await refreshAdminWorkspace();
  setAdminFeedback(`Fired ${templateId}. Loaded derivative ${derivative.id}.`, "success");
  showToast(`Fired ${templateId}.`, "success");
}

function useSelectedTemplate() {
  const templateInput = document.getElementById("admin-template-id");
  if (!templateInput) return;
  if (!state.selectedJobId) {
    throw new Error("Load a recurring template from the live catalog first.");
  }
  if (!state.selectedJob?.recurring) {
    throw new Error("The selected job is not marked as a recurring template.");
  }
  templateInput.value = state.selectedJobId;
  setAdminFeedback(`Loaded ${state.selectedJobId} into the recurring fire form.`, "neutral");
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
      debug.error(error);
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
      debug.error(error);
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
      debug.error(error);
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
      debug.error(error);
      setActionFeedback(error.message ?? "Failed to load session history.", "error");
      showToast(error.message ?? "Failed to load session history.", "error");
    }
  });
}

function wireHistoryFilter(historyFilter) {
  historyFilter?.addEventListener("change", () => {
    state.historyFilter = historyFilter.value || "all";
    renderHistory(state.history);
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
      debug.error(error);
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
      debug.error(error);
      setPosterFeedback(error.message ?? "Failed to load poster run.", "error");
      showToast(error.message ?? "Failed to load poster run.", "error");
    }
  });
}

function wireCatalogActivityFilter(filterSelect) {
  filterSelect?.addEventListener("change", () => {
    state.catalogActivityFilter = filterSelect.value || "all";
    renderCatalogJobActivity(state.selectedJob, state.catalogJobActivity);
  });
}

function wireActionButtons({ claimButton, submitButton, verifyButton, refreshButton, fundButton }) {
  claimButton?.addEventListener("click", async () => {
    try {
      await runWithBusyButton(claimButton, "Claiming...", claimSelectedJob);
    } catch (error) {
      debug.error(error);
      setActionFeedback(error.message ?? "Claim failed.", "error");
      showToast(error.message ?? "Claim failed.", "error");
    }
  });

  submitButton?.addEventListener("click", async () => {
    try {
      await runWithBusyButton(submitButton, "Submitting...", submitSelectedWork);
    } catch (error) {
      debug.error(error);
      setActionFeedback(error.message ?? "Submit failed.", "error");
      showToast(error.message ?? "Submit failed.", "error");
    }
  });

  verifyButton?.addEventListener("click", async () => {
    try {
      await runWithBusyButton(verifyButton, "Verifying...", verifySelectedWork);
    } catch (error) {
      debug.error(error);
      setActionFeedback(error.message ?? "Verification failed.", "error");
      showToast(error.message ?? "Verification failed.", "error");
    }
  });

  refreshButton?.addEventListener("click", async () => {
    try {
      await runWithBusyButton(refreshButton, "Refreshing...", refreshCurrentSession);
    } catch (error) {
      debug.error(error);
      setActionFeedback(error.message ?? "Refresh failed.", "error");
      showToast(error.message ?? "Refresh failed.", "error");
    }
  });

  fundButton?.addEventListener("click", async () => {
    try {
      await runWithBusyButton(fundButton, "Funding...", fundCurrentWallet);
    } catch (error) {
      debug.error(error);
      setFundingFeedback(error.message ?? "Funding failed.", "error");
      showToast(error.message ?? "Funding failed.", "error");
    }
  });
}

function wirePosterControls({
  posterForm,
  refreshCatalogButton,
  verifierModeSelect,
  recurringToggle,
  fireForm,
  useSelectedTemplateButton
}) {
  posterForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = posterForm.querySelector('button[type="submit"]');
    try {
      await runWithBusyButton(submitButton, "Creating...", createPosterJob);
    } catch (error) {
      debug.error(error);
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
      debug.error(error);
      setPosterFeedback(error.message ?? "Catalog refresh failed.", "error");
      showToast(error.message ?? "Catalog refresh failed.", "error");
    }
  });

  verifierModeSelect?.addEventListener("change", () => {
    syncPosterDefaults(true);
  });

  recurringToggle?.addEventListener("change", () => {
    syncPosterAdvancedFields();
  });

  useSelectedTemplateButton?.addEventListener("click", () => {
    try {
      useSelectedTemplate();
    } catch (error) {
      debug.error(error);
      setAdminFeedback(error.message ?? "Failed to load selected template.", "error");
      showToast(error.message ?? "Failed to load selected template.", "error");
    }
  });

  fireForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fireButton = document.getElementById("admin-fire-button");
    try {
      await runWithBusyButton(fireButton, "Firing...", fireRecurringTemplate);
    } catch (error) {
      debug.error(error);
      setAdminFeedback(error.message ?? "Recurring fire failed.", "error");
      showToast(error.message ?? "Recurring fire failed.", "error");
    }
  });
}

async function loadPlatformStatus() {
  try {
    const [health, onboarding, index, verifierHandlers, strategyResponse] = await Promise.all([
      readJson("/api/health"),
      readJson("/api/onboarding"),
      readJson("/index/"),
      readJson("/api/verifier/handlers"),
      readJson("/api/strategies")
    ]);

    platformStatus.protocols = onboarding.protocols ?? [];
    platformStatus.verifierModes = Array.isArray(verifierHandlers?.handlers)
      ? verifierHandlers.handlers.map((entry) => entry.mode).filter(Boolean)
      : [];
    platformStatus.strategies = Array.isArray(strategyResponse?.strategies) ? strategyResponse.strategies : [];
    platformStatus.strategyDocs = strategyResponse?.docs ?? "";
    platformStatus.authMode = health?.auth?.mode ?? onboarding?.authMode ?? authMode;
    platformStatus.indexReady = index.status === "ok";
    state.strategies = platformStatus.strategies;
    state.strategyDocs = platformStatus.strategyDocs;

    authMode = platformStatus.authMode;
    setText("api-status", health.status === "ok" ? "Healthy" : "Unexpected");
    setText("index-status", index.status === "ok" ? "Serving" : "Unexpected");
    setText("protocol-status", onboarding.protocols.join(" / ").toUpperCase());
    setText("starter-flow", `${onboarding.onboarding.starterFlow.length} live steps`);
    setText("admin-verifier-modes", platformStatus.verifierModes.length ? platformStatus.verifierModes.join(" · ") : "No handlers exposed");
    setText("admin-platform-summary", `${platformStatus.protocols.length || 0} protocols · ${platformStatus.indexReady ? "index ready" : "index warning"}`);
    setText(
      "admin-auth-mode",
      authMode === "permissive"
        ? "Permissive auth is only appropriate for local development."
        : "Strict auth is live. Admin and verifier actions follow JWT role claims."
    );
    setOverallStatus("Online", "status-ok");
    renderProductMap();
    refreshTreasurySurfaces();
  } catch (error) {
    debug.error(error);
    state.strategies = [];
    state.strategyDocs = "";
    setText("api-status", "Unavailable");
    setText("index-status", "Unavailable");
    setText("protocol-status", "Check routes");
    setText("starter-flow", "Waiting for API");
    setText("admin-verifier-modes", "Unavailable");
    setText("admin-platform-summary", "Check API and indexer");
    setText("admin-auth-mode", "Control-plane status is unavailable until the API responds.");
    setOverallStatus("Attention needed", "status-pending");
    renderProductMap();
    refreshTreasurySurfaces();
  }
}

function wireAuthControls() {
  const signInBtn = document.getElementById("auth-signin-button");
  const signOutBtn = document.getElementById("auth-signout-button");

  signInBtn?.addEventListener("click", async () => {
    setAuthFeedback("Waiting for wallet signature...", "loading");
    try {
      const result = await signIn();
      setAuthFeedback(`Signed in as ${result.wallet}. Loading your operator workspace...`, "success");
      await loadWallet(result.wallet);
      setAuthFeedback(`Signed in as ${result.wallet}. Token expires ${result.expiresAt}.`, "success");
    } catch (error) {
      debug.error(error);
      setAuthFeedback(error.message ?? "Sign in failed.", "error");
      showToast(error.message ?? "Sign in failed.", "error");
    }
  });

  signOutBtn?.addEventListener("click", async () => {
    // `signOut` awaits a best-effort server-side revocation; we fire-and-forget
    // here so the UI still updates immediately. Any failure is caught inside
    // signOut() and the local session is cleared regardless.
    void signOut();
    stopEventStream?.();
    stopEventStream = undefined;
    state.wallet = "";
    state.authRoles = [];
    state.account = undefined;
    state.reputation = undefined;
    state.history = [];
    state.recommendations = [];
    state.session = undefined;
    state.verification = undefined;
    state.activity = [];
    state.jobHistory = [];
    state.catalogJobActivity = [];
    state.strategies = platformStatus.strategies ?? [];
    state.strategyDocs = platformStatus.strategyDocs ?? "";
    setAuthFeedback("Signed out. Sign in again to reopen the operator workspace.", "neutral");
    // Clear the wallet-scoped panels so stale data doesn't linger on screen.
    updateAccount({ wallet: "", liquid: {}, reserved: {}, strategyAllocated: {}, collateralLocked: {}, jobStakeLocked: {}, debtOutstanding: {} });
    updateReputation({ skill: 0, reliability: 0, economic: 0, tier: "starter" });
    updateSelectedJob(undefined);
    applySessionState(undefined);
    applyVerificationState(undefined);
    renderRecommendations([]);
    renderHistory([]);
    renderActivityFeed([]);
    renderJobDetail(undefined, []);
    renderCatalogJobActivity(undefined, []);
    renderOpsDeck(buildLocalOpsSnapshot());
    renderProductMap({ authenticated: false, wallet: undefined, expiresAt: undefined, roles: [], lastReason: "signed_out" });
    refreshTreasurySurfaces();
    setText("job-count", "0 recommendations");
    setText("funding-wallet-value", "No wallet signed in");
    setText("auth-wallet-value", "No wallet signed in");
    setPosterFeedback("Create one-shot or recurring jobs here to publish them directly into the live runtime.", "neutral");
    setAdminFeedback("Only admin-scoped wallets can fire recurring templates. Load one from the catalog or type the template id directly.", "neutral");
    syncRoleGatedControls({ authenticated: false, wallet: undefined, expiresAt: undefined, roles: [], lastReason: "signed_out" });
  });

  onAuthChange((snapshot) => {
    renderAuthUi(snapshot);
  });
}

function wireAdminConsoleControls() {
  document.getElementById("admin-console-create-button")?.addEventListener("click", () => {
    jumpToSection("poster-form", { mode: "admin" });
  });
  document.getElementById("admin-console-fire-button")?.addEventListener("click", () => {
    jumpToSection("admin-fire-zone", { mode: "admin" });
  });
  document.getElementById("admin-console-status-button")?.addEventListener("click", () => {
    jumpToSection("admin-status-details", { mode: "admin", expandId: "admin-status-details" });
  });
  document.getElementById("admin-console-catalog-button")?.addEventListener("click", () => {
    jumpToSection("catalog-workspace", { mode: "admin" });
  });
}

function wireStartGuideControls() {
  document.getElementById("start-human-button")?.addEventListener("click", () => {
    if (!state.wallet) {
      jumpToSection("workspace-core", { mode: "work" });
      return;
    }
    if (!state.selectedJobId) {
      jumpToSection("jobs-workspace", { mode: "work" });
      return;
    }
    if (!state.session?.sessionId) {
      jumpToSection("work-execution", { mode: "work" });
      return;
    }
    jumpToSection("work-execution", { mode: "work" });
  });

  document.getElementById("start-admin-button")?.addEventListener("click", () => {
    if (hasRole("admin") || hasRole("verifier")) {
      jumpToSection("admin-workspace", { mode: "admin" });
      return;
    }
    jumpToSection("ops-details", { mode: "observe" });
  });
}

function wireProductMapControls() {
  document.getElementById("product-lane-work-button")?.addEventListener("click", () => {
    if (!state.wallet) {
      jumpToSection("workspace-core", { mode: "work" });
      return;
    }
    if (!state.selectedJobId) {
      jumpToSection("jobs-workspace", { mode: "work" });
      return;
    }
    jumpToSection("work-execution", { mode: "work" });
  });

  document.getElementById("product-lane-treasury-button")?.addEventListener("click", () => {
    jumpToSection("ops-details", { mode: "observe" });
  });

  document.getElementById("product-lane-control-button")?.addEventListener("click", () => {
    if (hasRole("admin") || hasRole("verifier")) {
      jumpToSection("admin-workspace", { mode: "admin" });
      return;
    }
    jumpToSection("ops-details", { mode: "observe" });
  });
}

function wireObserveQuickNav() {
  document.getElementById("observe-nav-summary")?.addEventListener("click", () => {
    jumpToSection("observe-balance-sheet", { mode: "observe" });
  });
  document.getElementById("observe-nav-strategies")?.addEventListener("click", () => {
    jumpToSection("observe-strategy-lanes", { mode: "observe" });
  });
  document.getElementById("observe-nav-activity")?.addEventListener("click", () => {
    jumpToSection("observe-live-feed", { mode: "observe" });
  });
}

async function boot() {
  // Init Sentry (no-op when sentryDsn is empty; the browser SDK auto-loads).
  initObservability();

  const walletInput = document.getElementById("wallet-input");
  const walletForm = document.getElementById("wallet-form");
  const jobList = document.getElementById("job-list");
  const claimButton = document.getElementById("claim-button");
  const submitButton = document.getElementById("submit-button");
  const verifyButton = document.getElementById("verify-button");
  const refreshButton = document.getElementById("refresh-session-button");
  const fundButton = document.getElementById("fund-account-button");
  const posterForm = document.getElementById("poster-form");
  const refreshCatalogButton = document.getElementById("refresh-catalog-button");
  const recurringToggle = document.getElementById("poster-recurring-toggle");
  const fireForm = document.getElementById("admin-fire-form");
  const useSelectedTemplateButton = document.getElementById("admin-use-selected-template-button");
  const catalogList = document.getElementById("catalog-list");
  const historyList = document.getElementById("history-list");
  const historyFilter = document.getElementById("history-filter");
  const verifierModeSelect = document.getElementById("poster-verifier-mode");
  const catalogActivityFilter = document.getElementById("catalog-activity-filter");

  wireWorkspaceModes();
  syncPosterDefaults(true);
  syncPosterAdvancedFields();
  await loadPlatformStatus();

  // Render initial auth UI *after* we know the auth mode so the permissive
  // fallback form shows up correctly on dev deployments.
  renderAuthUi();

  try {
    await loadCatalog();
  } catch (error) {
    debug.error(error);
    setPosterFeedback(error.message ?? "Failed to load poster workspace.", "error");
    showToast(error.message ?? "Failed to load poster workspace.", "error");
  }

  // Bootstrap wallet loading decision tree:
  //   1. If the user already has a valid JWT → reuse its wallet.
  //   2. Else in permissive mode → fall back to the last-used wallet (or default).
  //   3. Else (strict + no token) → show the sign-in prompt and wait.
  const authenticatedWallet = getAuthWallet();
  const permissiveWallet = authMode === "permissive"
    ? (localStorage.getItem("averray:last-wallet") || "")
    : "";
  const initialWallet = authenticatedWallet ?? (permissiveWallet || undefined);

  if (walletInput && permissiveWallet) walletInput.value = permissiveWallet;

  if (initialWallet) {
    try {
      await loadWallet(initialWallet);
    } catch (error) {
      debug.error(error);
      setWalletFeedback(error.message ?? "Failed to load wallet data.", "error");
      renderRecommendations([]);
    }
  } else {
    setAuthFeedback("Sign in with your wallet to unlock balances, reputation, and the worker action flow.", "neutral");
  }

  wireAuthControls();
  wireStartGuideControls();
  wireProductMapControls();
  wireObserveQuickNav();
  wireAdminConsoleControls();
  wireWalletForm(walletForm, walletInput);
  wireJobSelection(jobList);
  wireCatalogSelection(catalogList);
  wireHistorySelection(historyList);
  wireHistoryFilter(historyFilter);
  wireJobRunSelection();
  wireCatalogActivitySelection();
  wireCatalogActivityFilter(catalogActivityFilter);
  wireActionButtons({ claimButton, submitButton, verifyButton, refreshButton, fundButton });
  wirePosterControls({
    posterForm,
    refreshCatalogButton,
    verifierModeSelect,
    recurringToggle,
    fireForm,
    useSelectedTemplateButton
  });
  renderActivityFeed([]);
  renderOpsDeck(buildLocalOpsSnapshot());
  renderProductMap();
  refreshAdminConsole();
  refreshActionPanel();
}

boot();
