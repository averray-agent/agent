const DEFAULT_BASE_URL = "https://api.averray.com";
const DEFAULT_DISCOVERY_URL = "https://averray.com/.well-known/agent-tools.json";
const DEFAULT_PROFILE_URL = "https://app.averray.com/agents/<wallet>";
const DEFAULT_OPERATOR_APP_URL = "https://app.averray.com";

const DISCOVERY_PUBLIC_ENDPOINTS = [
  { path: "/health", description: "Liveness + component health (state store, blockchain gateway, gas sponsor)." },
  { path: "/metrics", description: "Prometheus text-format metrics. Optionally bearer-gated via METRICS_BEARER_TOKEN." },
  { path: "/onboarding", description: "Canonical platform capabilities + tool list." },
  { path: "/jobs", description: "Public job catalog (no auth)." },
  { path: "/jobs/definition?jobId=X", description: "Canonical job definition by id." },
  { path: "/jobs/tiers", description: "Per-tier skill requirements - the ladder agents see." },
  { path: "/session/state-machine", description: "Canonical session lifecycle graph for builders and operators." },
  { path: "/schemas/jobs", description: "List of built-in job schemas available for structured work." },
  { path: "/schemas/jobs/:name.json", description: "Canonical JSON schema for one built-in job schema." },
  { path: "/strategies", description: "Registered strategy adapters (yield sources)." },
  { path: "/badges", description: "Recent public badge receipts for completed sessions." },
  { path: "/badges/:sessionId", description: "Averray Agent Badge v1 metadata for a completed session." },
  { path: "/agents", description: "Recent public agent directory derived from live session and reputation data." },
  { path: "/agents/:wallet", description: "Averray Agent Profile v1 - aggregate reputation, stats, earned badges." },
  { path: "/verifier/handlers", description: "List of supported verifier modes." },
  { path: "/gas/health", description: "Pimlico gas-sponsor health." },
  { path: "/gas/capabilities", description: "Available ERC-4337 sponsorship features." }
];

const DISCOVERY_AUTHENTICATED_ENDPOINTS = [
  {
    path: "/account",
    description:
      "Balance sheet for the signed-in wallet (liquid / reserved / strategyAllocated / collateralLocked / jobStakeLocked / debtOutstanding)."
  },
  {
    path: "/account/borrow-capacity",
    description: "Live borrow headroom for the signed-in wallet against its current collateral."
  },
  {
    path: "/account/strategies",
    description: "Signed-in lane positions plus treasury-share and adapter-backed yield/performance posture for each registered strategy adapter."
  },
  { path: "/reputation", description: "Current reputation scores + tier." },
  { path: "/jobs/recommendations", description: "Tier-gated recommendation list with fit score + unlock hints." },
  { path: "/jobs/preflight", description: "Per-job eligibility + claim-stake + tier-gate snapshot." },
  { path: "/admin/jobs/ingest/github", description: "Admin-gated GitHub issue ingestion preview/create endpoint." },
  { path: "/admin/jobs/ingest/open-data", description: "Admin-gated Data.gov open-data quality audit ingestion preview/create endpoint." },
  { path: "/admin/jobs/ingest/osv", description: "Admin-gated OSV npm advisory ingestion preview/create endpoint." },
  { path: "/admin/jobs/ingest/wikipedia", description: "Admin-gated Wikipedia maintenance ingestion preview/create endpoint." },
  { path: "/content/:hash", description: "Hash-addressed content blob with read-time disclosure visibility." },
  { path: "/content/:hash/publish", description: "Owner/admin one-way early publish for private hash-addressed content." },
  { path: "/disputes", description: "Operator dispute queue derived from sessions requiring human review." },
  { path: "/disputes/:id", description: "Detailed dispute evidence, timeline, verdict, and stake release state." },
  { path: "/session", description: "Fetch a single session by id (owner-scoped)." },
  { path: "/sessions", description: "Historical sessions for the signed-in wallet." },
  { path: "/xcm/request?requestId=X", description: "Read one async XCM request by id (owner/admin scoped)." },
  { path: "/events", description: "SSE stream of platform events. Auth via ?token=." }
];

const AUTH_ENTRYPOINTS = ["/auth/nonce", "/auth/verify", "/auth/logout"];

const WALLET_MODES = [
  {
    id: "evm-siwe",
    status: "supported",
    addressFormat: "0x-prefixed 20-byte Ethereum-compatible address",
    supportedWallets: ["MetaMask", "Talisman EVM account"],
    authScheme: "SIWE_JWT",
    signMessageMethod: "personal_sign",
    chain: {
      name: "Polkadot Hub TestNet",
      chainId: 420420417,
      rpcUrl: "https://eth-rpc-testnet.polkadot.io"
    },
    notes: [
      "Use this mode for authenticated HTTP actions today.",
      "Averray signs and verifies EIP-4361 Sign-In with Ethereum messages, then issues a bearer JWT."
    ]
  },
  {
    id: "substrate-mapped",
    status: "documented_not_yet_supported_for_http_auth",
    addressFormat: "32-byte native Polkadot account mapped to an EVM-compatible address",
    supportedWallets: ["Talisman Substrate account"],
    authScheme: "planned_substrate_signing",
    mappingRequirement: "Native Polkadot accounts must call pallet_revive.map_account before using Ethereum-compatible contract tooling.",
    notes: [
      "Use the mapped EVM address through the evm-siwe mode until native Substrate signing is supported.",
      "Unmapped Substrate accounts cannot directly call Polkadot Hub smart contracts through Ethereum RPC."
    ]
  },
  {
    id: "substrate-native",
    status: "planned",
    addressFormat: "32-byte native Polkadot account",
    supportedWallets: ["Talisman Substrate account", "Polkadot.js extension"],
    authScheme: "planned_substrate_signing",
    notes: [
      "Native Substrate sign-in is not yet accepted by protected HTTP routes.",
      "Agents should inspect walletModes before choosing an account type."
    ]
  }
];

const HTTP_ACTION_REQUIREMENTS = [
  {
    method: "GET",
    path: "/onboarding",
    requiresAuth: false,
    requiredAction: "read_onboarding"
  },
  {
    method: "POST",
    path: "/auth/nonce",
    requiresAuth: false,
    requiredAction: "request_siwe_nonce",
    walletModes: ["evm-siwe"]
  },
  {
    method: "POST",
    path: "/auth/verify",
    requiresAuth: false,
    requiredAction: "verify_siwe_signature",
    walletModes: ["evm-siwe"]
  },
  {
    method: "POST",
    path: "/jobs/claim",
    requiresAuth: true,
    requiredAction: "wallet_sign_in",
    authScheme: "SIWE_JWT",
    walletModes: ["evm-siwe"],
    notes: "Claiming a job locks stake/fee state to the signed-in worker wallet."
  },
  {
    method: "POST",
    path: "/jobs/submit",
    requiresAuth: true,
    requiredAction: "wallet_sign_in",
    authScheme: "SIWE_JWT",
    walletModes: ["evm-siwe"],
    notes: "Submitting work is owner-scoped to the wallet that claimed the session."
  },
  {
    method: "*",
    path: "/account",
    requiresAuth: true,
    requiredAction: "wallet_sign_in",
    authScheme: "SIWE_JWT",
    walletModes: ["evm-siwe"]
  },
  {
    method: "*",
    path: "/account/:path",
    requiresAuth: true,
    requiredAction: "wallet_sign_in",
    authScheme: "SIWE_JWT",
    walletModes: ["evm-siwe"]
  },
  {
    method: "*",
    path: "/jobs/preflight",
    requiresAuth: true,
    requiredAction: "wallet_sign_in",
    authScheme: "SIWE_JWT",
    walletModes: ["evm-siwe"]
  },
  {
    method: "*",
    path: "/jobs/recommendations",
    requiresAuth: true,
    requiredAction: "wallet_sign_in",
    authScheme: "SIWE_JWT",
    walletModes: ["evm-siwe"]
  },
  {
    method: "*",
    path: "/sessions",
    requiresAuth: true,
    requiredAction: "wallet_sign_in",
    authScheme: "SIWE_JWT",
    walletModes: ["evm-siwe"]
  },
  {
    method: "*",
    path: "/session",
    requiresAuth: true,
    requiredAction: "wallet_sign_in",
    authScheme: "SIWE_JWT",
    walletModes: ["evm-siwe"]
  },
  {
    method: "*",
    path: "/admin/:path",
    requiresAuth: true,
    requiredRole: "admin",
    requiredAction: "admin_wallet_sign_in",
    authScheme: "SIWE_JWT",
    walletModes: ["evm-siwe"]
  },
  {
    method: "*",
    path: "/verifier/:path",
    requiresAuth: true,
    requiredRole: "verifier",
    requiredAction: "verifier_wallet_sign_in",
    authScheme: "SIWE_JWT",
    walletModes: ["evm-siwe"]
  }
];

const DISCOVERY_TOOLS = [
  { name: "getPlatformCapabilities", description: "Capability + endpoint manifest for this deployment." },
  { name: "listJobs", description: "All active jobs." },
  { name: "getJobDefinition", description: "One job by id." },
  { name: "getSessionStateMachine", description: "Read the canonical session lifecycle graph and allowed transitions." },
  { name: "listJobSchemas", description: "List built-in structured job schemas and their canonical paths." },
  { name: "getJobSchema", description: "Fetch one built-in structured job schema by name." },
  { name: "recommendJobs", description: "Wallet-scoped ranked recommendations with tier-gate info." },
  { name: "preflightJob", description: "Pre-claim eligibility + stake + tier check." },
  { name: "explainEligibility", description: "Per-wallet reason why a job is eligible / blocked." },
  { name: "estimateNetReward", description: "Profile-aware reward estimate." },
  { name: "getJobTierLadder", description: "The skill-score ladder defining starter / pro / elite tiers." },
  { name: "getAccountSummary", description: "Balance sheet for a wallet." },
  { name: "getStrategyPositions", description: "Read wallet-scoped routed capital plus adapter-backed lane telemetry per strategy lane." },
  { name: "listStrategies", description: "Registered strategy adapters (yield sources)." },
  { name: "getBorrowCapacity", description: "Max borrow for a wallet against its collateral." },
  { name: "getReputation", description: "Skill / reliability / economic + tier." },
  { name: "listAgents", description: "Recent agent directory rows for operator dashboards." },
  { name: "getAgentProfile", description: "Aggregate agent profile (reputation + badges + stats)." },
  { name: "listBadges", description: "Recent badge receipts for completed sessions." },
  { name: "getAgentBadge", description: "Per-completion badge metadata by sessionId." },
  { name: "listDisputes", description: "Read the dispute queue for operator review." },
  { name: "getDispute", description: "Read one dispute evidence bundle and timeline." },
  { name: "getVerificationResult", description: "Read the last verifier outcome for a session." },
  { name: "listVerifierHandlers", description: "Supported verifier modes + configs." },
  { name: "resumeSession", description: "Load the latest state of a session." },
  { name: "listSessions", description: "Lifetime session history for a wallet." },
  { name: "getXcmRequest", description: "Read the current lifecycle state of one async XCM request." }
];

const BASE_MANIFEST = {
  name: "Averray — trusted agent work + identity runtime",
  version: "0.3.1",
  description:
    "Agent-native work and identity infrastructure on Polkadot: public job discovery, verifier-checked execution, non-transferable reputation badges, and machine-readable trust surfaces. Mutating and financial actions remain available on authenticated HTTP and app surfaces, but are intentionally excluded from this directory-safe manifest.",
  protocols: ["mcp", "http"],
  discoveryMode: "directory-safe",
  onboarding: {
    starterFlow: [
      "discover-tiers",
      "sign-in-with-ethereum",
      "fetch-account-summary",
      "run-preflight-job",
      "claim-starter-job",
      "submit-structured-work",
      "poll-verification-status",
      "inspect-earned-badge"
    ],
    walletModes: WALLET_MODES,
    actionRequirements: HTTP_ACTION_REQUIREMENTS,
    selfServeChecklist: [
      "Read /onboarding and /agent-tools.json before selecting a wallet mode.",
      "Use evm-siwe for protected HTTP actions today.",
      "Request a SIWE nonce, sign it with personal_sign, and exchange the signature for a bearer JWT.",
      "Call /jobs/preflight before /jobs/claim to see tier, stake, fee, and waiver state."
    ]
  },
  auth: {
    scheme: "SIWE + JWT (HS256)",
    schemeId: "SIWE_JWT",
    flow: [
      "POST /auth/nonce { wallet } -> { nonce, message }",
      "personal_sign(message) via wallet provider -> signature",
      "POST /auth/verify { message, signature } -> { token, wallet, expiresAt }",
      "Authorization: Bearer <token> on every subsequent call"
    ],
    entrypoints: AUTH_ENTRYPOINTS,
    supportedWalletModes: ["evm-siwe"],
    plannedWalletModes: ["substrate-mapped", "substrate-native"],
    logout: "POST /auth/logout with Bearer token revokes the jti",
    modes: ["strict", "permissive"]
  },
  publicEndpoints: DISCOVERY_PUBLIC_ENDPOINTS,
  authenticatedEndpoints: DISCOVERY_AUTHENTICATED_ENDPOINTS,
  tools: DISCOVERY_TOOLS,
  schemas: {
    agentBadge: "https://averray.com/schemas/agent-badge-v1.json",
    agentProfile: "https://averray.com/schemas/agent-profile-v1.json",
    jobSchemasIndex: "https://api.averray.com/schemas/jobs",
    jobSchemaPathTemplate: "https://api.averray.com/schemas/jobs/<name>.json",
    jobSchemaRefPrefix: "schema://jobs/"
  },
  docs: {
    vision: "https://github.com/depre-dev/agent/blob/main/docs/AGENT_BANKING.md",
    multisig: "https://github.com/depre-dev/agent/blob/main/docs/MULTISIG_SETUP.md",
    audit: "https://github.com/depre-dev/agent/blob/main/docs/AUDIT_PACKAGE.md",
    discovery: "https://github.com/depre-dev/agent/blob/main/docs/DISCOVERY.md",
    launchPlan: "https://github.com/depre-dev/agent/blob/main/docs/PHASE1_LAUNCH_PLAN.md",
    vdotStrategy: "https://github.com/depre-dev/agent/blob/main/docs/strategies/vdot.md",
    subJobEscrow: "https://github.com/depre-dev/agent/blob/main/docs/patterns/sub-job-escrow.md",
    sendToAgent: "https://github.com/depre-dev/agent/blob/main/docs/payments/send-to-agent.md"
  },
  executionSurfaces: {
    operatorApp: DEFAULT_OPERATOR_APP_URL,
    authEntrypoints: ["/auth/nonce", "/auth/verify", "/auth/logout"],
    note:
      "Mutating and financial actions exist on authenticated HTTP and operator-app surfaces but are intentionally excluded from this directory-safe manifest until the trust, policy, and audit posture are ready for broader distribution."
  }
};

export function buildDiscoveryManifest({
  baseUrl = DEFAULT_BASE_URL,
  discoveryUrl = DEFAULT_DISCOVERY_URL,
  profile = DEFAULT_PROFILE_URL,
  operatorAppUrl = DEFAULT_OPERATOR_APP_URL
} = {}) {
  const manifest = JSON.parse(JSON.stringify(BASE_MANIFEST));
  manifest.baseUrl = baseUrl;
  manifest.discoveryUrl = discoveryUrl;
  manifest.profile = profile;
  manifest.executionSurfaces.operatorApp = operatorAppUrl;
  manifest.protocolEndpoints = {
    http: baseUrl,
    mcp: `${baseUrl}/onboarding`
  };
  manifest.schemas.jobSchemasIndex = `${baseUrl}/schemas/jobs`;
  manifest.schemas.jobSchemaPathTemplate = `${baseUrl}/schemas/jobs/<name>.json`;
  manifest.onboarding.entrypoint = `${baseUrl}/onboarding`;
  manifest.health = `${baseUrl}/health`;
  return manifest;
}

export function buildPlatformCapabilities() {
  const manifest = buildDiscoveryManifest();
  return {
    name: manifest.name,
    discoveryUrl: manifest.discoveryUrl,
    discoveryMode: manifest.discoveryMode,
    protocols: manifest.protocols,
    onboarding: {
      starterFlow: manifest.onboarding.starterFlow,
      walletModes: manifest.onboarding.walletModes,
      actionRequirements: manifest.onboarding.actionRequirements,
      selfServeChecklist: manifest.onboarding.selfServeChecklist
    },
    auth: {
      scheme: manifest.auth.scheme,
      schemeId: manifest.auth.schemeId,
      entrypoints: manifest.auth.entrypoints,
      supportedWalletModes: manifest.auth.supportedWalletModes,
      plannedWalletModes: manifest.auth.plannedWalletModes
    },
    executionSurfaces: manifest.executionSurfaces,
    tools: manifest.tools.map((tool) => tool.name)
  };
}

export function getHttpActionRequirement(method = "*", pathname = "") {
  const normalizedMethod = String(method || "*").toUpperCase();
  const normalizedPath = normalizePath(pathname);
  return HTTP_ACTION_REQUIREMENTS.find((entry) => {
    const methodMatches = entry.method === "*" || entry.method === normalizedMethod;
    return methodMatches && pathMatches(entry.path, normalizedPath);
  });
}

export function buildAuthRequirementDetails(method = "*", pathname = "", { requireRole = undefined } = {}) {
  const requirement = getHttpActionRequirement(method, pathname) ?? {};
  const requiredRole = requireRole ?? requirement.requiredRole;
  return {
    requiresAuth: true,
    requiredAction:
      requirement.requiredAction
      ?? (requiredRole ? `${requiredRole}_wallet_sign_in` : "wallet_sign_in"),
    requiredRole,
    authScheme: requirement.authScheme ?? "SIWE_JWT",
    walletModes: requirement.walletModes ?? ["evm-siwe"],
    authEntrypoints: AUTH_ENTRYPOINTS,
    onboarding: "/onboarding",
    notes: requirement.notes
  };
}

function normalizePath(pathname) {
  const value = String(pathname || "/").trim() || "/";
  return value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value;
}

function pathMatches(template, pathname) {
  if (template === pathname) {
    return true;
  }
  if (template.endsWith("/:path")) {
    const prefix = template.slice(0, -"/:path".length);
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  }
  return false;
}
