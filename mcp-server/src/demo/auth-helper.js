import { Wallet } from "ethers";

/**
 * Perform a full SIWE login flow against a running HTTP server and return the
 * bearer token + wallet address. Used by e2e demos and as a reference
 * implementation for programmatic agents.
 *
 * Flow:
 *   1. POST /auth/nonce { wallet } — server returns a nonce + SIWE message.
 *   2. Sign the message with the agent's private key.
 *   3. POST /auth/verify { message, signature } — server returns a JWT.
 *
 * Accepts either a `privateKey` (hex) or a pre-instantiated ethers `Wallet`.
 */
export async function loginTestWallet({ baseUrl, privateKey, wallet }) {
  const ethersWallet = wallet ?? new Wallet(privateKey);
  const address = ethersWallet.address;

  const nonceResponse = await fetch(`${baseUrl}/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: address })
  });
  const noncePayload = await nonceResponse.json().catch(() => ({}));
  if (!nonceResponse.ok) {
    throw new Error(
      `/auth/nonce failed with ${nonceResponse.status}: ${noncePayload?.message ?? "unknown_error"}`
    );
  }

  const signature = await ethersWallet.signMessage(noncePayload.message);

  const verifyResponse = await fetch(`${baseUrl}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: noncePayload.message, signature })
  });
  const verifyPayload = await verifyResponse.json().catch(() => ({}));
  if (!verifyResponse.ok) {
    throw new Error(
      `/auth/verify failed with ${verifyResponse.status}: ${verifyPayload?.message ?? "unknown_error"}`
    );
  }

  return {
    wallet: verifyPayload.wallet ?? address,
    token: verifyPayload.token,
    expiresAt: verifyPayload.expiresAt,
    authHeader: { authorization: `Bearer ${verifyPayload.token}` }
  };
}
