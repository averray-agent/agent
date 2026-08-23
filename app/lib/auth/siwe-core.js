export async function prepareSiwe({ provider, fetcher, nonceUrl }) {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const wallet = Array.isArray(accounts) ? accounts[0] : undefined;
  if (!wallet) throw new Error("Wallet returned no accounts. Unlock the wallet and retry.");

  const response = await fetcher(nonceUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.message) throw new Error(`/auth/nonce failed (${response.status})`);
  return { provider, wallet, message: payload.message };
}

export async function completeSiwe({ prepared, fetcher, verifyUrl }) {
  const signature = await prepared.provider.request({
    method: "personal_sign",
    params: [prepared.message, prepared.wallet],
  });
  const response = await fetcher(verifyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: prepared.message, signature }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.token || !payload.expiresAt) {
    throw new Error(`/auth/verify failed (${response.status})`);
  }
  return {
    token: payload.token,
    wallet: payload.wallet ?? prepared.wallet,
    expiresAt: payload.expiresAt,
    roles: Array.isArray(payload.roles)
      ? payload.roles.filter((role) => typeof role === "string")
      : [],
  };
}
