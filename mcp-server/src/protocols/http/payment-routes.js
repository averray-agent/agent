import { getAddress } from "ethers";

import { ValidationError } from "../../core/errors.js";

function safeChecksum(raw) {
  try {
    return getAddress(raw);
  } catch {
    return raw;
  }
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
    const idempotency = buildIdempotentMutationContext({
      route: "/payments/send",
      auth,
      payload,
      normalizedPayload: {
        ...stripIdempotencyKey(payload),
        recipient,
        asset,
        amount
      },
      bucket: "payments_send"
    });

    await runIdempotentMutation(response, idempotency, 200, async () => {
      await requireChainBackedMutation("/payments/send");
      const balances = await service.sendToAgent(auth.wallet, recipient, asset, amount);
      return {
        status: "sent",
        from: auth.wallet,
        to: recipient,
        asset,
        amount,
        balances
      };
    });
    return true;
  };
}
