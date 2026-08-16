import { getAddress } from "ethers";

import {
  AuthorizationError,
  ValidationError,
} from "../../core/errors.js";

const UINT256_MAX = (1n << 256n) - 1n;
const SIGNATURE_RE = /^0x[a-fA-F0-9]{130}$/u;

function normalizeAddress(value, label) {
  try {
    return getAddress(String(value ?? "").trim());
  } catch {
    throw new ValidationError(`${label} must be a 0x-prefixed 20-byte EVM address.`);
  }
}

function normalizeUint256(value, label, { positive = false } = {}) {
  const raw = typeof value === "bigint" ? value.toString() : String(value ?? "").trim();
  if (!/^\d+$/u.test(raw)) {
    throw new ValidationError(`${label} must be an exact unsigned uint256 string.`);
  }
  const parsed = BigInt(raw);
  if (parsed > UINT256_MAX || (positive && parsed === 0n)) {
    throw new ValidationError(`${label} must be ${positive ? "a positive" : "an"} uint256.`);
  }
  return parsed.toString();
}

function normalizeSignature(value) {
  const signature = String(value ?? "").trim();
  if (!SIGNATURE_RE.test(signature)) {
    throw new ValidationError("signature must be a 65-byte 0x-prefixed hex string.");
  }
  return signature;
}

export function resolveAgentTransferRecipientAllowlist({
  rewardBankAddress,
  additionalRecipients = [],
} = {}) {
  let rewardBank;
  try {
    rewardBank = getAddress(String(rewardBankAddress ?? "").trim());
  } catch {
    throw new ValidationError("Configured reward bank address is missing or invalid.");
  }
  const allowed = new Set([rewardBank.toLowerCase()]);
  for (const candidate of additionalRecipients) {
    if (!candidate) continue;
    try {
      allowed.add(getAddress(String(candidate).trim()).toLowerCase());
    } catch {
      throw new ValidationError("Configured agent-transfer recipient is invalid.");
    }
  }
  return allowed;
}

function normalizeTransferPayload(payload, allowedRecipients) {
  const from = normalizeAddress(payload?.from, "from");
  const recipient = normalizeAddress(payload?.recipient, "recipient");
  const asset = normalizeAddress(payload?.asset, "asset");
  const amountRaw = normalizeUint256(payload?.amount, "amount", { positive: true });
  const nonce = normalizeUint256(payload?.nonce, "nonce");
  const deadline = normalizeUint256(payload?.deadline, "deadline", { positive: true });
  const signature = normalizeSignature(payload?.signature);

  if (!allowedRecipients.has(recipient.toLowerCase())) {
    throw new AuthorizationError(
      "Agent transfer recipient is not an operator-controlled recovery account.",
      "agent_transfer_recipient_not_allowed",
      { recipient },
    );
  }
  if (from.toLowerCase() === recipient.toLowerCase()) {
    throw new ValidationError("from and recipient must differ.");
  }
  return { from, recipient, asset, amountRaw, nonce, deadline, signature };
}

export function createAdminAgentTransferRoutes({
  allowedRecipients,
  authMiddleware,
  buildMutationRequestHash,
  enforceLimit,
  gateway,
  rateLimitConfig,
  readJsonBody,
  requireChainBackedMutation,
  respond,
  runIdempotentMutation,
}) {
  if (!(allowedRecipients instanceof Set)) {
    throw new TypeError("allowedRecipients must be a Set.");
  }

  return async function handleAdminAgentTransferRoute({ request, response, url, pathname }) {
    if (request.method !== "POST" || pathname !== "/admin/agent-transfers") {
      return false;
    }

    const auth = await authMiddleware(request, url, { requireCapability: "agent-transfers:submit" });
    await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
    const transfer = normalizeTransferPayload(await readJsonBody(request), allowedRecipients);
    const context = {
      bucket: "admin_agent_transfers",
      key: `${transfer.from.toLowerCase()}:${transfer.nonce}`,
      requestHash: buildMutationRequestHash({
        route: "/admin/agent-transfers",
        wallet: auth.wallet,
        payload: transfer,
      }),
    };

    await runIdempotentMutation(response, context, 200, async () => {
      await requireChainBackedMutation("/admin/agent-transfers");
      const receipt = await gateway.submitAuthorizedAgentTransfer(transfer);
      return {
        status: "confirmed",
        ...receipt,
        nonce: transfer.nonce,
        deadline: transfer.deadline,
      };
    });
    return true;
  };
}
