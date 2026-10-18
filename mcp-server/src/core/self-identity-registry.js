import { randomUUID } from "node:crypto";

import { isHostedCanaryClaimant } from "./claimant-attribution.js";
import { ConflictError, ValidationError } from "./errors.js";

const WALLET_RE = /^0x[0-9a-f]{40}$/u;
const SELF_CLIENT_PREFIX = "averray-";
const AMBIGUOUS_CLIENT_DEFAULTS = Object.freeze(["anthropic/claudeai"]);
// An API-key id names a credential we issued. It is not the secret. A value
// that looks like key material is refused rather than stored.
const API_KEY_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/u;

export const SELF_IDENTITY_KINDS = Object.freeze({
  CANARY: "canary",
  ACCEPTANCE: "acceptance",
  OPERATOR: "operator",
  QA_ENGINEER: "qa_engineer",
  BLIND_USER: "blind_user",
  OPERATOR_SCRIPT: "operator_script",
  ADMIN_CONSOLE: "admin_console",
  VERIFIER: "verifier",
  VIEWER: "operator_viewer",
  CLIENT: "operator_client",
  AMBIGUOUS_CLIENT: "shared_client_name",
  EXTERNAL: "external"
});

export const SELF_IDENTITY_AUTHORITY = "shared_self_identity_registry";
export const PUBLIC_IDENTITY_CLASSES = Object.freeze({
  OPERATOR_RUN: "operator-run",
  EXTERNAL: "external",
  UNKNOWN: "unknown"
});

export const ADMIN_OURS_SCOPE = "self-identity-admin-ours";
export const ADMIN_OURS_LABELS = Object.freeze({
  canary: SELF_IDENTITY_KINDS.CANARY,
  acceptance: SELF_IDENTITY_KINDS.ACCEPTANCE,
  "qa-engineer": SELF_IDENTITY_KINDS.QA_ENGINEER,
  "blind-user": SELF_IDENTITY_KINDS.BLIND_USER,
  dogfood: SELF_IDENTITY_KINDS.OPERATOR
});
const CANARY_JOB_ID = /^worker-canary-[a-z0-9-]{1,80}$/iu;

/**
 * One truth source for deciding whether a wallet/client is Averray-operated.
 *
 * The registry deliberately answers only the attribution question. It never
 * joins wallets to IPs and it never guesses from a job name. Per-run canaries
 * qualify only through the wallet-bound marker evidence persisted on their
 * session; every unmarked identity remains external.
 */
export class SelfIdentityRegistry {
  constructor({
    operatorWallets = [],
    acceptanceWallets = [],
    qaEngineerWallets = [],
    blindUserWallets = [],
    canaryWallets = [],
    operatorScriptWallets = [],
    qaEngineerApiKeyIds = [],
    blindUserApiKeyIds = [],
    canaryApiKeyIds = [],
    operatorScriptApiKeyIds = [],
    adminWallets = [],
    verifierWallets = [],
    viewerWallets = [],
    selfClients = [],
    ambiguousClients = AMBIGUOUS_CLIENT_DEFAULTS
  } = {}) {
    this.operatorWallets = walletSet(operatorWallets);
    this.acceptanceWallets = walletSet(acceptanceWallets);
    this.qaEngineerWallets = walletSet(qaEngineerWallets);
    this.blindUserWallets = walletSet(blindUserWallets);
    this.canaryWallets = walletSet(canaryWallets);
    this.operatorScriptWallets = walletSet(operatorScriptWallets);
    this.qaEngineerApiKeyIds = apiKeyIdSet(qaEngineerApiKeyIds);
    this.blindUserApiKeyIds = apiKeyIdSet(blindUserApiKeyIds);
    this.canaryApiKeyIds = apiKeyIdSet(canaryApiKeyIds);
    this.operatorScriptApiKeyIds = apiKeyIdSet(operatorScriptApiKeyIds);
    this.adminWallets = walletSet(adminWallets);
    this.verifierWallets = walletSet(verifierWallets);
    this.viewerWallets = walletSet(viewerWallets);
    this.selfClients = clientSet(selfClients);
    this.ambiguousClients = clientSet(ambiguousClients);
    this.adminOurs = new Map();
  }

  classify({ wallet, clientInfo, session, canaryMarkerValid, apiKeyId } = {}) {
    const normalizedWallet = normalizeWallet(wallet ?? session?.wallet);
    const clientName = normalizeClientName(clientInfo?.name ?? clientInfo);

    if (canaryMarkerValid === true || isHostedCanaryClaimant(session)) {
      return selfIdentity(SELF_IDENTITY_KINDS.CANARY, "wallet_bound_canary_marker");
    }
    if (isCanaryTaggedJob(sessionJob(session))) {
      return selfIdentity(SELF_IDENTITY_KINDS.CANARY, "canary_job_tag");
    }
    // A presented-but-invalid marker is positive evidence of nothing. Keep the
    // old fail-safe direction: it cannot borrow another static classification.
    if (canaryMarkerValid === false) return externalIdentity("invalid_canary_marker");

    // A verified API-key id is operator tooling even when the wallet it rides
    // on is not itself listed. Unknown ids fall through; they never become self.
    const keyIdentity = this.classifyApiKeyId(apiKeyId);
    if (keyIdentity) return keyIdentity;

    if (normalizedWallet) {
      if (this.acceptanceWallets.has(normalizedWallet)) {
        return selfIdentity(SELF_IDENTITY_KINDS.ACCEPTANCE, "acceptance_wallet_registry");
      }
      if (this.operatorWallets.has(normalizedWallet)) {
        return selfIdentity(SELF_IDENTITY_KINDS.OPERATOR, "operator_wallet_registry");
      }
      if (this.qaEngineerWallets.has(normalizedWallet)) {
        return selfIdentity(SELF_IDENTITY_KINDS.QA_ENGINEER, "qa_engineer_wallet_registry");
      }
      if (this.blindUserWallets.has(normalizedWallet)) {
        return selfIdentity(SELF_IDENTITY_KINDS.BLIND_USER, "blind_user_wallet_registry");
      }
      if (this.canaryWallets.has(normalizedWallet)) {
        return selfIdentity(SELF_IDENTITY_KINDS.CANARY, "canary_wallet_registry");
      }
      if (this.operatorScriptWallets.has(normalizedWallet)) {
        return selfIdentity(SELF_IDENTITY_KINDS.OPERATOR_SCRIPT, "operator_script_wallet_registry");
      }
      if (this.adminWallets.has(normalizedWallet)) {
        return selfIdentity(SELF_IDENTITY_KINDS.ADMIN_CONSOLE, "auth_admin_wallet_registry");
      }
      if (this.verifierWallets.has(normalizedWallet)) {
        return selfIdentity(SELF_IDENTITY_KINDS.VERIFIER, "auth_verifier_wallet_registry");
      }
      if (this.viewerWallets.has(normalizedWallet)) {
        return selfIdentity(SELF_IDENTITY_KINDS.VIEWER, "operator_viewer_wallet_registry");
      }
      const adminOurs = this.adminOurs.get(normalizedWallet);
      if (adminOurs) return selfIdentity(adminOurs.kind, "admin_ours_registry");
      return externalIdentity("unlisted_wallet");
    }

    if (!clientName) return externalIdentity("unidentified_caller");
    if (clientName.startsWith(SELF_CLIENT_PREFIX) || this.selfClients.has(clientName)) {
      return selfIdentity(SELF_IDENTITY_KINDS.CLIENT, "operator_client_registry");
    }
    if (this.ambiguousClients.has(clientName)) {
      return {
        actor: "ambiguous",
        self: false,
        ambiguous: true,
        kind: SELF_IDENTITY_KINDS.AMBIGUOUS_CLIENT,
        evidence: "shared_client_name_registry"
      };
    }
    return externalIdentity("unlisted_client");
  }

  isSelf(input) {
    return this.classify(input).self;
  }

  /**
   * Classify a wallet across its durable sessions. A wallet-bound self marker
   * on any session is stronger than the static wallet-only classification;
   * this is how ephemeral canaries remain operator-run after their key is
   * discarded without teaching downstream consumers a job-name heuristic.
   */
  classifySessions({ wallet, sessions = [] } = {}) {
    let identity = this.classify({ wallet });
    for (const session of Array.isArray(sessions) ? sessions : []) {
      const classified = this.classify({ wallet, session });
      if (classified.actor === "self") return classified;
      if (classified.actor === "ambiguous") identity = classified;
    }
    return identity;
  }

  replaceSelfClients(values) {
    this.selfClients = clientSet(values);
  }

  replaceOperatorWallets(values) {
    this.operatorWallets = walletSet(values);
  }

  replaceAmbiguousClients(values) {
    this.ambiguousClients = clientSet(values);
  }

  replaceAdminOurs(entries) {
    const next = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const wallet = normalizeWallet(entry?.wallet);
      const kind = ADMIN_OURS_LABELS[entry?.label];
      if (!wallet || !kind) continue;
      next.set(wallet, { kind, label: entry.label });
    }
    this.adminOurs = next;
  }

  async hydrateAdminOurs(stateStore) {
    if (typeof stateStore?.getServiceState !== "function") {
      this.replaceAdminOurs([]);
      return this;
    }
    try {
      const stored = await stateStore.getServiceState(ADMIN_OURS_SCOPE);
      this.replaceAdminOurs(Array.isArray(stored?.wallets) ? stored.wallets : []);
    } catch {
      // An unread store is not evidence that the list is empty.
    }
    return this;
  }

  classifyApiKeyId(apiKeyId) {
    const id = normalizeApiKeyId(apiKeyId);
    if (!id) return undefined;
    const lists = [
      [this.qaEngineerApiKeyIds, SELF_IDENTITY_KINDS.QA_ENGINEER, "qa_engineer_api_key_registry"],
      [this.blindUserApiKeyIds, SELF_IDENTITY_KINDS.BLIND_USER, "blind_user_api_key_registry"],
      [this.canaryApiKeyIds, SELF_IDENTITY_KINDS.CANARY, "canary_api_key_registry"],
      [this.operatorScriptApiKeyIds, SELF_IDENTITY_KINDS.OPERATOR_SCRIPT, "operator_script_api_key_registry"]
    ];
    for (const [ids, kind, evidence] of lists) {
      if (ids.has(id)) return selfIdentity(kind, evidence);
    }
    return undefined;
  }
}

export function createSelfIdentityRegistry({ env = process.env, authConfig } = {}) {
  return new SelfIdentityRegistry({
    operatorWallets: parseWalletList(env?.ARRIVAL_SELF_WALLETS),
    acceptanceWallets: parseWalletList(env?.ARRIVAL_ACCEPTANCE_WALLETS),
    qaEngineerWallets: parseWalletList(env?.ARRIVAL_QA_ENGINEER_WALLETS),
    blindUserWallets: parseWalletList(env?.ARRIVAL_BLIND_USER_WALLETS),
    canaryWallets: parseWalletList(env?.ARRIVAL_CANARY_WALLETS),
    operatorScriptWallets: parseWalletList(env?.ARRIVAL_OPERATOR_SCRIPT_WALLETS),
    qaEngineerApiKeyIds: parseApiKeyIdList(env?.ARRIVAL_QA_ENGINEER_API_KEY_IDS),
    blindUserApiKeyIds: parseApiKeyIdList(env?.ARRIVAL_BLIND_USER_API_KEY_IDS),
    canaryApiKeyIds: parseApiKeyIdList(env?.ARRIVAL_CANARY_API_KEY_IDS),
    operatorScriptApiKeyIds: parseApiKeyIdList(env?.ARRIVAL_OPERATOR_SCRIPT_API_KEY_IDS),
    adminWallets: authConfig?.adminWallets ?? parseWalletList(env?.AUTH_ADMIN_WALLETS),
    verifierWallets: authConfig?.verifierWallets ?? parseWalletList(env?.AUTH_VERIFIER_WALLETS),
    viewerWallets: authConfig?.viewerWallets ?? parseWalletList(env?.OPERATOR_VIEWER_WALLETS),
    selfClients: parseClientNames(env?.ARRIVAL_SELF_CLIENTS),
    ambiguousClients: [
      ...AMBIGUOUS_CLIENT_DEFAULTS,
      ...parseClientNames(env?.ARRIVAL_AMBIGUOUS_CLIENTS)
    ]
  });
}

export function resolveSelfClients(env = process.env) {
  return clientSet(parseClientNames(env?.ARRIVAL_SELF_CLIENTS));
}

export function resolveSelfWallets(env = process.env) {
  return walletSet(parseWalletList(env?.ARRIVAL_SELF_WALLETS));
}

export function resolveAmbiguousClients(env = process.env) {
  return clientSet([
    ...AMBIGUOUS_CLIENT_DEFAULTS,
    ...parseClientNames(env?.ARRIVAL_AMBIGUOUS_CLIENTS)
  ]);
}

export function normalizeSelfIdentityWallet(value) {
  return normalizeWallet(value);
}

/**
 * Keep an API-key identifier. Refuse anything that looks like the secret itself:
 * pure hex long enough to be key material, or a dotted token (a JWT).
 */
export function normalizeApiKeyId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!API_KEY_ID_RE.test(id)) return undefined;
  if (id.startsWith("sk-") || id.startsWith("rk-") || id.startsWith("bearer")) return undefined;
  if (id.length >= 32 && /^[0-9a-f]+$/u.test(id)) return undefined;
  if (id.split(".").length >= 3) return undefined;
  return id;
}

/** Stable public projection used by receipts, profiles, and operator views. */
export function describeSelfIdentity(identity) {
  const classification = identity?.actor === "self"
    ? PUBLIC_IDENTITY_CLASSES.OPERATOR_RUN
    : identity?.actor === "external"
      ? PUBLIC_IDENTITY_CLASSES.EXTERNAL
      : PUBLIC_IDENTITY_CLASSES.UNKNOWN;
  return {
    classification,
    kind: identity?.kind ?? "unknown",
    authority: SELF_IDENTITY_AUTHORITY,
    evidence: identity?.evidence ?? "identity_unavailable"
  };
}

export function isCanaryTaggedJob(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return false;
  if (job.disposableProof === true) return true;
  return typeof job.id === "string" && CANARY_JOB_ID.test(job.id);
}

function sessionJob(session) {
  const snapshot = session?.jobSnapshot?.definition ?? session?.job;
  return snapshot && typeof snapshot === "object" ? snapshot : null;
}

const PURPOSE_RE = /^[a-z0-9][a-z0-9 _./-]{0,80}$/iu;

export async function editAdminOurs(stateStore, {
  action,
  wallet,
  label,
  purpose,
  addedBy,
  reason,
  now = new Date(),
  logger
} = {}) {
  if (action !== "add" && action !== "remove") {
    throw new ValidationError("Action must be add or remove.");
  }
  const normalized = normalizeWallet(wallet);
  if (!normalized) throw new ValidationError("A wallet address is required.");
  if (action === "add" && !ADMIN_OURS_LABELS[label]) {
    throw new ValidationError("Label must be canary, acceptance, qa-engineer, blind-user, or dogfood.");
  }
  if (action === "add" && !PURPOSE_RE.test(String(purpose ?? ""))) {
    throw new ValidationError("Purpose must be a short label.");
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new ValidationError("A reason is required.");
  }
  const owner = randomUUID();
  const acquired = await stateStore.acquireClaimLock?.(ADMIN_OURS_SCOPE, owner, 30);
  if (acquired === false) {
    throw new ConflictError("Another edit of the ours list is in progress.", "self_identity_ours_in_progress");
  }
  try {
    const stored = await stateStore.getServiceState?.(ADMIN_OURS_SCOPE);
    const wallets = Array.isArray(stored?.wallets) ? stored.wallets.filter((entry) => normalizeWallet(entry?.wallet)) : [];
    const without = wallets.filter((entry) => normalizeWallet(entry.wallet) !== normalized);
    const next = action === "remove" ? without : [...without, {
      wallet: normalized,
      label,
      purpose: String(purpose).trim(),
      addedBy: normalizeWallet(addedBy) ?? null,
      addedAt: new Date(now).toISOString()
    }];
    await stateStore.upsertServiceState?.(ADMIN_OURS_SCOPE, { wallets: next });
    logger?.info?.({
      event: "self_identity_ours_edited",
      action,
      label: action === "add" ? label : null,
      purpose: action === "add" ? String(purpose).trim() : null,
      wallet: normalized,
      addedBy: normalizeWallet(addedBy) ?? null
    }, "self_identity_ours_edited");
    return { action, label: action === "add" ? label : null, count: next.length, wallets: next };
  } finally {
    await stateStore.releaseClaimLock?.(ADMIN_OURS_SCOPE, owner);
  }
}

function selfIdentity(kind, evidence) {
  return { actor: "self", self: true, ambiguous: false, kind, evidence };
}

function externalIdentity(evidence) {
  return {
    actor: "external",
    self: false,
    ambiguous: false,
    kind: SELF_IDENTITY_KINDS.EXTERNAL,
    evidence
  };
}

function normalizeWallet(value) {
  const wallet = String(value ?? "").trim().toLowerCase();
  return WALLET_RE.test(wallet) ? wallet : undefined;
}

function normalizeClientName(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return name || undefined;
}

function walletSet(values) {
  return new Set([...asIterable(values)].map(normalizeWallet).filter(Boolean));
}

function clientSet(values) {
  return new Set([...asIterable(values)].map(normalizeClientName).filter(Boolean));
}

function asIterable(values) {
  if (values instanceof Set || Array.isArray(values)) return values;
  return [];
}

function parseWalletList(raw) {
  return String(raw ?? "").split(",").map((value) => value.trim());
}

function parseClientNames(raw) {
  return String(raw ?? "").split(",").map((value) => value.trim());
}

function parseApiKeyIdList(raw) {
  return String(raw ?? "").split(",").map((value) => value.trim());
}

function apiKeyIdSet(values) {
  return new Set([...asIterable(values)].map(normalizeApiKeyId).filter(Boolean));
}
