import { getAddress } from "ethers";

import { ValidationError } from "../../core/errors.js";

const SIGNATURE_RE = /^0x[a-fA-F0-9]{130}$/u;

function safeChecksum(raw) {
  try {
    return getAddress(raw);
  } catch {
    return raw;
  }
}

function normalizeUint256String(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`${label} must be an exact non-negative uint256.`);
    }
    return String(value);
  }
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new ValidationError(`${label} must be an exact non-negative uint256.`);
    }
    return value.toString();
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) {
    throw new ValidationError(`${label} must be an exact non-negative uint256.`);
  }
  return value.trim();
}

function readTransferAuthorization(payload = {}) {
  const raw = payload.transferAuthorization ?? payload.authorization;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("transferAuthorization with nonce, deadline, and signature is required.");
  }
  const nonce = normalizeUint256String(raw.nonce, "transferAuthorization.nonce");
  const deadline = normalizeUint256String(raw.deadline, "transferAuthorization.deadline");
  const signature = typeof raw.signature === "string" ? raw.signature.trim() : "";
  if (!SIGNATURE_RE.test(signature)) {
    throw new ValidationError("transferAuthorization.signature must be a 65-byte hex string.");
  }
  return { nonce, deadline, signature };
}

export function createPaymentRoutes({
  authMiddleware,
  buildIdempotentMutationContext,
  readJsonBody,
  requireChainBackedMutation,
  runIdempotentMutation,
  service,
  stripIdempotencyKey,
}) {
  return async function handlePaymentRoute({ request, response, url, pathname }) {
    if (request.method !== "POST" || pathname !== "/payments/send") {
      return false;
    }

    // Agent-to-agent transfer. Pillar 5 of docs/AGENT_BANKING.md.
    // Authenticated: the signed-in wallet is the sender, and the backend
    // relays via AgentAccountCore.sendToAgentFor so the platform hot signer
    // pays gas, not the user.
    const auth = await authMiddleware(request, url);
    const payload = await readJsonBody(request);
    const recipientRaw = String(payload?.recipient ?? "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/u.test(recipientRaw)) {
      throw new ValidationError("recipient must be a 0x-prefixed 20-byte hex address.");
    }
    const recipient = safeChecksum(recipientRaw);
    if (recipient.toLowerCase() === auth.wallet.toLowerCase()) {
      throw new ValidationError("recipient must differ from the sender.");
    }
    const asset = typeof payload?.asset === "string" && payload.asset.trim()
      ? payload.asset.trim().toUpperCase()
      : "DOT";
    const amount = Number(payload?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError("amount must be a positive number.");
    }
    const transferAuthorization = readTransferAuthorization(payload);
    const idempotency = buildIdempotentMutationContext({
      route: "/payments/send",
      auth,
      payload,
      normalizedPayload: {
        ...stripIdempotencyKey(payload),
        recipient,
        asset,
        amount,
        transferAuthorization
      },
      bucket: "payments_send"
    });

    await runIdempotentMutation(response, idempotency, 200, async () => {
      await requireChainBackedMutation("/payments/send");
      const balances = await service.sendToAgent(auth.wallet, recipient, asset, amount, transferAuthorization);
      return {
        status: "sent",
        from: auth.wallet,
        to: recipient,
        asset,
        amount,
        transferAuthorization: {
          nonce: transferAuthorization.nonce,
          deadline: transferAuthorization.deadline
        },
        balances
      };
    });
    return true;
  };
}
