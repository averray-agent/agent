import { Interface } from "ethers";

/**
 * P-PEOPLE-LITE slices A + B. Wallet in, pinned personhood out.
 *
 * v1 has no value gate. This module does not mint people, run an attester,
 * or decide claim caps. Slices C (job minPersonhood) and D (cap ladder)
 * stay parked until Product picks numbers. Do not invent those numbers here.
 *
 * Open Product decisions this code refuses to close:
 * 1. Cap numbers for lite vs full, and whether the free tier stays as-is.
 * 2. Whether a poster may require Full before Full is common on Hub.
 * 3. Which chain is the long-term pin. Live reads use the Polkadot Hub
 *    personhood precompile on Averray's existing Hub eth RPC, one finalized
 *    block at a time (status 0/1/2 + contextAlias). That snapshot does not
 *    carry a .dot or lite username, and it does not distinguish
 *    Candidate / MembershipReady / Member / Caution, or Suspended from
 *    an empty account. Those tags are covered by pinned Paseo-shaped
 *    fixtures. A People-chain username read is a different chain and is
 *    not folded into the same `at`.
 * 4. Attester filter. v1 shows whatever lite/full state the pinned
 *    snapshot already contains. Restricting the badge to one attester
 *    is a later call, and only matters if caps ship.
 *
 * The client SDK is not an authorization oracle. Future gates must
 * re-read this server path (or an equivalent chain read) at a pinned block.
 */

export const PERSONHOOD_PRECOMPILE_ADDRESS = "0x000000000000000000000000000000000a010000";

// ASCII "averray", left-aligned bytes32. Context selects the alias only.
// v1 does not filter attestations by this context.
export const AVERRAY_PERSONHOOD_CONTEXT =
  "0x6176657272617900000000000000000000000000000000000000000000000000";

export const POLKADOT_HUB_CHAIN_ID = 420420419;

export const PEOPLE_LITE_BATCH_LIMIT = 50;

export const PEOPLE_LITE_COPY = Object.freeze({
  lite: "Lite is an attested Polkadot App install or another governance-authorized attestation. Soft signal only. It does not provide hard sybil resistance. Averray does not run an attester, and this signal does not change claim caps or payouts.",
  full: "Full is the stronger on-chain personhood track. When this snapshot includes an Individuality tag, it is in detail.sdkTag. Soft signal only. Averray does not run an attester, and this signal does not change claim caps or payouts.",
  suspended: "The chain label is Suspended. Privileges are treated as none. Averray does not run an attester, and this signal does not change claim caps or payouts."
});

const PERSONHOOD_IFACE = new Interface([
  "function personhoodStatus(address account, bytes32 context) view returns (uint8 status, bytes32 contextAlias)"
]);

const FULL_TRACK = new Set(["Candidate", "MembershipReady", "Member", "Caution"]);
const SDK_TAGS = new Set(["NotEnrolled", "Lite", ...FULL_TRACK, "Suspended"]);

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;
const BLOCK_HASH_RE = /^0x[a-fA-F0-9]{64}$/u;
const LITE_NAME_RE = /^[a-z][a-z0-9]{0,31}\.(0[1-9]|[1-9][0-9])$/u;
const FULL_NAME_RE = /^[a-z][a-z0-9-]{0,61}\.dot$/u;

export const PEOPLE_LITE_FIXTURE_AT = Object.freeze({
  blockHash: `0x${"ab".repeat(32)}`,
  blockNumber: 21004512,
  chain: "fixture:paseo-individuality",
  chainId: null
});

export const PEOPLE_LITE_FIXTURE_WALLETS = Object.freeze({
  none: "0x0000000000000000000000000000000000000a11",
  lite: "0x0000000000000000000000000000000000000a22",
  full: "0x0000000000000000000000000000000000000a33"
});

/**
 * Pinned Paseo-shaped snapshots. The three public wallets are the
 * none / lite / full-track acceptance set. Extra tags stay here so the
 * mapper is tested without pretending the Hub precompile returned them.
 */
export const PEOPLE_LITE_FIXTURES = Object.freeze({
  [PEOPLE_LITE_FIXTURE_WALLETS.none]: Object.freeze({
    kind: "sdk",
    sdkTag: "NotEnrolled",
    fullUsername: null,
    liteUsername: null
  }),
  [PEOPLE_LITE_FIXTURE_WALLETS.lite]: Object.freeze({
    kind: "sdk",
    sdkTag: "Lite",
    fullUsername: null,
    liteUsername: "cedar.07"
  }),
  [PEOPLE_LITE_FIXTURE_WALLETS.full]: Object.freeze({
    kind: "sdk",
    sdkTag: "Member",
    fullUsername: "cedar.dot",
    liteUsername: "cedar.07"
  }),
  "0x0000000000000000000000000000000000000a44": Object.freeze({
    kind: "sdk",
    sdkTag: "Candidate",
    fullUsername: "birch.dot",
    liteUsername: "birch.03"
  }),
  "0x0000000000000000000000000000000000000a55": Object.freeze({
    kind: "sdk",
    sdkTag: "MembershipReady",
    fullUsername: null,
    liteUsername: "alder.11"
  }),
  "0x0000000000000000000000000000000000000a66": Object.freeze({
    kind: "sdk",
    sdkTag: "Caution",
    fullUsername: "dusk.dot",
    liteUsername: "dusk.02"
  }),
  "0x0000000000000000000000000000000000000a77": Object.freeze({
    kind: "sdk",
    sdkTag: "Suspended",
    fullUsername: null,
    liteUsername: "elm.04"
  })
});

export function normalizePeopleWallet(wallet) {
  const value = String(wallet ?? "").trim();
  if (!ADDRESS_RE.test(value)) return null;
  return value.toLowerCase();
}

export function encodePersonhoodStatusCall(wallet, context = AVERRAY_PERSONHOOD_CONTEXT) {
  return PERSONHOOD_IFACE.encodeFunctionData("personhoodStatus", [wallet, context]);
}

export function decodePersonhoodStatusResult(data) {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/u.test(data)) return null;
  if ((data.length - 2) / 2 !== 64) return null;
  try {
    const decoded = PERSONHOOD_IFACE.decodeFunctionResult("personhoodStatus", data);
    const status = Number(decoded[0]);
    if (!Number.isInteger(status) || status < 0 || status > 255) return null;
    return {
      status,
      contextAlias: String(decoded[1]).toLowerCase()
    };
  } catch {
    return null;
  }
}

export function displayNameFromUsernames({ fullUsername = null, liteUsername = null } = {}) {
  const full = normalizeUsername(fullUsername);
  if (full && FULL_NAME_RE.test(full)) return full;
  const lite = normalizeUsername(liteUsername);
  if (lite && LITE_NAME_RE.test(lite)) return lite;
  return null;
}

export function projectPeopleLite({ wallet, at, snapshot }) {
  const normalized = normalizePeopleWallet(wallet);
  if (!normalized) {
    throw new TypeError("wallet must be a 0x-prefixed 20-byte hex address.");
  }
  const pinned = normalizeAt(at);
  if (snapshot?.kind === "sdk") {
    return projectSdk({ wallet: normalized, at: pinned, snapshot });
  }
  if (snapshot?.kind === "precompile") {
    return projectPrecompile({ wallet: normalized, at: pinned, snapshot });
  }
  throw new TypeError("personhood snapshot kind is not supported.");
}

export function emptyPeopleLiteLine() {
  return { text: null, pill: null, tooltip: null };
}

function projectSdk({ wallet, at, snapshot }) {
  const sdkTag = snapshot.sdkTag;
  if (!SDK_TAGS.has(sdkTag)) {
    throw new TypeError(`unsupported Individuality tag: ${sdkTag}`);
  }
  const displayName = displayNameFromUsernames(snapshot);
  const mapped = mapSdkTag(sdkTag);
  return finish({
    wallet,
    at,
    tier: mapped.tier,
    displayName,
    detail: {
      privileges: mapped.privileges,
      label: mapped.label,
      sdkTag,
      source: "fixture:paseo-individuality",
      precompileStatus: null,
      contextAlias: null,
      context: null,
      attesterFilter: "any-onchain-state",
      gatesClaims: false,
      recognized: snapshot.recognized !== false,
      note: mapped.note ?? null
    }
  });
}

function projectPrecompile({ wallet, at, snapshot }) {
  const status = Number(snapshot.status);
  const mapped = mapPrecompileStatus(status);
  if (!mapped) {
    return unavailable({
      wallet,
      at,
      reason: "precompile_status_unrecognized",
      source: "polkadot-hub-precompile"
    });
  }
  return finish({
    wallet,
    at,
    tier: mapped.tier,
    displayName: null,
    detail: {
      privileges: mapped.privileges,
      label: mapped.label,
      sdkTag: mapped.sdkTag,
      source: "polkadot-hub-precompile",
      precompileStatus: status,
      contextAlias: typeof snapshot.contextAlias === "string" ? snapshot.contextAlias.toLowerCase() : null,
      context: snapshot.context ?? AVERRAY_PERSONHOOD_CONTEXT,
      attesterFilter: "any-onchain-state",
      gatesClaims: false,
      recognized: status !== 0,
      note: mapped.note
    }
  });
}

function finish({ wallet, at, tier, displayName, detail }) {
  return {
    available: true,
    wallet,
    tier,
    displayName,
    at,
    detail,
    line: lineFor({ tier, label: detail.label, displayName })
  };
}

export function unavailablePersonhood({ wallet, at = null, reason, source = null }) {
  return unavailable({
    wallet: normalizePeopleWallet(wallet) ?? String(wallet ?? "").toLowerCase(),
    at,
    reason,
    source
  });
}

function unavailable({ wallet, at, reason, source }) {
  return {
    available: false,
    wallet,
    tier: null,
    displayName: null,
    at,
    detail: {
      privileges: null,
      label: null,
      sdkTag: null,
      source,
      precompileStatus: null,
      contextAlias: null,
      context: null,
      attesterFilter: "any-onchain-state",
      gatesClaims: false,
      recognized: false,
      reason,
      note: null
    },
    line: emptyPeopleLiteLine()
  };
}

function lineFor({ tier, label, displayName }) {
  if (label === "suspended") {
    return { text: displayName, pill: "suspended", tooltip: PEOPLE_LITE_COPY.suspended };
  }
  if (tier === "lite") {
    return { text: displayName, pill: "lite", tooltip: PEOPLE_LITE_COPY.lite };
  }
  if (tier === "full") {
    return { text: displayName, pill: "full", tooltip: PEOPLE_LITE_COPY.full };
  }
  return { text: displayName, pill: null, tooltip: null };
}

function mapSdkTag(sdkTag) {
  if (sdkTag === "NotEnrolled") {
    return { tier: "none", privileges: "none", label: "none" };
  }
  if (sdkTag === "Lite") {
    return { tier: "lite", privileges: "lite", label: "lite" };
  }
  if (FULL_TRACK.has(sdkTag)) {
    return { tier: "full", privileges: "full", label: "full" };
  }
  if (sdkTag === "Suspended") {
    return {
      tier: "none",
      privileges: "none",
      label: "suspended",
      note: "Suspended keeps its chain label. Privileges are treated as none."
    };
  }
  return null;
}

function mapPrecompileStatus(status) {
  if (status === 0) {
    return {
      tier: "none",
      privileges: "none",
      label: "none",
      sdkTag: null,
      note: "Hub personhood status 0 does not distinguish NotEnrolled from Suspended."
    };
  }
  if (status === 1) {
    return {
      tier: "lite",
      privileges: "lite",
      label: "lite",
      sdkTag: "Lite",
      note: "Hub personhood status 1 is Lite. The precompile does not return a username."
    };
  }
  if (status === 2) {
    return {
      tier: "full",
      privileges: "full",
      label: "full",
      sdkTag: null,
      note: "Hub personhood status 2 does not distinguish Candidate, MembershipReady, Member, and Caution."
    };
  }
  return null;
}

function normalizeAt(at) {
  if (!at || typeof at !== "object") {
    throw new TypeError("personhood read is missing its pinned block.");
  }
  const blockHash = String(at.blockHash ?? "");
  if (!BLOCK_HASH_RE.test(blockHash)) {
    throw new TypeError("pinned blockHash must be a 0x 32-byte hex string.");
  }
  const blockNumber = Number(at.blockNumber);
  if (!Number.isInteger(blockNumber) || blockNumber < 0) {
    throw new TypeError("pinned blockNumber must be a non-negative integer.");
  }
  const chain = String(at.chain ?? "").trim();
  if (!chain) throw new TypeError("pinned chain is required.");
  const chainId = at.chainId === null || at.chainId === undefined ? null : Number(at.chainId);
  if (chainId !== null && (!Number.isInteger(chainId) || chainId < 0)) {
    throw new TypeError("pinned chainId must be a non-negative integer or null.");
  }
  return {
    blockHash: blockHash.toLowerCase(),
    blockNumber,
    chain,
    chainId
  };
}

function normalizeUsername(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  return value.trim().toLowerCase();
}
