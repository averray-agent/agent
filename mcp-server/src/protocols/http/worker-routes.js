import { AuthorizationError } from "../../core/errors.js";
import { WORK_RECEIPT_SITE_ORIGIN } from "../../core/work-receipt.js";
import { buildPublicReputation } from "./profile-routes.js";

const DEFAULT_RECEIPT_LIMIT = 20;
const MAX_RECEIPT_LIMIT = 100;

export function createWorkerRoutes({
  authMiddleware,
  parseLimit,
  respond,
  service,
  stateStore,
  workerProgressionService
}) {
  return async function handleWorkerRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/me") {
      const auth = await authMiddleware(request, url);
      const [rawReputation, progression, account] = await Promise.all([
        service.getReputation(auth.wallet),
        workerProgressionService.getProgression(auth.wallet),
        service.getAccountSummary(auth.wallet)
      ]);
      const reputation = buildPublicReputation(rawReputation);
      respond(response, 200, {
        wallet: auth.wallet,
        claimTier: reputation.jobEligibilityTier,
        reputationTier: reputation.tier,
        progression,
        accountPosition: projectAccountPosition(account)
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/receipts") {
      const auth = await authMiddleware(request, url);
      assertOwnWalletQuery(url.searchParams.get("wallet"), auth.wallet);
      const limit = parseLimit(url, DEFAULT_RECEIPT_LIMIT, MAX_RECEIPT_LIMIT);
      const sessions = await service.collectSessionHistory(auth.wallet);
      const receipts = await Promise.all(sessions.map(async (session) => ({
        session,
        document: await stateStore.getRunReceiptDocument?.(session.sessionId)
      })));
      respond(response, 200, receipts
        .map(({ document, session }) => projectOwnReceipt(document, session, auth.wallet))
        .filter(Boolean)
        .sort((left, right) => receiptTimestamp(right) - receiptTimestamp(left))
        .slice(0, limit));
      return true;
    }

    return false;
  };
}

function projectAccountPosition(account) {
  return {
    liquid: account?.liquid ?? {},
    reserved: account?.reserved ?? {},
    jobStakeLocked: account?.jobStakeLocked ?? {},
    raw: {
      liquid: account?.raw?.liquid ?? {},
      reserved: account?.raw?.reserved ?? {},
      jobStakeLocked: account?.raw?.jobStakeLocked ?? {}
    }
  };
}

function projectOwnReceipt(document, session, wallet) {
  if (!document?.receiptId || !walletsMatch(session?.wallet, wallet)) return undefined;
  if (document.worker && !walletsMatch(document.worker, wallet)) return undefined;
  const settlement = document.settlement;
  return {
    receiptId: document.receiptId,
    sessionId: document.sessionId ?? session.sessionId,
    outcome: document.verdict?.outcome ?? null,
    amounts: settlement ? projectAmounts(settlement) : null,
    timestamps: document.timestamps ?? {},
    canonicalUrl: document.canonicalUrl
      ?? `${WORK_RECEIPT_SITE_ORIGIN}/receipts/${document.receiptId}`
  };
}

function projectAmounts(settlement) {
  return Object.fromEntries([
    "asset",
    "assetSymbol",
    "rewardAmount",
    "rewardAmountRaw",
    "workerAmount",
    "workerAmountRaw",
    "gasRetentionAmount",
    "gasRetentionAmountRaw",
    "protocolFeeAmount",
    "protocolFeeAmountRaw",
    "posterTotalAmount",
    "posterTotalAmountRaw"
  ].flatMap((key) => settlement[key] === undefined ? [] : [[key, settlement[key]]]));
}

function receiptTimestamp(receipt) {
  const timestamps = receipt?.timestamps ?? {};
  for (const value of [timestamps.verifiedAt, timestamps.submittedAt, timestamps.claimedAt]) {
    const parsed = Date.parse(value ?? "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function assertOwnWalletQuery(requestedWallet, authenticatedWallet) {
  if (requestedWallet && !walletsMatch(requestedWallet, authenticatedWallet)) {
    throw new AuthorizationError(
      "Receipt history is restricted to the signed-in wallet.",
      "receipt_wallet_mismatch"
    );
  }
}

function walletsMatch(left, right) {
  return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}
