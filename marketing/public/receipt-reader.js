(() => {
  const root = document.querySelector("[data-receipt-state]");
  const status = document.querySelector("[data-receipt-status]");
  const receiptRoot = document.querySelector("[data-receipt]");
  const guidance = document.querySelector("[data-receipt-guidance]");
  const match = window.location.pathname.match(/^\/receipts\/(0x[a-fA-F0-9]{64})\/?$/u);

  function read(value, path) {
    return path.split(".").reduce((current, key) => current?.[key], value);
  }

  function fail(message) {
    root.dataset.receiptState = "error";
    status.textContent = message;
    if (guidance) guidance.hidden = false;
  }

  function assetContextLine(receipt) {
    const context = receipt?.assetContext;
    if (!context || typeof context !== "object") return "";
    const symbol = String(context.symbol ?? "").trim();
    const chain = String(context.chain ?? "").trim();
    const chainName = String(context.chainName ?? "").trim();
    if (!symbol || !chain || !chainName) return "";
    if (chainName === "Polkadot Hub" && Number.isInteger(context.assetId)) {
      const prefix = receipt.settlement ? "Settled in" : "Settlement asset";
      return `${prefix} Hub ${symbol} · ${chainName} (${chain}) · asset ${context.assetId}`;
    }
    if (chainName === "Base") {
      const prefix = ["PASS", "FAIL"].includes(receipt.result) ? "Billed in" : "Billing asset";
      return `${prefix} Base ${symbol} (${chain})`;
    }
    return "";
  }

  if (!match) {
    const hasPathId = window.location.pathname.replace(/^\/receipts\/?/u, "").length > 0;
    fail(hasPathId ? "no receipt found for this id" : "no receipt id in the URL");
    return;
  }

  const receiptId = match[1].toLowerCase();
  const endpoint = `https://api.averray.com/receipts/${encodeURIComponent(receiptId)}`;
  const rawLink = document.querySelector("[data-receipt-raw-url]");
  if (rawLink) {
    rawLink.href = endpoint;
    rawLink.textContent = endpoint.replace(/^https:\/\//u, "");
  }

  window.AverrayReaderFetch.readJsonWithRetry(endpoint, {
    headers: { accept: "application/json" }
  }).then(async (receipt) => {
    const provider = read(receipt, "execution.provider");
    let providerClass = "unknown";
    if (/^0x[a-fA-F0-9]{40}$/u.test(String(provider ?? ""))) {
      try {
        const profile = await window.AverrayReaderFetch.readJsonWithRetry(
          `https://api.averray.com/agents/${encodeURIComponent(provider)}`,
          { headers: { accept: "application/json" } }
        );
        const classified = profile?.identity?.classification;
        if (["operator-run", "external", "unknown"].includes(classified)) {
          providerClass = classified;
        }
      } catch {
        // The immutable receipt remains readable, but its historical label is
        // not an identity authority. Unknown is the honest registry fallback.
      }
    }
    document.querySelectorAll("[data-field]").forEach((element) => {
      const value = read(receipt, element.dataset.field);
      element.textContent = value === undefined || value === null ? "—" : String(value);
    });
    const providerClassElement = document.querySelector("[data-provider-class]");
    if (providerClassElement) providerClassElement.textContent = providerClass;
    const assetContextElement = document.querySelector("[data-asset-context]");
    if (assetContextElement) {
      const line = assetContextLine(receipt);
      assetContextElement.textContent = line;
      assetContextElement.hidden = !line;
    }
    document.querySelector("[data-receipt-json]").textContent = JSON.stringify(receipt, null, 2);
    document.querySelector("[data-settlement]").hidden = !receipt.settlement;
    status.hidden = true;
    receiptRoot.hidden = false;
    root.dataset.receiptState = "ready";
  }).catch((error) => fail(error && error.status === 404 ? "no receipt found for this id" : "Receipt is temporarily unavailable."));
})();
