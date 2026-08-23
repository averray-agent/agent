import { isHostedCanaryClaimant } from "./claimant-attribution.js";

const WALLET_RE = /^0x[0-9a-f]{40}$/u;
const SELF_CLIENT_PREFIX = "averray-";
const AMBIGUOUS_CLIENT_DEFAULTS = Object.freeze(["anthropic/claudeai"]);

export const SELF_IDENTITY_KINDS = Object.freeze({
  CANARY: "canary",
  ACCEPTANCE: "acceptance",
  OPERATOR: "operator",
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
    adminWallets = [],
    verifierWallets = [],
    viewerWallets = [],
    selfClients = [],
    ambiguousClients = AMBIGUOUS_CLIENT_DEFAULTS
  } = {}) {
    this.operatorWallets = walletSet(operatorWallets);
    this.acceptanceWallets = walletSet(acceptanceWallets);
    this.adminWallets = walletSet(adminWallets);
    this.verifierWallets = walletSet(verifierWallets);
    this.viewerWallets = walletSet(viewerWallets);
    this.selfClients = clientSet(selfClients);
    this.ambiguousClients = clientSet(ambiguousClients);
  }

  classify({ wallet, clientInfo, session, canaryMarkerValid } = {}) {
    const normalizedWallet = normalizeWallet(wallet ?? session?.wallet);
    const clientName = normalizeClientName(clientInfo?.name ?? clientInfo);

    if (canaryMarkerValid === true || isHostedCanaryClaimant(session)) {
      return selfIdentity(SELF_IDENTITY_KINDS.CANARY, "wallet_bound_canary_marker");
    }
    // A presented-but-invalid marker is positive evidence of nothing. Keep the
    // old fail-safe direction: it cannot borrow another static classification.
    if (canaryMarkerValid === false) return externalIdentity("invalid_canary_marker");

    if (normalizedWallet) {
      if (this.acceptanceWallets.has(normalizedWallet)) {
        return selfIdentity(SELF_IDENTITY_KINDS.ACCEPTANCE, "acceptance_wallet_registry");
      }
      if (this.operatorWallets.has(normalizedWallet)) {
        return selfIdentity(SELF_IDENTITY_KINDS.OPERATOR, "operator_wallet_registry");
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
}

export function createSelfIdentityRegistry({ env = process.env, authConfig } = {}) {
  return new SelfIdentityRegistry({
    operatorWallets: parseWalletList(env?.ARRIVAL_SELF_WALLETS),
    acceptanceWallets: parseWalletList(env?.ARRIVAL_ACCEPTANCE_WALLETS),
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
