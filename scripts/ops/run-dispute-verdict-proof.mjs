#!/usr/bin/env node
//
// Hosted dispute-verdict proof harness.
//
// Defaults to **dry-run**. The script only mutates state when
// `DISPUTE_PROOF_LIVE=1` is set explicitly *and* a specific dispute id
// is named via `DISPUTE_PROOF_ID`. The dry-run path prints the exact
// payload it would submit so a reviewer can sanity-check before
// flipping the live flag.
//
// Live-mode safety rails (fail-closed):
//   - The dispute is fetched first; the script refuses to submit if
//     the dispute is not in `open` status or already carries a verdict.
//   - The verdict is submitted with an explicit `idempotencyKey` so
//     accidental retries replay rather than re-resolve.
//   - The response is verified to contain the documented evidence
//     fields (`verdict`, `reasonCode`, `reasoningHash`, `metadataURI`,
//     `chainStatus`, `timeline[].verdict_submitted`).
//   - A follow-up `getDispute(id)` confirms the verdict persisted on
//     the server — not just echoed back in the response body.
//
// This script never creates disputes and never iterates the queue
// looking for "something to resolve". The caller chooses the dispute.

import { AgentPlatformClient } from "../../sdk/agent-platform-client.js";

const DEFAULT_API_BASE_URL = "https://api.averray.com";
const ALLOWED_VERDICTS = new Set(["upheld", "dismissed", "split", "timeout"]);
const REQUIRED_VERDICT_RESPONSE_FIELDS = [
  "verdict",
  "reasonCode",
  "reasoningHash",
  "metadataURI",
  "chainStatus"
];

export async function runDisputeVerdictProof({
  env = process.env,
  client = undefined,
  log = console.log
} = {}) {
  const config = parseConfig(env);
  const platform = client ?? new AgentPlatformClient({
    baseUrl: config.apiBaseUrl,
    token: config.token
  });

  log(`Fetching dispute ${config.disputeId} from ${config.apiBaseUrl}`);
  const dispute = await platform.getDispute(config.disputeId);
  assertDisputable(dispute, config.disputeId);

  const payload = buildVerdictPayload(config);

  if (!config.live) {
    log("Dry-run: not submitting. Set DISPUTE_PROOF_LIVE=1 to mutate.");
    return {
      mode: "dry_run",
      disputeId: config.disputeId,
      dispute: projectDisputeSummary(dispute),
      payload
    };
  }

  log(`Submitting verdict for ${config.disputeId} (idempotencyKey=${payload.idempotencyKey})`);
  const response = await platform.submitDisputeVerdict(config.disputeId, payload);
  assertVerdictEvidence(response, config.disputeId);

  log(`Re-fetching dispute ${config.disputeId} to confirm persistence`);
  const persisted = await platform.getDispute(config.disputeId);
  assertPersisted(persisted, response, config.disputeId);

  return {
    mode: "live",
    disputeId: config.disputeId,
    dispute: projectDisputeSummary(dispute),
    payload,
    response: projectVerdictResponse(response),
    persisted: projectPersistedDispute(persisted)
  };
}

function parseConfig(env) {
  const token = pick(env.ADMIN_JWT) || pick(env.AVERRAY_TOKEN);
  if (!token) {
    throw new Error("ADMIN_JWT (or AVERRAY_TOKEN) is required.");
  }
  const disputeId = pick(env.DISPUTE_PROOF_ID);
  if (!disputeId) {
    throw new Error(
      "DISPUTE_PROOF_ID is required. The script never resolves an arbitrary dispute — the caller must name the dispute id explicitly."
    );
  }
  const rawVerdict = pick(env.DISPUTE_PROOF_VERDICT)?.toLowerCase();
  if (!rawVerdict || !ALLOWED_VERDICTS.has(rawVerdict)) {
    throw new Error(
      `DISPUTE_PROOF_VERDICT must be one of ${[...ALLOWED_VERDICTS].join(" | ")}. Got: ${rawVerdict ?? "(empty)"}`
    );
  }
  const rationale = pick(env.DISPUTE_PROOF_RATIONALE);
  if (!rationale) {
    throw new Error("DISPUTE_PROOF_RATIONALE is required (arbitrator reasoning text).");
  }
  let workerPayout;
  if (rawVerdict === "split") {
    const raw = pick(env.DISPUTE_PROOF_WORKER_PAYOUT);
    if (!raw) {
      throw new Error("DISPUTE_PROOF_WORKER_PAYOUT is required for split verdicts.");
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`DISPUTE_PROOF_WORKER_PAYOUT must be a positive number. Got: ${raw}`);
    }
    workerPayout = parsed;
  }
  const idempotencyKey = pick(env.DISPUTE_PROOF_IDEMPOTENCY_KEY) || `dispute-proof-${disputeId}`;
  const apiBaseUrl = stripTrailingSlash(pick(env.API_BASE_URL) || DEFAULT_API_BASE_URL);
  // Live mode requires *both* an explicit flag AND a non-empty dispute
  // id; the second is already enforced above but kept here as the
  // single point of truth for "we are about to mutate".
  const live = pick(env.DISPUTE_PROOF_LIVE) === "1";
  return { token, disputeId, verdict: rawVerdict, rationale, workerPayout, idempotencyKey, apiBaseUrl, live };
}

function assertDisputable(dispute, disputeId) {
  if (!dispute || typeof dispute !== "object") {
    throw new Error(`Dispute ${disputeId} not found.`);
  }
  if (dispute.id !== disputeId) {
    throw new Error(`Dispute fetch returned a different id (${dispute.id}); refusing to proceed.`);
  }
  if (dispute.status !== "open") {
    throw new Error(
      `Dispute ${disputeId} is not in 'open' status (got status=${dispute.status}). Refusing to re-resolve a closed dispute.`
    );
  }
  if (dispute.verdict) {
    throw new Error(
      `Dispute ${disputeId} already carries a verdict (${dispute.verdict}). Refusing to overwrite.`
    );
  }
}

function buildVerdictPayload(config) {
  const payload = {
    verdict: config.verdict,
    rationale: config.rationale,
    idempotencyKey: config.idempotencyKey
  };
  if (config.workerPayout !== undefined) {
    payload.workerPayout = config.workerPayout;
  }
  return payload;
}

function assertVerdictEvidence(response, disputeId) {
  if (!response || typeof response !== "object") {
    throw new Error(`Verdict response was not a JSON object (disputeId=${disputeId}).`);
  }
  const missing = REQUIRED_VERDICT_RESPONSE_FIELDS.filter((field) => !response[field]);
  if (missing.length) {
    throw new Error(
      `Verdict response missing required evidence fields: ${missing.join(", ")}.`
    );
  }
  if (!/^0x[a-f0-9]{64}$/u.test(String(response.reasoningHash))) {
    throw new Error(
      `Verdict response reasoningHash is not a 32-byte hex value: ${response.reasoningHash}`
    );
  }
  if (!Array.isArray(response.timeline)) {
    throw new Error("Verdict response is missing a timeline array.");
  }
  const verdictEvent = response.timeline.find((entry) => entry?.action === "verdict_submitted");
  if (!verdictEvent) {
    throw new Error("Verdict response timeline does not include a verdict_submitted entry.");
  }
  // chainStatus must be one of the documented values; a typo would
  // mask a wiring drift, so be strict.
  const allowedChainStatus = new Set(["confirmed", "submitted", "local_only"]);
  if (!allowedChainStatus.has(String(response.chainStatus))) {
    throw new Error(
      `Unknown chainStatus '${response.chainStatus}'. Expected one of ${[...allowedChainStatus].join(" | ")}.`
    );
  }
}

function assertPersisted(persisted, response, disputeId) {
  if (!persisted || persisted.id !== disputeId) {
    throw new Error(`Re-fetch of dispute ${disputeId} did not return the same record.`);
  }
  if (persisted.status !== "resolved") {
    throw new Error(
      `After verdict submission, dispute ${disputeId} is still status=${persisted.status} on re-fetch. Receipt did not persist.`
    );
  }
  if (persisted.reasoningHash !== response.reasoningHash) {
    throw new Error(
      "Persisted dispute reasoningHash does not match the verdict response — server may have stored a different record."
    );
  }
}

function projectDisputeSummary(dispute) {
  return {
    id: dispute.id,
    status: dispute.status,
    sessionId: dispute.sessionId,
    chainJobId: dispute.chainJobId,
    claimant: dispute.claimant,
    openedAt: dispute.openedAt,
    windowEndsAt: dispute.windowEndsAt,
    slaSeconds: dispute.slaSeconds,
    stakedAmount: dispute.stakedAmount
  };
}

function projectVerdictResponse(response) {
  return {
    status: response.status,
    verdict: response.verdict,
    reasonCode: response.reasonCode,
    reasoningHash: response.reasoningHash,
    metadataURI: response.metadataURI,
    workerPayout: response.workerPayout,
    remainingPayout: response.remainingPayout,
    txHash: response.txHash,
    blockNumber: response.blockNumber,
    chainStatus: response.chainStatus
  };
}

function projectPersistedDispute(persisted) {
  return {
    id: persisted.id,
    status: persisted.status,
    verdict: persisted.verdict,
    reasonCode: persisted.reasonCode,
    reasoningHash: persisted.reasoningHash,
    metadataURI: persisted.metadataURI,
    txHash: persisted.txHash,
    chainStatus: persisted.chainStatus
  };
}

function pick(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stripTrailingSlash(value) {
  return typeof value === "string" ? value.replace(/\/+$/u, "") : value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDisputeVerdictProof()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error?.message ?? String(error));
      process.exitCode = 1;
    });
}
