export const AUTH_POLICY_VERSION = "auth-policy-v1";

const BASE_CAPABILITIES = [
  "account:read",
  "account:fund",
  "account:allocate",
  "account:deallocate",
  "account:borrow",
  "account:repay",
  "agents:list",
  "badges:list",
  "content:read",
  "content:write",
  "disputes:list",
  "disputes:read",
  "events:read",
  "jobs:list",
  "jobs:claim",
  "jobs:preflight",
  "jobs:recommend",
  "jobs:submit",
  "payments:send",
  "reputation:read",
  "session:read",
  "session:timeline",
  "strategies:list",
  "subjobs:read",
  "subjobs:create",
  "xcm:read"
];

const ROLE_CAPABILITIES = {
  admin: [
    "admin:status",
    "disputes:release",
    "jobs:ingest",
    "jobs:create",
    "jobs:fire-recurring",
    "jobs:lifecycle",
    "jobs:pause-recurring",
    "jobs:resume-recurring",
    "jobs:timeline",
    "ops:view",
    "policies:propose",
    "xcm:observe",
    "xcm:finalize"
  ],
  verifier: [
    "disputes:verdict",
    "verifier:handlers:read",
    "verifier:result:read",
    "verifier:replay",
    "verifier:run"
  ]
};

const ROUTE_CAPABILITY_RULES = [
  { method: "GET", path: "/account", capabilities: ["account:read"] },
  { method: "GET", path: "/account/strategies", capabilities: ["account:read", "strategies:list"] },
  { method: "GET", path: "/account/borrow-capacity", capabilities: ["account:read"] },
  { method: "POST", path: "/account/fund", capabilities: ["account:fund"] },
  { method: "POST", path: "/account/allocate", capabilities: ["account:allocate"] },
  { method: "POST", path: "/account/deallocate", capabilities: ["account:deallocate"] },
  { method: "POST", path: "/account/borrow", capabilities: ["account:borrow"] },
  { method: "POST", path: "/account/repay", capabilities: ["account:repay"] },
  { method: "GET", path: "/alerts", capabilities: ["ops:view"] },
  { method: "GET", path: "/audit", capabilities: ["ops:view"] },
  { method: "GET", path: "/policies", capabilities: ["ops:view"] },
  { method: "POST", path: "/policies", capabilities: ["policies:propose"] },
  { method: "GET", path: "/disputes", capabilities: ["disputes:list"] },
  { method: "GET", path: "/disputes/:id", capabilities: ["disputes:read"] },
  { method: "POST", path: "/disputes/:id/verdict", capabilities: ["disputes:verdict"] },
  { method: "POST", path: "/disputes/:id/release", capabilities: ["disputes:release"] },
  { method: "GET", path: "/jobs/recommendations", capabilities: ["jobs:recommend"] },
  { method: "GET", path: "/jobs/preflight", capabilities: ["jobs:preflight"] },
  { method: "POST", path: "/jobs/claim", capabilities: ["jobs:claim"] },
  { method: "POST", path: "/jobs/submit", capabilities: ["jobs:submit"] },
  { method: "GET", path: "/jobs/sub", capabilities: ["subjobs:read"] },
  { method: "POST", path: "/jobs/sub", capabilities: ["subjobs:create"] },
  { method: "GET", path: "/session", capabilities: ["session:read"] },
  { method: "GET", path: "/session/timeline", capabilities: ["session:timeline"] },
  { method: "GET", path: "/sessions", capabilities: ["session:read"] },
  { method: "GET", path: "/events", capabilities: ["events:read"] },
  { method: "GET", path: "/xcm/request", capabilities: ["xcm:read"] },
  { method: "POST", path: "/payments/send", capabilities: ["payments:send"] },
  { method: "GET", path: "/reputation", capabilities: ["reputation:read"] },
  { method: "GET", path: "/admin/jobs", capabilities: ["ops:view"] },
  { method: "POST", path: "/admin/jobs", capabilities: ["jobs:create"] },
  { method: "POST", path: "/admin/jobs/ingest/:provider", capabilities: ["jobs:ingest"] },
  { method: "POST", path: "/admin/jobs/fire", capabilities: ["jobs:fire-recurring"] },
  { method: "POST", path: "/admin/jobs/lifecycle", capabilities: ["jobs:lifecycle"] },
  { method: "POST", path: "/admin/jobs/pause", capabilities: ["jobs:pause-recurring"] },
  { method: "POST", path: "/admin/jobs/resume", capabilities: ["jobs:resume-recurring"] },
  { method: "GET", path: "/admin/jobs/timeline", capabilities: ["jobs:timeline"] },
  { method: "GET", path: "/admin/sessions", capabilities: ["ops:view"] },
  { method: "GET", path: "/admin/status", capabilities: ["admin:status", "ops:view"] },
  { method: "POST", path: "/admin/xcm/observe", capabilities: ["xcm:observe"] },
  { method: "POST", path: "/admin/xcm/finalize", capabilities: ["xcm:finalize"] },
  { method: "POST", path: "/verifier/replay", capabilities: ["verifier:replay"] },
  { method: "POST", path: "/verifier/run", capabilities: ["verifier:run"] }
];

const UI_CONTROLS = {
  "admin.jobs.create": ["jobs:create"],
  "admin.jobs.ingest": ["jobs:ingest"],
  "admin.jobs.fireRecurring": ["jobs:fire-recurring"],
  "admin.jobs.lifecycle": ["jobs:lifecycle"],
  "admin.jobs.pauseRecurring": ["jobs:pause-recurring"],
  "admin.jobs.resumeRecurring": ["jobs:resume-recurring"],
  "admin.jobs.timeline": ["jobs:timeline"],
  "admin.sessions.view": ["ops:view"],
  "admin.status.view": ["admin:status", "ops:view"],
  "policies.propose": ["policies:propose"],
  "verifier.run": ["verifier:run"],
  "xcm.observe": ["xcm:observe"],
  "xcm.finalize": ["xcm:finalize"]
};

const AUTOMATION_ACTIONS = {
  "job.create": ["jobs:create"],
  "job.ingest": ["jobs:ingest"],
  "job.fireRecurring": ["jobs:fire-recurring"],
  "job.lifecycle": ["jobs:lifecycle"],
  "job.pauseRecurring": ["jobs:pause-recurring"],
  "job.resumeRecurring": ["jobs:resume-recurring"],
  "job.timeline": ["jobs:timeline"],
  "policy.propose": ["policies:propose"],
  "verifier.run": ["verifier:run"],
  "xcm.observe": ["xcm:observe"],
  "xcm.finalize": ["xcm:finalize"]
};

export function resolveCapabilities(claims = {}) {
  const capabilities = new Set(BASE_CAPABILITIES);
  const roles = Array.isArray(claims.roles) ? claims.roles : [];
  for (const role of roles) {
    for (const capability of ROLE_CAPABILITIES[role] ?? []) {
      capabilities.add(capability);
    }
  }
  const explicitCapabilities = [
    ...(Array.isArray(claims.capabilities) ? claims.capabilities : []),
    ...(Array.isArray(claims.scopes) ? claims.scopes : [])
  ];
  for (const capability of explicitCapabilities) {
    if (typeof capability === "string" && capability.trim()) {
      capabilities.add(capability.trim());
    }
  }
  return [...capabilities].sort();
}

export function capabilityMatrix() {
  const routes = {};
  for (const rule of ROUTE_CAPABILITY_RULES) {
    routes[rule.path] = [...new Set([...(routes[rule.path] ?? []), ...rule.capabilities])].sort();
  }
  return {
    version: AUTH_POLICY_VERSION,
    base: [...BASE_CAPABILITIES],
    roles: Object.fromEntries(
      Object.entries(ROLE_CAPABILITIES).map(([role, capabilities]) => [role, [...capabilities]])
    ),
    routes,
    routeRules: ROUTE_CAPABILITY_RULES.map((rule) => ({ ...rule, capabilities: [...rule.capabilities] })),
    uiControls: cloneCapabilityRecord(UI_CONTROLS),
    automationActions: cloneCapabilityRecord(AUTOMATION_ACTIONS)
  };
}

export function getRouteCapabilityRequirements(method = "*", pathname = "") {
  const normalizedMethod = String(method || "*").toUpperCase();
  const normalizedPath = normalizePath(pathname);
  const rule = ROUTE_CAPABILITY_RULES.find((entry) => {
    const methodMatches = entry.method === "*" || entry.method === normalizedMethod;
    return methodMatches && pathMatches(entry.path, normalizedPath);
  });
  return rule ? [...rule.capabilities] : [];
}

export function hasCapability(claimsOrCapabilities = {}, capability) {
  const capabilities = Array.isArray(claimsOrCapabilities)
    ? claimsOrCapabilities
    : resolveCapabilities(claimsOrCapabilities);
  return capabilities.includes(capability);
}

export function missingCapabilities(claimsOrCapabilities = {}, requiredCapabilities = []) {
  const capabilities = Array.isArray(claimsOrCapabilities)
    ? claimsOrCapabilities
    : resolveCapabilities(claimsOrCapabilities);
  const capabilitySet = new Set(capabilities);
  return normalizeCapabilityList(requiredCapabilities).filter((capability) => !capabilitySet.has(capability));
}

function normalizeCapabilityList(values = []) {
  const raw = Array.isArray(values) ? values : [values];
  return [...new Set(raw.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
}

function cloneCapabilityRecord(record) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, [...value]])
  );
}

function normalizePath(pathname) {
  const value = String(pathname || "/").trim() || "/";
  return value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value;
}

function pathMatches(template, pathname) {
  const normalizedTemplate = normalizePath(template);
  if (normalizedTemplate === pathname) {
    return true;
  }
  const templateParts = normalizedTemplate.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  for (let index = 0; index < templateParts.length; index += 1) {
    const templatePart = templateParts[index];
    if (templatePart === ":path") {
      return pathParts.length >= index;
    }
    if (pathParts[index] === undefined) {
      return false;
    }
    if (templatePart.startsWith(":")) {
      continue;
    }
    if (templatePart !== pathParts[index]) {
      return false;
    }
  }
  return templateParts.length === pathParts.length;
}
